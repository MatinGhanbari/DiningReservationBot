import { copy } from '../copy/fa';
import type { SupportEnvelope, SupportMessage, SupportTicket, SupportTicketSummary } from '../domain/models';
import type { SupportMessenger, SupportRepository } from '../domain/ports';
import { RateLimitedError } from '../shared/errors';
import { clampText } from '../shared/sanitize';
import { SECOND } from '../shared/time';
import { scopedLogger } from '../shared/logger';

const log = scopedLogger('support');

export type ReplyOutcome = 'delivered' | 'unknown-ticket' | 'undeliverable';

/**
 * Minimum gap between two support messages from the same person.
 *
 * One message is copied into every admin's chat, so a user who sends a hundred
 * messages has not sent a hundred messages — they have sent a hundred times the
 * number of admins, and Telegram will rate limit the bot out from under everyone
 * else. The gap is short enough that nobody writing a real question notices it.
 */
const RELAY_COOLDOWN_MS = 10 * SECOND;

/** Longest message stored against a ticket. */
const MAX_MESSAGE_CHARS = 2_000;

/** Senders tracked for the cooldown before the map is pruned. */
const MAX_TRACKED_SENDERS = 10_000;

/**
 * The human half of support.
 *
 * The interesting problem here is routing an admin's answer back to the right
 * person. Forwarding the user's message and reading the reply's forward metadata
 * does not work: Telegram hides the original sender when the user has forwarding
 * restricted, and the bot's own view of a forwarded message is not guaranteed to
 * carry the id either.
 *
 * So the mapping is kept on our side instead. Every message the bot places in an
 * admin's chat — the header and the forwarded copy — is written to
 * `support_deliveries`, and a reply is resolved by looking up the message it
 * replies to. Forwarding becomes a convenience for the admin rather than the
 * mechanism the routing depends on.
 */
export class SupportService {
  /** When each person last sent a support message, for the cooldown. */
  private readonly lastSentAt = new Map<number, number>();

  constructor(
    private readonly tickets: SupportRepository,
    private readonly messenger: SupportMessenger,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Records the user's message and puts a copy in front of every admin. */
  async deliver(envelope: SupportEnvelope): Promise<SupportTicket> {
    const now = this.clock();
    const previous = this.lastSentAt.get(envelope.telegramId);

    if (previous !== undefined && now - previous < RELAY_COOLDOWN_MS) {
      throw new RateLimitedError(
        `Support message from ${envelope.telegramId} inside the cooldown`,
        'پیامت رسید. اگه چیز دیگه‌ای هم هست، چند ثانیه صبر کن و بعد بفرست.',
        { context: { telegramId: envelope.telegramId, elapsedMs: now - previous } },
      );
    }

    this.setLastSentAt(envelope.telegramId, now);

    const safeEnvelope: SupportEnvelope = { ...envelope, content: clampText(envelope.content, MAX_MESSAGE_CHARS) };

    const { ticket, created } = await this.tickets.openTicket(safeEnvelope);

    const messageCount = await this.tickets.countMessages(ticket.id);

    const header = copy.support.adminHeader({
      ticketId: ticket.id,
      displayName: safeEnvelope.displayName,
      username: safeEnvelope.username,
      telegramId: safeEnvelope.telegramId,
      messageCount,
      isNew: created,
    });

    for (const adminId of this.messenger.adminIds()) {
      await this.deliverToAdmin(adminId, ticket, safeEnvelope, header);
    }

    log.info({ ticketId: ticket.id, telegramId: envelope.telegramId, created }, 'support message delivered');

    return ticket;
  }

  /**
   * Routes an admin's reply to the user who owns the ticket.
   *
   * Returns `unknown-ticket` when the replied-to message is not one we sent, so
   * the handler can tell the admin why nothing happened instead of failing
   * silently — which is the usual outcome when someone replies to an old message.
   */
  async handleAdminReply(input: {
    adminTelegramId: number;
    replyToMessageId: number;
    text: string;
  }): Promise<{ outcome: ReplyOutcome; ticket: SupportTicket | null }> {
    const ticket = await this.tickets.findTicketByDelivery(input.adminTelegramId, input.replyToMessageId);

    if (ticket === null) {
      return { outcome: 'unknown-ticket', ticket: null };
    }

    await this.tickets.appendMessage(ticket.id, 'out', input.text);

    const delivered = await this.messenger.send(ticket.telegramId, copy.support.adminReply(input.text));

    if (delivered === null) {
      log.warn({ ticketId: ticket.id, telegramId: ticket.telegramId }, 'support reply could not be delivered');

      return { outcome: 'undeliverable', ticket };
    }

    log.info({ ticketId: ticket.id, adminTelegramId: input.adminTelegramId }, 'support reply delivered');

    return { outcome: 'delivered', ticket };
  }

  async closeTicket(ticketId: number): Promise<boolean> {
    return this.tickets.closeTicket(ticketId);
  }

  async history(ticketId: number, limit = 20): Promise<readonly SupportMessage[]> {
    return this.tickets.listMessages(ticketId, limit);
  }

  async listOpen(limit = 10): Promise<readonly SupportTicketSummary[]> {
    return this.tickets.listOpen(limit);
  }

  async countOpen(): Promise<number> {
    return this.tickets.countByStatus('open');
  }

  async countClosed(): Promise<number> {
    return this.tickets.countByStatus('closed');
  }

  async countMessagesSince(since: Date): Promise<number> {
    return this.tickets.countMessagesSince(since);
  }

  /**
   * Records the send time and keeps the cooldown map bounded.
   *
   * The map is keyed by Telegram id, so without pruning it grows by one entry per
   * person who ever contacts support. Entries older than the cooldown are worth
   * nothing, so they are dropped whenever the map gets large.
   */
  private setLastSentAt(telegramId: number, now: number): void {
    if (this.lastSentAt.size > MAX_TRACKED_SENDERS) {
      const cutoff = now - RELAY_COOLDOWN_MS;

      for (const [id, at] of this.lastSentAt) {
        if (at < cutoff) {
          this.lastSentAt.delete(id);
        }
      }
    }

    this.lastSentAt.set(telegramId, now);
  }

  /**
   * Places one message in an admin's chat and remembers its id.
   *
   * The header always goes first and is what the admin is told to reply to. The
   * user's own message is then forwarded underneath it, so media survives; when
   * forwarding is refused, the text is repeated as a reply to the header instead
   * and the routing still works because both ids are recorded.
   */
  private async deliverToAdmin(adminTelegramId: number, ticket: SupportTicket, envelope: SupportEnvelope, header: string): Promise<void> {
    const headerId = await this.messenger.send(adminTelegramId, header);

    if (headerId !== null) {
      await this.tickets.recordDelivery(ticket.id, adminTelegramId, headerId);
    }

    const forwardedId = await this.messenger.forward(adminTelegramId, envelope.telegramId, envelope.messageId);

    if (forwardedId !== null) {
      await this.tickets.recordDelivery(ticket.id, adminTelegramId, forwardedId);
      return;
    }

    const body = copy.support.adminBody(envelope.content);

    const bodyId =
      headerId === null ? await this.messenger.send(adminTelegramId, body) : await this.messenger.reply(adminTelegramId, headerId, body);

    if (bodyId !== null) {
      await this.tickets.recordDelivery(ticket.id, adminTelegramId, bodyId);
    }
  }
}
