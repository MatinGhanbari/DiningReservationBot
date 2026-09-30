import type Redis from 'ioredis';
import type { ForgetCode } from '../../domain/models';
import type { ForgetCodeReportRepository, ForgetCodeRepository } from '../../domain/ports';
import { hashFromReply, intField, mealDateScore, nullableIntField, type RedisStore } from './store';

/**
 * Pools a printed code, or reports that this identity already pooled it.
 *
 * The set membership test and the write are one step because they have to agree:
 * a code marked as seen whose row was never written could never be pooled again,
 * which loses a donation the user meant to make. Returns 0 when the same card is
 * already in the pool for this Samad identity — the unique index the SQLite
 * schema expressed as `INSERT OR IGNORE`.
 */
const INSERT_CODE = `
if redis.call('SADD', KEYS[1], ARGV[1]) == 0 then
  return 0
end

redis.call('HSET', KEYS[2],
  'id',                   ARGV[8],
  'code',                 ARGV[1],
  'mealDateKey',          ARGV[2],
  'universityId',         ARGV[3],
  'selfId',               ARGV[4],
  'samadUsername',        ARGV[5],
  'sharedByTelegramId',   ARGV[6],
  'claimedByTelegramId',  '',
  'claimedAt',            '',
  'createdAt',            ARGV[7])

redis.call('ZADD', KEYS[3], ARGV[7], ARGV[8])
redis.call('SADD', KEYS[4], ARGV[8])
redis.call('SADD', KEYS[5], ARGV[8])
redis.call('ZADD', KEYS[6], ARGV[9], ARGV[8])
return 1
`;

/**
 * Takes the oldest unclaimed code for a meal and marks it claimed.
 *
 * One step, for the same reason the SQLite version was one statement: two
 * students can tap «دریافت کد» at the same instant, and exactly one of them may
 * win. The pop is what decides it; everything after it is housekeeping only the
 * winner performs. The stale-index guard matters because a code whose hash is
 * gone must not be handed to anyone.
 */
const CLAIM_CODE = `
local popped = redis.call('ZPOPMIN', KEYS[1])
if #popped == 0 then
  return {}
end

local id = popped[1]
local codeKey = ARGV[3] .. id

if redis.call('EXISTS', codeKey) == 0 then
  return {}
end

redis.call('HSET', codeKey, 'claimedByTelegramId', ARGV[1], 'claimedAt', ARGV[2])
redis.call('SREM', KEYS[2], id)
redis.call('SREM', KEYS[3], id)
redis.call('ZREM', KEYS[4], id)
return redis.call('HGETALL', codeKey)
`;

/** How many codes one purge pass handles before giving the connection back. */
const PURGE_BATCH = 500;

export class RedisForgetCodeRepository implements ForgetCodeRepository {
  constructor(
    private readonly store: RedisStore,
    private readonly client: Redis,
  ) {}

  async insert(forgetCode: Omit<ForgetCode, 'id' | 'claimedByTelegramId' | 'claimedAt' | 'createdAt'>): Promise<boolean> {
    const createdAt = Date.now();
    const id = await this.client.incr(this.store.forgetCodesNextId());

    const added = await this.client.eval(
      INSERT_CODE,
      6,
      this.store.forgetCodesSeen(forgetCode.universityId, forgetCode.selfId),
      this.store.forgetCode(id),
      this.store.forgetCodesForMeal(forgetCode.universityId, forgetCode.selfId, forgetCode.mealDateKey),
      this.store.forgetCodesForUniversity(forgetCode.universityId),
      this.store.forgetCodesAvailable(),
      this.store.forgetCodesByMealDate(),
      forgetCode.code,
      forgetCode.mealDateKey,
      String(forgetCode.universityId),
      String(forgetCode.selfId),
      forgetCode.samadUsername,
      String(forgetCode.sharedByTelegramId),
      String(createdAt),
      String(id),
      String(mealDateScore(forgetCode.mealDateKey)),
    );

    return Number(added) === 1;
  }

  async hasAvailableForMeal(universityId: number, selfId: number, mealDateKey: string): Promise<boolean> {
    // The meal set holds exactly the unclaimed codes, so its size is the answer.
    // The SQLite version probed an index for one row; this is a cardinality read.
    return (await this.client.zcard(this.store.forgetCodesForMeal(universityId, selfId, mealDateKey))) > 0;
  }

