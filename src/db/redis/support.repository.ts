import type Redis from 'ioredis';
import type {
  SupportDirection,
  SupportEnvelope,
  SupportMessage,
  SupportTicket,
  SupportTicketStatus,
  SupportTicketSummary,
} from '../../domain/models';
import type { SupportRepository } from '../../domain/ports';
import { intField, nullableIntField, readHash, type RedisStore } from './store';

/**
 * Closes a ticket only while it is open, and drops the user's pointer to it.
 *
 * The status test and the writes are one step so two admins closing the same
 * ticket cannot both be told they closed it — the `WHERE status = 'open'` of the
 * SQLite version, which also reported whether it had matched anything.
 */
const CLOSE_TICKET = `
if redis.call('HGET', KEYS[1], 'status') ~= 'open' then
  return 0
end

redis.call('HSET', KEYS[1], 'status', 'closed', 'closedAt', ARGV[1], 'updatedAt', ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('ZADD', KEYS[3], ARGV[1], ARGV[2])
redis.call('DEL', KEYS[4])
return 1
`;

export class RedisSupportRepository implements SupportRepository {
  constructor(
    private readonly store: RedisStore,
    private readonly client: Redis,
  ) {}

  async openTicket(envelope: SupportEnvelope): Promise<{ ticket: SupportTicket; created: boolean }> {
    const now = Date.now();
    const pointer = this.store.userOpenTicket(envelope.telegramId);

    const existing = await this.findOpenTicket(envelope.telegramId);

    let ticketId: number;
    let created = false;

    if (existing !== null) {
      // A back-and-forth stays one conversation rather than a ticket per message.
      ticketId = existing.id;
    } else {
      const candidate = await this.client.incr(this.store.ticketsNextId());

      // Two messages arriving together for a user with no ticket would otherwise
      // open two. The pointer is claimed, not written, so exactly one wins.
      const claimed = await this.client.set(pointer, String(candidate), 'NX');

      if (claimed === null) {
        const winner = await this.client.get(pointer);
        ticketId = Number(winner ?? candidate);
      } else {
        ticketId = candidate;
        created = true;

        await this.client
          .multi()
          .hset(this.store.ticket(candidate), {
            id: String(candidate),
            telegramId: String(envelope.telegramId),
            status: 'open',
            createdAt: String(now),
            updatedAt: String(now),
            closedAt: '',
          })
          .zadd(this.store.ticketsOpen(), now, String(candidate))
          .exec();
      }
    }

    await this.appendMessageRow(ticketId, 'in', envelope.content, now);

    const ticket = await this.findById(ticketId);

    if (ticket === null) {
      throw new Error(`Support ticket ${ticketId} vanished immediately after insert`);
    }

    return { ticket, created };
  }

  async findOpenTicket(telegramId: number): Promise<SupportTicket | null> {
    const ticketId = await this.client.get(this.store.userOpenTicket(telegramId));

    if (ticketId === null) {
      return null;
    }

    const hash = await readHash(this.client, this.store.ticket(Number(ticketId)));

    // A pointer to a closed or deleted ticket is not an open ticket.
    return hash === null || hash.status !== 'open' ? null : toTicket(Number(ticketId), hash);
  }

  async appendMessage(ticketId: number, direction: SupportDirection, content: string): Promise<void> {
    await this.appendMessageRow(ticketId, direction, content, Date.now());
  }

  async listMessages(ticketId: number, limit: number): Promise<readonly SupportMessage[]> {
    if (limit <= 0) {
      return [];
    }

    // The list is appended to oldest-first, so the newest `limit` entries come
    // back already in the order the caller wants them.
    const ids = await this.client.lrange(this.store.ticketMessages(ticketId), -limit, -1);

    if (ids.length === 0) {
      return [];
    }

    const pipeline = this.client.pipeline();
    for (const id of ids) {
      pipeline.hgetall(this.store.supportMessage(Number(id)));
    }

    const replies = (await pipeline.exec()) ?? [];

    return replies
      .map(entry => entry?.[1] as Record<string, string> | undefined)
      .filter((hash): hash is Record<string, string> => hash !== undefined && Object.keys(hash).length > 0)
      .map(hash => ({
        id: intField(hash, 'id'),
        ticketId: intField(hash, 'ticketId'),
        direction: hash.direction === 'out' ? ('out' as const) : ('in' as const),
        content: hash.content ?? '',
        createdAt: new Date(intField(hash, 'createdAt')),
      }));
  }

  async countMessages(ticketId: number): Promise<number> {
    return this.client.llen(this.store.ticketMessages(ticketId));
  }

  async recordDelivery(ticketId: number, adminTelegramId: number, messageId: number): Promise<void> {
    // `NX`, so a delivery recorded twice does not overwrite the first mapping.
    await this.client.set(this.store.supportDelivery(adminTelegramId, messageId), String(ticketId), 'NX');
  }

  async findTicketByDelivery(adminTelegramId: number, messageId: number): Promise<SupportTicket | null> {
    const ticketId = await this.client.get(this.store.supportDelivery(adminTelegramId, messageId));

    return ticketId === null ? null : this.findById(Number(ticketId));
  }

