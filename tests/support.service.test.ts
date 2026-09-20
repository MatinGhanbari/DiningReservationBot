import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SupportService } from '../src/app/support.service';
import { SqliteSupportRepository } from '../src/db/support.repository';
import type { SqliteDatabase } from '../src/db/database';
import type { SupportEnvelope } from '../src/domain/models';
import type { SupportMessenger } from '../src/domain/ports';
import { createTestDatabase, expectUserMessage } from './helpers';

/**
 * Support routing is the one place where a bug means a real person's message goes
 * to the wrong place, or nowhere.
 *
 * The interesting case is the one the user cannot control: Telegram hides the
 * original sender when forwarding is restricted, so the bot keeps its own map of
 * "which message in which admin's chat belongs to which ticket". Every test below
 * goes through that map, and none of them rely on forward metadata.
 */

interface PlacedMessage {
  messageId: number;
  telegramId: number;
  html: string;
  replyToMessageId?: number;
}

interface FakeMessenger extends SupportMessenger {
  /** Every message the bot placed, in order, with the id Telegram would return. */
  placed: PlacedMessage[];
  forwarded: Array<{ target: number; source: number; messageId: number }>;
}

function createFakeMessenger(
  options: {
    forwardFails?: boolean;
    /** Telegram ids that reject delivery, standing in for a blocked bot. */
    unreachable?: readonly number[];
    adminIds?: readonly number[];
  } = {},
): FakeMessenger {
  const placed: PlacedMessage[] = [];
  const forwarded: Array<{ target: number; source: number; messageId: number }> = [];

  let nextId = 100;
  const admins = options.adminIds ?? [116969885];

  const record = (telegramId: number, html: string, replyToMessageId?: number): number => {
    nextId += 1;
    placed.push({ messageId: nextId, telegramId, html, ...(replyToMessageId === undefined ? {} : { replyToMessageId }) });
    return nextId;
  };

  return {
    placed,
    forwarded,
    async send(telegramId, html) {
      if (options.unreachable?.includes(telegramId) === true) {
        return null;
      }
      return record(telegramId, html);
    },
    async reply(telegramId, replyToMessageId, html) {
      return record(telegramId, html, replyToMessageId);
    },
    async forward(target, source, messageId) {
      forwarded.push({ target, source, messageId });

      // This is the case the whole design exists for: forwarding is refused, so
      // the bot has to fall back to text and keep the routing working anyway.
      if (options.forwardFails === true) {
        return null;
      }

      nextId += 1;
      return nextId;
    },
    async sendDocument() {
      return null;
    },
    adminIds: () => admins,
  };
}

/** The id of the last thing the bot put in one particular chat. */
function lastIdFor(messenger: FakeMessenger, telegramId: number): number {
  const last = messenger.placed.filter(message => message.telegramId === telegramId).at(-1);

  if (last === undefined) {
    throw new Error(`Nothing was sent to ${telegramId}`);
  }

  return last.messageId;
}

const envelope = (overrides: Partial<SupportEnvelope> = {}): SupportEnvelope => ({
  telegramId: 555,
  displayName: 'مهدی احمدی',
  username: 'mahdi',
  messageId: 4242,
  content: 'غذای من رزرو نشد',
  ...overrides,
});

function build(options: { messenger?: FakeMessenger; adminIds?: readonly number[] } = {}) {
  const db: SqliteDatabase = createTestDatabase();
  const tickets = new SqliteSupportRepository(db);
  const messenger = options.messenger ?? createFakeMessenger({ adminIds: options.adminIds });

  // A clock the test can move: the relay cooldown is time-based, and a test that
  // sends two messages must be able to say "some time has passed".
  let now = 1_000_000;
  const service = new SupportService(tickets, messenger, () => now);

  return { db, tickets, messenger, service, advance: (ms: number) => (now += ms) };
}

