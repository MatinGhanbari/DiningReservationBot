import type Redis from 'ioredis';
import type { User } from '../../domain/models';
import type { UserRepository } from '../../domain/ports';
import { ConflictError } from '../../shared/errors';
import { intField, nullableIntField, readHash, type RedisStore } from './store';

/**
 * Removes a weekday and reports whether it is gone, or adds it and reports
 * whether it is there.
 *
 * A read-then-write pair would let two taps that arrive together both observe
 * the same state and both take the same branch, which is exactly what the
 * SQLite version's transaction prevented. Redis runs this as one atomic step.
 */
const TOGGLE_WEEKDAY = `
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then
  redis.call('SREM', KEYS[1], ARGV[1])
  return 0
end
redis.call('SADD', KEYS[1], ARGV[1])
return 1
`;

interface PipelineReply {
  [0]: Error | null;
  [1]: unknown;
}

export class RedisUserRepository implements UserRepository {
  constructor(
    private readonly store: RedisStore,
    private readonly client: Redis,
  ) {}

  async findByTelegramId(telegramId: number): Promise<User | null> {
    const [user] = await this.hydrateMany([telegramId]);
    return user ?? null;
  }

  async findBySamadUsername(samadUsername: string): Promise<User | null> {
    // Several accounts can share a username across universities; the most
    // recently updated one is the account an admin means.
    const ids = await this.client.zrevrange(this.store.usersBySamadUsername(samadUsername), 0, 0);
    const [user] = await this.hydrateMany(ids.map(Number));
    return user ?? null;
  }

  async list(options: { limit: number; offset: number }): Promise<readonly User[]> {
    const stop = options.offset + options.limit - 1;

    if (options.limit <= 0 || stop < options.offset) {
      return [];
    }

    const ids = await this.client.zrevrange(this.store.usersByCreatedAt(), options.offset, stop);
    return this.hydrateMany(ids.map(Number));
  }

  async listAll(): Promise<readonly User[]> {
    const ids = await this.client.zrange(this.store.usersById(), '0', '-1');
    return this.hydrateMany(ids.map(Number));
  }

  async findAllWithAutoReserveEnabled(): Promise<readonly User[]> {
    const ids = await this.client.smembers(this.store.usersAutoReserve());
    return this.hydrateMany(ids.map(Number));
  }

  async save(user: User): Promise<void> {
    const identityKey = this.store.userSamadIdentity(user.universityId, user.samadUsername);

    // Claiming the Samad account and checking who holds it is one step, so two
    // logins racing on the same account cannot both pass the check and both
    // write. `SET NX` is the gate; the read afterwards only decides which error
    // to raise, and can never turn a conflict into a success.
    const claimed = await this.client.set(identityKey, String(user.telegramId), 'NX');

    if (claimed === null) {
      const owner = await this.client.get(identityKey);

      if (owner !== null && Number(owner) !== user.telegramId) {
        throw new ConflictError(
          `Samad account ${user.samadUsername} is already linked to another Telegram account`,
          'این حساب سماد قبلاً به یک حساب تلگرام دیگر وصل شده. اگر فکر می‌کنی اشتباهی رخ داده، به پشتیبانی پیام بده.',
          { context: { universityId: user.universityId } },
        );
      }
    }

    const existing = await readHash(this.client, this.store.user(user.telegramId));
    const updatedAt = user.updatedAt.getTime();

    if (existing === null) {
      await this.insert(user);
    } else {
      await this.update(user, existing);
    }

    // The username index is scored by update time, so it moves on every save.
    await this.client.zadd(this.store.usersBySamadUsername(user.samadUsername), updatedAt, String(user.telegramId));
  }

  async deleteByTelegramId(telegramId: number): Promise<void> {
    const existing = await readHash(this.client, this.store.user(telegramId));

    if (existing === null) {
      return;
    }

    const universityId = intField(existing, 'universityId');
    const samadUsername = existing.samadUsername ?? '';

    await this.client
      .multi()
      .del(this.store.user(telegramId))
      .del(this.store.userWeekdays(telegramId))
      .zrem(this.store.usersById(), String(telegramId))
      .zrem(this.store.usersByCreatedAt(), String(telegramId))
      .srem(this.store.usersAutoReserve(), String(telegramId))
      .zrem(this.store.usersBySamadUsername(samadUsername), String(telegramId))
      .del(this.store.userSamadIdentity(universityId, samadUsername))
      .exec();
  }

  async setAutoReserveEnabled(telegramId: number, enabled: boolean): Promise<void> {
    const transaction = this.client
      .multi()
      .hset(this.store.user(telegramId), { autoReserveEnabled: enabled ? '1' : '0', updatedAt: String(Date.now()) });

    if (enabled) {
      transaction.sadd(this.store.usersAutoReserve(), String(telegramId));
    } else {
      transaction.srem(this.store.usersAutoReserve(), String(telegramId));
    }

    await transaction.exec();
  }

  async setAutoReserveSelf(telegramId: number, selfId: number): Promise<void> {
    await this.client.hset(this.store.user(telegramId), { autoReserveSelfId: String(selfId), updatedAt: String(Date.now()) });
  }

  async toggleAutoReserveWeekday(telegramId: number, weekday: number): Promise<boolean> {
    const added = await this.client.eval(TOGGLE_WEEKDAY, 1, this.store.userWeekdays(telegramId), String(weekday));
    return Number(added) === 1;
  }

  async markCreditReminderSent(telegramId: number, mealDateKey: string): Promise<void> {
    await this.client.hset(this.store.user(telegramId), { creditReminderSentOn: mealDateKey, updatedAt: String(Date.now()) });
  }