  async findById(ticketId: number): Promise<SupportTicket | null> {
    const hash = await readHash(this.client, this.store.ticket(ticketId));
    return hash === null ? null : toTicket(ticketId, hash);
  }

  async closeTicket(ticketId: number): Promise<boolean> {
    const hash = await readHash(this.client, this.store.ticket(ticketId));

    if (hash === null) {
      return false;
    }

    const now = Date.now();

    const closed = await this.client.eval(
      CLOSE_TICKET,
      4,
      this.store.ticket(ticketId),
      this.store.ticketsOpen(),
      this.store.ticketsClosed(),
      this.store.userOpenTicket(intField(hash, 'telegramId')),
      String(now),
      String(ticketId),
    );

    return Number(closed) === 1;
  }

  async listOpen(limit: number): Promise<readonly SupportTicketSummary[]> {
    if (limit <= 0) {
      return [];
    }

    const ids = await this.client.zrevrange(this.store.ticketsOpen(), 0, limit - 1);

    if (ids.length === 0) {
      return [];
    }

    // The SQLite version answered these with correlated subqueries on the same
    // statement; here they are four commands per ticket, in one round trip.
    const read = this.client.pipeline();
    for (const id of ids) {
      read.hgetall(this.store.ticket(Number(id)));
      read.llen(this.store.ticketMessages(Number(id)));
      read.lindex(this.store.ticketMessages(Number(id)), -1);
    }

    const replies = (await read.exec()) ?? [];
    const lastMessageIds: string[] = [];

    for (let index = 0; index < ids.length; index += 1) {
      lastMessageIds.push(String((replies[index * 3 + 2]?.[1] as string | null) ?? ''));
    }

    const users = this.client.pipeline();
    const messages = this.client.pipeline();

    for (const id of ids) {
      users.hgetall(this.store.user(Number(id)));
    }

    for (const messageId of lastMessageIds) {
      messages.hget(this.store.supportMessage(Number(messageId)), 'content');
    }

    const [userReplies, messageReplies] = await Promise.all([users.exec(), messages.exec()]);
    const summaries: SupportTicketSummary[] = [];

    for (let index = 0; index < ids.length; index += 1) {
      const hash = replies[index * 3]?.[1] as Record<string, string> | undefined;

      if (hash === undefined || Object.keys(hash).length === 0) {
        continue;
      }

      const user = (userReplies ?? [])[index]?.[1] as Record<string, string> | undefined;

      summaries.push({
        ...toTicket(Number(ids[index]), hash),
        status: 'open' as SupportTicketStatus,
        displayName: displayNameOf(user?.firstName ?? null, user?.lastName ?? null),
        messageCount: Number((replies[index * 3 + 1]?.[1] as number | null) ?? 0),
        lastMessage: String((messageReplies ?? [])[index]?.[1] ?? ''),
      });
    }

    return summaries;
  }

  async countByStatus(status: 'open' | 'closed'): Promise<number> {
    return this.client.zcard(status === 'open' ? this.store.ticketsOpen() : this.store.ticketsClosed());
  }

  async countMessagesSince(since: Date): Promise<number> {
    return this.client.zcount(this.store.supportMessagesByCreatedAt(), since.getTime(), '+inf');
  }

  async lastMessageAt(): Promise<Date | null> {
    const reply = await this.client.zrevrange(this.store.supportMessagesByCreatedAt(), 0, 0, 'WITHSCORES');

    if (reply.length < 2) {
      return null;
    }

    return new Date(Number(reply[1]));
  }

  /**
   * Appends a message and touches its ticket.
   *
   * The ticket's own position in the open index only moves while it is open: a
   * closed ticket whose timestamp advanced must not reappear in the panel's list.
   */
  private async appendMessageRow(ticketId: number, direction: SupportDirection, content: string, now: number): Promise<void> {
    const messageId = await this.client.incr(this.store.supportMessagesNextId());
    const status = await this.client.hget(this.store.ticket(ticketId), 'status');

    const transaction = this.client
      .multi()
      .hset(this.store.supportMessage(messageId), {
        id: String(messageId),
        ticketId: String(ticketId),
        direction,
        content,
        createdAt: String(now),
      })
      .rpush(this.store.ticketMessages(ticketId), String(messageId))
      .zadd(this.store.supportMessagesByCreatedAt(), now, String(messageId))
      .hset(this.store.ticket(ticketId), { updatedAt: String(now) });

    if (status === 'open') {
      transaction.zadd(this.store.ticketsOpen(), now, String(ticketId));
    }

    await transaction.exec();
  }
}

function toTicket(id: number, hash: Record<string, string>): SupportTicket {
  const closedAt = nullableIntField(hash, 'closedAt');

  return {
    id,
    telegramId: intField(hash, 'telegramId'),
    status: hash.status === 'closed' ? 'closed' : 'open',
    createdAt: new Date(intField(hash, 'createdAt')),
    updatedAt: new Date(intField(hash, 'updatedAt')),
    closedAt: closedAt === null ? null : new Date(closedAt),
  };
}

/** A person who never logged in has no name on file, so the ticket says so. */
function displayNameOf(firstName: string | null, lastName: string | null): string {
  const name = [firstName, lastName]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(' ')
    .trim();
  return name.length === 0 ? 'کاربر بدون حساب' : name;
}