describe('SupportService', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = createTestDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it('opens one ticket and reuses it for a follow-up', async () => {
    const { service, tickets, advance } = build();

    const first = await service.deliver(envelope());
    advance(60_000);
    const second = await service.deliver(envelope({ messageId: 4243, content: 'بازهم نشد' }));

    expect(second.id).toBe(first.id);
    expect(await tickets.countMessages(first.id)).toBe(2);
  });

  it('puts the message in front of every admin', async () => {
    const { service, messenger } = build({ adminIds: [116969885, 222] });

    await service.deliver(envelope());

    expect(messenger.placed.some(message => message.telegramId === 116969885)).toBe(true);
    expect(messenger.placed.some(message => message.telegramId === 222)).toBe(true);
    expect(messenger.forwarded).toEqual([
      { target: 116969885, source: 555, messageId: 4242 },
      { target: 222, source: 555, messageId: 4242 },
    ]);
  });

  it('still routes when forwarding is refused, by falling back to text', async () => {
    // The user has forwarding disabled. The admin gets the words instead of the
    // forwarded copy, and — crucially — the reply still reaches the user.
    const messenger = createFakeMessenger({ forwardFails: true });
    const { service } = build({ messenger });

    await service.deliver(envelope());

    expect(messenger.forwarded).toHaveLength(1);
    expect(messenger.placed.some(message => message.html.includes('غذای من رزرو نشد'))).toBe(true);
  });

  it('routes an admin reply back to the user who opened the ticket', async () => {
    const messenger = createFakeMessenger({ forwardFails: true });
    const { service } = build({ messenger });

    await service.deliver(envelope());

    const outcome = await service.handleAdminReply({
      adminTelegramId: 116969885,
      replyToMessageId: lastIdFor(messenger, 116969885),
      text: 'دارم درستش می‌کنم',
    });

    expect(outcome.outcome).toBe('delivered');
    expect(outcome.ticket?.telegramId).toBe(555);
    expect(messenger.placed.some(message => message.telegramId === 555 && message.html.includes('دارم درستش می‌کنم'))).toBe(true);
  });

  it('routes a reply to the header, not only to the forwarded copy', async () => {
    const messenger = createFakeMessenger();
    const { service } = build({ messenger });

    await service.deliver(envelope());

    // The admin naturally replies to the header the bot told them to reply to.
    const headerId = messenger.placed.find(message => message.telegramId === 116969885)?.messageId as number;

    const outcome = await service.handleAdminReply({
      adminTelegramId: 116969885,
      replyToMessageId: headerId,
      text: 'جواب',
    });

    expect(outcome.outcome).toBe('delivered');
  });

  it('reports an unknown reply rather than silently dropping it', async () => {
    const { service } = build();

    const outcome = await service.handleAdminReply({
      adminTelegramId: 116969885,
      replyToMessageId: 999_999,
      text: 'سلام',
    });

    expect(outcome.outcome).toBe('unknown-ticket');
    expect(outcome.ticket).toBeNull();
  });

  it('reports when the user can no longer be reached', async () => {
    const messenger = createFakeMessenger({ unreachable: [555] });
    const { service } = build({ messenger });

    await service.deliver(envelope());

    const outcome = await service.handleAdminReply({
      adminTelegramId: 116969885,
      replyToMessageId: lastIdFor(messenger, 116969885),
      text: 'جواب',
    });

    expect(outcome.outcome).toBe('undeliverable');
  });

  it('keeps the outgoing reply in the ticket history', async () => {
    const messenger = createFakeMessenger({ forwardFails: true });
    const { service, tickets } = build({ messenger });

    const ticket = await service.deliver(envelope());

    await service.handleAdminReply({
      adminTelegramId: 116969885,
      replyToMessageId: lastIdFor(messenger, 116969885),
      text: 'جواب ادمین',
    });

    const history = await tickets.listMessages(ticket.id, 10);
    expect(history.map(message => message.direction)).toEqual(['in', 'out']);
    expect(history[1]?.content).toBe('جواب ادمین');
  });

  it('does not confuse two admins who both received the same ticket', async () => {
    const messenger = createFakeMessenger({ adminIds: [116969885, 222] });
    const { service } = build({ messenger });

    await service.deliver(envelope());

    // Either admin can answer, and the answer goes to the user either way.
    const outcome = await service.handleAdminReply({
      adminTelegramId: 222,
      replyToMessageId: lastIdFor(messenger, 222),
      text: 'من جواب می‌دم',
    });

    expect(outcome.outcome).toBe('delivered');
    expect(outcome.ticket?.telegramId).toBe(555);
  });

  it('never delivers an admin reply to another admin', async () => {
    const messenger = createFakeMessenger({ adminIds: [116969885, 222] });
    const { service } = build({ messenger });

    await service.deliver(envelope());

    await service.handleAdminReply({
      adminTelegramId: 116969885,
      replyToMessageId: lastIdFor(messenger, 116969885),
      text: 'پاسخ محرمانه',
    });

    expect(messenger.placed.some(message => message.telegramId === 222 && message.html.includes('پاسخ محرمانه'))).toBe(false);
    expect(messenger.placed.some(message => message.telegramId === 555 && message.html.includes('پاسخ محرمانه'))).toBe(true);
  });

  it('closes a ticket once and reports the second attempt', async () => {
    const { service } = build();

    const ticket = await service.deliver(envelope());

    expect(await service.closeTicket(ticket.id)).toBe(true);
    expect(await service.closeTicket(ticket.id)).toBe(false);
    expect(await service.countOpen()).toBe(0);
    expect(await service.countClosed()).toBe(1);
  });

  it('refuses a second message inside the cooldown', async () => {
    const { service, advance } = build();

    await service.deliver(envelope());
    await expectUserMessage(service.deliver(envelope({ messageId: 5 })), /صبر کن/);

    // Past the cooldown the same person can write again.
    advance(60_000);
    await expect(service.deliver(envelope({ messageId: 6 }))).resolves.toBeDefined();
  });

  it('clamps an oversized message before storing it', async () => {
    const { service, tickets } = build();

    const ticket = await service.deliver(envelope({ content: 'ا'.repeat(9_000) }));
    const history = await tickets.listMessages(ticket.id, 5);

    expect(history[0]?.content.length).toBeLessThanOrEqual(2_001);
  });

  it('lists open tickets with the counts an admin needs', async () => {
    const { service } = build();

    await service.deliver(envelope());
    const summary = await service.listOpen(10);

    expect(summary).toHaveLength(1);
    expect(summary[0]?.telegramId).toBe(555);
    expect(summary[0]?.messageCount).toBe(1);
    expect(summary[0]?.lastMessage).toContain('رزرو نشد');
    expect(summary[0]?.displayName).toBeTruthy();
  });
});