  async count(): Promise<number> {
    return this.client.zcard(this.store.usersById());
  }

  async countCreatedSince(since: Date): Promise<number> {
    return this.client.zcount(this.store.usersByCreatedAt(), since.getTime(), '+inf');
  }

  /**
   * Writes a brand-new account exactly as given.
   *
   * The auto-reserve columns are written here and never on update, because a
   * configuration the user already set up has to survive a login. On insert
   * there is no configuration to protect.
   */
  private async insert(user: User): Promise<void> {
    const weekdays = user.autoReserveWeekdays;

    const transaction = this.client
      .multi()
      .hset(this.store.user(user.telegramId), {
        firstName: user.firstName,
        lastName: user.lastName ?? '',
        universityId: String(user.universityId),
        samadUsername: user.samadUsername,
        encryptedRefreshToken: user.encryptedRefreshToken,
        autoReserveEnabled: user.autoReserveEnabled ? '1' : '0',
        autoReserveSelfId: user.autoReserveSelfId === null ? '' : String(user.autoReserveSelfId),
        creditReminderSentOn: user.creditReminderSentOn ?? '',
        createdAt: String(user.createdAt.getTime()),
        updatedAt: String(user.updatedAt.getTime()),
      })
      .zadd(this.store.usersById(), user.telegramId, String(user.telegramId))
      .zadd(this.store.usersByCreatedAt(), user.createdAt.getTime(), String(user.telegramId));

    if (weekdays.length > 0) {
      transaction.sadd(this.store.userWeekdays(user.telegramId), ...weekdays.map(String));
    }

    if (user.autoReserveEnabled) {
      transaction.sadd(this.store.usersAutoReserve(), String(user.telegramId));
    }

    await transaction.exec();
  }

  /**
   * Refreshes the credentials of an account that already exists.
   *
   * Deliberately narrower than {@link insert}: the auto-reserve columns, the
   * weekdays and the creation date are all left untouched, so re-authenticating
   * cannot silently reset a configuration the user set up.
   */
  private async update(user: User, existing: Record<string, string>): Promise<void> {
    await this.client.hset(this.store.user(user.telegramId), {
      firstName: user.firstName,
      lastName: user.lastName ?? '',
      universityId: String(user.universityId),
      samadUsername: user.samadUsername,
      encryptedRefreshToken: user.encryptedRefreshToken,
      updatedAt: String(user.updatedAt.getTime()),
    });

    const previousUniversityId = intField(existing, 'universityId');
    const previousUsername = existing.samadUsername ?? '';

    // The account moved to a different Samad identity, so the old one has to be
    // released — otherwise it stays claimed by a user who no longer uses it.
    if (previousUsername !== user.samadUsername || previousUniversityId !== user.universityId) {
      const previousIdentityKey = this.store.userSamadIdentity(previousUniversityId, previousUsername);

      // Released only when it still points at this user: a stale read must not
      // be able to hand someone else's account to the next person who logs in.
      if ((await this.client.get(previousIdentityKey)) === String(user.telegramId)) {
        await this.client.del(previousIdentityKey);
      }

      await this.client.zrem(this.store.usersBySamadUsername(previousUsername), String(user.telegramId));
    }
  }

  /**
   * Reads the users behind a list of ids in two round trips, not two per user.
   *
   * The SQLite version issued a second query for each row's weekdays, which is
   * invisible at one row and was the single slowest thing in the storage layer
   * at a few thousand.
   */
  private async hydrateMany(ids: readonly number[]): Promise<User[]> {
    if (ids.length === 0) {
      return [];
    }

    const pipeline = this.client.pipeline();

    for (const id of ids) {
      pipeline.hgetall(this.store.user(id));
      pipeline.smembers(this.store.userWeekdays(id));
    }

    const replies = (await pipeline.exec()) ?? [];
    const users: User[] = [];

    for (const [index, id] of ids.entries()) {
      const hash = this.reply<Record<string, string>>(replies[index * 2]);
      const weekdays = this.reply<string[]>(replies[index * 2 + 1]);

      // An id in an index with no hash behind it is a stale index entry, not a
      // user: skipping it keeps one bad key from failing a whole page.
      if (hash === null || Object.keys(hash).length === 0) {
        continue;
      }

      users.push(toUser(id, hash, weekdays ?? []));
    }

    return users;
  }

  private reply<T>(entry: PipelineReply | undefined): T | null {
    if (entry === undefined || entry[0] !== null) {
      return null;
    }

    return entry[1] as T;
  }
}

function toUser(telegramId: number, hash: Record<string, string>, weekdays: readonly string[]): User {
  const lastName = hash.lastName ?? '';
  const creditReminderSentOn = hash.creditReminderSentOn ?? '';

  return {
    telegramId,
    firstName: hash.firstName ?? '',
    lastName: lastName === '' ? null : lastName,
    universityId: intField(hash, 'universityId'),
    samadUsername: hash.samadUsername ?? '',
    encryptedRefreshToken: hash.encryptedRefreshToken ?? '',
    autoReserveEnabled: hash.autoReserveEnabled === '1',
    autoReserveSelfId: nullableIntField(hash, 'autoReserveSelfId'),
    autoReserveWeekdays: weekdays.map(Number).sort((left, right) => left - right),
    creditReminderSentOn: creditReminderSentOn === '' ? null : creditReminderSentOn,
    createdAt: new Date(intField(hash, 'createdAt')),
    updatedAt: new Date(intField(hash, 'updatedAt')),
  };
}
