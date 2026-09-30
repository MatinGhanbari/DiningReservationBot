import type Redis from 'ioredis';
import type { ChatRole } from '../../domain/models';
import type { ChatbotMessageRow, ChatbotRepository } from '../../domain/ports';
import { addDays, toMealDateKey } from '../../shared/dates';
import { DAY } from '../../shared/time';
import { intField, type RedisStore } from './store';

/** How long a per-day counter outlives its day. Long enough to be read late, short enough to vanish. */
const DAILY_KEY_TTL_SECONDS = 32 * (DAY / 1000);

/** A backstop for {@link dayKeys}, so a nonsense `since` cannot spin the loop. */
const MAX_DAYS = 400;

/** How many messages one purge pass handles before giving the connection back. */
const PURGE_BATCH = 500;

export class RedisChatbotRepository implements ChatbotRepository {
  constructor(
    private readonly store: RedisStore,
    private readonly client: Redis,
  ) {}

  async append(telegramId: number, role: ChatRole, content: string, model: string | null): Promise<void> {
    const createdAt = Date.now();
    const id = await this.client.incr(this.store.chatMessagesNextId());
    const dayKey = toMealDateKey(new Date(createdAt));

    const transaction = this.client
      .multi()
      .hset(this.store.chatMessage(id), {
        id: String(id),
        telegramId: String(telegramId),
        role,
        content,
        model: model ?? '',
        createdAt: String(createdAt),
      })
      .rpush(this.store.chatTranscript(telegramId), String(id))
      .zadd(this.store.chatMessagesByCreatedAt(), createdAt, String(id))
      .sadd(this.store.chatUsersOn(dayKey), String(telegramId));

    if (role === 'user') {
      transaction.zadd(this.store.chatQuestions(), createdAt, String(id));
      transaction.incr(this.store.chatDailyUsage(telegramId, dayKey));
    }

    await transaction.exec();

    // The day keys clean themselves up, which is also why nothing sweeps them.
    await this.client
      .multi()
      .expire(this.store.chatUsersOn(dayKey), DAILY_KEY_TTL_SECONDS)
      .expire(this.store.chatDailyUsage(telegramId, dayKey), DAILY_KEY_TTL_SECONDS)
      .exec();
  }

  async historyForUser(telegramId: number, limit: number): Promise<readonly { role: ChatRole; content: string }[]> {
    if (limit <= 0) {
      return [];
    }

    // Oldest first, which is what the transcript list already is.
    const ids = await this.client.lrange(this.store.chatTranscript(telegramId), -limit, -1);

    if (ids.length === 0) {
      return [];
    }

    const pipeline = this.client.pipeline();
    for (const id of ids) {
      pipeline.hgetall(this.store.chatMessage(Number(id)));
    }

    const replies = (await pipeline.exec()) ?? [];

    return replies
      .map(entry => entry?.[1] as Record<string, string> | undefined)
      .filter((hash): hash is Record<string, string> => hash !== undefined && Object.keys(hash).length > 0)
      .map(hash => ({
        role: hash.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: hash.content ?? '',
      }));
  }

  async countForUserSince(telegramId: number, since: Date): Promise<number> {
    // The budget resets at midnight, so a counter per day answers this exactly.
    // Summing from `since` forward is what keeps a caller that asks for a longer
    // window correct rather than merely plausible.
    const keys = this.dayKeys(since).map(dayKey => this.store.chatDailyUsage(telegramId, dayKey));
    const values = await this.client.mget(keys);

    return values.reduce<number>((total, value) => total + (value === null ? 0 : Number(value)), 0);
  }

  async countSince(since: Date): Promise<number> {
    return this.client.zcount(this.store.chatMessagesByCreatedAt(), since.getTime(), '+inf');
  }

  async countUsersSince(since: Date): Promise<number> {
    const keys = this.dayKeys(since).map(dayKey => this.store.chatUsersOn(dayKey));

    if (keys.length === 0) {
      return 0;
    }

    if (keys.length === 1) {
      const [onlyDay] = keys;
      return onlyDay === undefined ? 0 : this.client.scard(onlyDay);
    }

    // Distinct users across several days: one user who asked on three days is
    // one user, so the sets have to be folded rather than their sizes added.
    const scratch = this.store.chatUsersScratch();
    await this.client.sunionstore(scratch, keys);
    await this.client.expire(scratch, 60);

    const total = await this.client.scard(scratch);
    await this.client.del(scratch);

    return total;
  }

  async recentQuestions(limit: number): Promise<readonly ChatbotMessageRow[]> {
    if (limit <= 0) {
      return [];
    }

    const ids = await this.client.zrevrange(this.store.chatQuestions(), 0, limit - 1);

    return this.readMessages(ids);
  }

  async purgeBefore(cutoff: Date): Promise<number> {
    // Strictly before the cutoff, matching the `created_at < ?` this replaces.
    const ids = await this.client.zrangebyscore(this.store.chatMessagesByCreatedAt(), '-inf', cutoff.getTime() - 1);

    if (ids.length === 0) {
      return 0;
    }

    let purged = 0;

    for (let start = 0; start < ids.length; start += PURGE_BATCH) {
      const batch = ids.slice(start, start + PURGE_BATCH);

      const read = this.client.pipeline();
      for (const id of batch) {
        read.hgetall(this.store.chatMessage(Number(id)));
      }

      const replies = (await read.exec()) ?? [];
      const write = this.client.pipeline();

      for (const [index, entry] of replies.entries()) {
        const hash = entry?.[1] as Record<string, string> | undefined;
        const rawId = batch[index] ?? '';

        if (entry?.[0] !== null || hash === undefined || Object.keys(hash).length === 0) {
          // The hash is already gone; the indexes still have to let it go.
          write.zrem(this.store.chatMessagesByCreatedAt(), rawId);
          write.zrem(this.store.chatQuestions(), rawId);
          continue;
        }

        write.del(this.store.chatMessage(Number(rawId)));
        write.lrem(this.store.chatTranscript(intField(hash, 'telegramId')), 0, rawId);
        write.zrem(this.store.chatMessagesByCreatedAt(), rawId);
        write.zrem(this.store.chatQuestions(), rawId);
        purged += 1;
      }

      await write.exec();
    }

    return purged;
  }

  private async readMessages(ids: readonly string[]): Promise<readonly ChatbotMessageRow[]> {
    if (ids.length === 0) {
      return [];
    }

    const pipeline = this.client.pipeline();
    for (const id of ids) {
      pipeline.hgetall(this.store.chatMessage(Number(id)));
    }

    const replies = (await pipeline.exec()) ?? [];

    return replies
      .map(entry => entry?.[1] as Record<string, string> | undefined)
      .filter((hash): hash is Record<string, string> => hash !== undefined && Object.keys(hash).length > 0)
      .map(hash => ({
        telegramId: intField(hash, 'telegramId'),
        role: hash.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: hash.content ?? '',
        createdAt: new Date(intField(hash, 'createdAt')),
      }));
  }

  /** The calendar days from `since` through today, in the configured timezone. */
  private dayKeys(since: Date): string[] {
    const now = Date.now();
    const keys: string[] = [];

    let cursor = since;

    for (let day = 0; day < MAX_DAYS; day += 1) {
      if (cursor.getTime() > now) {
        break;
      }

      const key = toMealDateKey(cursor);

      if (keys[keys.length - 1] !== key) {
        keys.push(key);
      }

      cursor = addDays(cursor, 1);
    }

    // A `since` in the future still has to name one day to read.
    if (keys.length === 0) {
      keys.push(toMealDateKey(since));
    }

    return keys;
  }
}