  async claim(universityId: number, selfId: number, mealDateKey: string, claimedByTelegramId: number): Promise<ForgetCode | null> {
    const claimedAt = Date.now();

    const reply = await this.client.eval(
      CLAIM_CODE,
      4,
      this.store.forgetCodesForMeal(universityId, selfId, mealDateKey),
      this.store.forgetCodesForUniversity(universityId),
      this.store.forgetCodesAvailable(),
      this.store.forgetCodesByMealDate(),
      String(claimedByTelegramId),
      String(claimedAt),
      this.store.forgetCodeKeyPrefix(),
    );

    const hash = hashFromReply(reply);
    return Object.keys(hash).length === 0 ? null : toForgetCode(Number(hash.id ?? 0), hash);
  }

  async deleteForMealsBefore(mealDateKey: string): Promise<number> {
    const cutoff = mealDateScore(mealDateKey);
    const ids = await this.client.zrangebyscore(this.store.forgetCodesByMealDate(), '-inf', cutoff - 1);

    if (ids.length === 0) {
      return 0;
    }

    let deleted = 0;

    for (let start = 0; start < ids.length; start += PURGE_BATCH) {
      const batch = ids.slice(start, start + PURGE_BATCH);

      const read = this.client.pipeline();
      for (const id of batch) {
        read.hgetall(this.store.forgetCode(Number(id)));
      }

      const replies = (await read.exec()) ?? [];
      const write = this.client.pipeline();

      for (const [index, entry] of replies.entries()) {
        const hash = entry?.[1] as Record<string, string> | undefined;
        const rawId = batch[index] ?? '';

        if (entry?.[0] !== null || hash === undefined || Object.keys(hash).length === 0) {
          // The hash is already gone; the date index still has to let it go.
          write.zrem(this.store.forgetCodesByMealDate(), rawId);
          continue;
        }

        const universityId = intField(hash, 'universityId');
        const selfId = intField(hash, 'selfId');

        write.del(this.store.forgetCode(Number(rawId)));
        write.zrem(this.store.forgetCodesForMeal(universityId, selfId, hash.mealDateKey ?? ''), rawId);
        write.srem(this.store.forgetCodesForUniversity(universityId), rawId);
        write.srem(this.store.forgetCodesAvailable(), rawId);
        write.srem(this.store.forgetCodesSeen(universityId, selfId), hash.code ?? '');
        write.zrem(this.store.forgetCodesByMealDate(), rawId);
        deleted += 1;
      }

      await write.exec();
    }

    return deleted;
  }

  async countAvailable(universityId: number): Promise<number> {
    return this.client.scard(this.store.forgetCodesForUniversity(universityId));
  }

  async countAllAvailable(): Promise<number> {
    return this.client.scard(this.store.forgetCodesAvailable());
  }
}

export class RedisForgetCodeReportRepository implements ForgetCodeReportRepository {
  constructor(
    private readonly store: RedisStore,
    private readonly client: Redis,
  ) {}

  async insert(telegramId: number, code: string): Promise<void> {
    const id = await this.client.incr(this.store.forgetCodeReportsNextId());

    await this.client.hset(this.store.forgetCodeReport(id), {
      telegramId: String(telegramId),
      code,
      createdAt: String(Date.now()),
    });
  }
}

function toForgetCode(id: number, hash: Record<string, string>): ForgetCode {
  const claimedAt = nullableIntField(hash, 'claimedAt');

  return {
    id,
    code: hash.code ?? '',
    mealDateKey: hash.mealDateKey ?? '',
    universityId: intField(hash, 'universityId'),
    selfId: intField(hash, 'selfId'),
    samadUsername: hash.samadUsername ?? '',
    sharedByTelegramId: intField(hash, 'sharedByTelegramId'),
    claimedByTelegramId: nullableIntField(hash, 'claimedByTelegramId'),
    claimedAt: claimedAt === null ? null : new Date(claimedAt),
    createdAt: new Date(intField(hash, 'createdAt')),
  };
}
