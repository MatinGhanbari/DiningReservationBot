import Redis from 'ioredis';
import { scopedLogger } from '../../shared/logger';

const log = scopedLogger('redis');

/**
 * Redis-backed storage.
 *
 * Redis has no schema, so the version below is not used to migrate anything —
 * it exists only because the admin panel reports a schema version and "there is
 * no schema" is a worse answer than a number. Bump it by hand when the keyspace
 * changes in a way that needs an operator to act.
 */
export const LATEST_SCHEMA_VERSION = 1;

/** Every key this application owns starts with this, so a shared Redis is safe. */
export const DEFAULT_PREFIX = 'drb:';

export interface RedisStoreOptions {
  /** `redis://[:password@]host:port[/db]`. */
  url: string;
  /**
   * Namespace for every key.
   *
   * Exists so a test can hold its own private slice of a shared server instead
   * of flushing the database out from under another test running beside it.
   */
  prefix?: string;
}

/**
 * The connection, and the only place that knows what a key is called.
 *
 * Every repository builds its keys through here rather than formatting strings
 * itself. The keyspace is otherwise invisible — there is no `CREATE TABLE` to
 * read — so keeping it in one flat, boring list is what makes it auditable.
 */
export class RedisStore {
  readonly client: Redis;
  readonly prefix: string;

  constructor(options: RedisStoreOptions) {
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
    this.client = new Redis(options.url, {
      // Fail a command after three attempts rather than hanging a Telegram
      // update behind a Redis that is never coming back.
      maxRetriesPerRequest: 3,
      // Queue commands issued while the connection is being established: at boot
      // the first health check can beat the handshake, and it should wait rather
      // than fail.
      enableOfflineQueue: true,
    });

    // A connection error must not be an unhandled `error` event, which would
    // take the process down. ioredis reconnects on its own; this only reports.
    this.client.on('error', error => log.warn({ err: error }, 'redis connection error'));
  }

  /** Closes the connection. Resolves once the socket is gone. */
  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch (error) {
      log.warn({ err: error }, 'redis did not close cleanly');
      this.client.disconnect();
    }
  }

  /** A key in this store's namespace. */
  private k(...parts: readonly (string | number)[]): string {
    return `${this.prefix}${parts.join(':')}`;
  }

  // ── users ────────────────────────────────────────────────────────────────
  //
  // `user:{id}` is a hash; every other users key is an index over it. The two
  // sorted sets are separate because the panel pages by creation date while a
  // broadcast walks by id, and neither order can be derived from the other.

  user(telegramId: number): string {
    return this.k('user', telegramId);
  }

  userWeekdays(telegramId: number): string {
    return this.k('user', telegramId, 'weekdays');
  }

  /** Every telegram id with auto-reserve switched on. */
  usersAutoReserve(): string {
    return this.k('users', 'autoReserve');
  }

  /** All users, scored by telegram id — the broadcast walk and the total count. */
  usersById(): string {
    return this.k('users', 'byId');
  }

  /** All users, scored by creation time — the panel's newest-first page. */
  usersByCreatedAt(): string {
    return this.k('users', 'byCreatedAt');
  }

  /**
   * The telegram id that owns a Samad account.
   *
   * This key is the invariant the SQLite schema expressed as a unique index: one
   * Samad account belongs to exactly one Telegram account. It is claimed with
   * `SET NX` so two simultaneous logins cannot both win.
   */
  userSamadIdentity(universityId: number, samadUsername: string): string {
    return this.k('users', 'samad', universityId, samadUsername);
  }

  /** Telegram ids that have used a Samad username, scored by last update. */
  usersBySamadUsername(samadUsername: string): string {
    return this.k('users', 'samadUsername', samadUsername);
  }

  /** The ticket an admin reply is routed back to, for one delivered message. */
  supportDelivery(adminTelegramId: number, messageId: number): string {
    return this.k('delivery', adminTelegramId, messageId);
  }

  /** The ticket a user is currently talking in, so a new message reuses it. */
  userOpenTicket(telegramId: number): string {
    return this.k('user', telegramId, 'openTicket');
  }

  // ── forget codes ─────────────────────────────────────────────────────────
  //
  // Three sets describe the same unclaimed codes at three granularities: one
  // meal, one university, and the whole pool. The meal set is what the atomic
  // claim pops from; the other two exist so the two counts the admin panel shows
  // are a `SCARD` rather than a scan.

  forgetCode(id: number): string {
    return this.k('code', id);
  }

  /**
   * The stem a code hash is built from.
   *
   * Needed by the claim script, which pops an id and only then knows which hash
   * to write — so it has to build the key itself. Exposed here rather than
   * inlined there, so the shape of a code key still lives in one place.
   */
  forgetCodeKeyPrefix(): string {
    return this.k('code', '');
  }

  forgetCodesNextId(): string {
    return this.k('codes', 'nextId');
  }

  /** Unclaimed codes for one meal, scored by creation time so the claim is FIFO. */
  forgetCodesForMeal(universityId: number, selfId: number, mealDateKey: string): string {
    return this.k('codes', 'meal', universityId, selfId, mealDateKey);
  }

  /** Unclaimed codes for a university. */
  forgetCodesForUniversity(universityId: number): string {
    return this.k('codes', 'uni', universityId);
  }

  /** Unclaimed codes everywhere. */
  forgetCodesAvailable(): string {
    return this.k('codes', 'available');
  }

  /**
   * Every code ever pooled for one Samad identity, claimed or not.
   *
   * Replaces the unique index on `(university_id, self_id, code)`: printing the
   * same card twice must not put it in the pool twice.
   */
  forgetCodesSeen(universityId: number, selfId: number): string {
    return this.k('codes', 'seen', universityId, selfId);
  }

  /** Codes scored by meal date, for the nightly purge of meals that have passed. */
  forgetCodesByMealDate(): string {
    return this.k('codes', 'byMealDate');
  }

  // ── forget code reports ──────────────────────────────────────────────────

  forgetCodeReport(id: number): string {
    return this.k('codeReport', id);
  }

  forgetCodeReportsNextId(): string {
    return this.k('codeReports', 'nextId');
  }

  // ── support ──────────────────────────────────────────────────────────────

  ticket(id: number): string {
    return this.k('ticket', id);
  }

  ticketsNextId(): string {
    return this.k('tickets', 'nextId');
  }

  /** Message ids for a ticket, oldest first. */
  ticketMessages(ticketId: number): string {
    return this.k('ticket', ticketId, 'messages');
  }

  /** Open tickets, scored by last activity — the panel's newest-first list. */
  ticketsOpen(): string {
    return this.k('tickets', 'open');
  }

  /** Closed tickets, scored by last activity. */
  ticketsClosed(): string {
    return this.k('tickets', 'closed');
  }

  supportMessage(id: number): string {
    return this.k('message', id);
  }

  supportMessagesNextId(): string {
    return this.k('messages', 'nextId');
  }

  /** Every support message, scored by creation time, for the daily counts. */
  supportMessagesByCreatedAt(): string {
    return this.k('messages', 'byCreatedAt');
  }

  // ── chatbot ──────────────────────────────────────────────────────────────

  chatMessage(id: number): string {
    return this.k('chatMsg', id);
  }

  chatMessagesNextId(): string {
    return this.k('chat', 'nextId');
  }

  /** Message ids for one user, oldest first. */
  chatTranscript(telegramId: number): string {
    return this.k('chat', telegramId);
  }

  /** Every chatbot message, scored by creation time. */
  chatMessagesByCreatedAt(): string {
    return this.k('chat', 'byCreatedAt');
  }

  /** Only the questions people asked, so the admin report does not have to filter. */
  chatQuestions(): string {
    return this.k('chat', 'userMsgs');
  }

  /**
   * How many questions one user has spent on a calendar day.
   *
   * The daily budget resets at midnight in the configured timezone, so a counter
   * per day is exact and needs no index. It carries a TTL, which is also why
   * nothing has to sweep it: a counter for a day nobody will ask about again
   * removes itself.
   */
  chatDailyUsage(telegramId: number, dayKey: string): string {
    return this.k('chat', telegramId, 'used', dayKey);
  }

  /** The users who asked something on a calendar day, for the distinct-user count. */
  chatUsersOn(dayKey: string): string {
    return this.k('chat', 'usersOn', dayKey);
  }

  /** A short-lived key used to fold several days together. */
  chatUsersScratch(): string {
    return this.k('chat', 'usersScratch');
  }

  // ── feature flags, settings, meta ────────────────────────────────────────

  feature(key: string): string {
    return this.k('feature', key);
  }

  featurePattern(): string {
    return this.k('feature', '*');
  }

  /** The stem a feature key is built from, so a scanned key can be turned back into its name. */
  featureKeyPrefix(): string {
    return this.k('feature', '');
  }

  setting(key: string): string {
    return this.k('setting', key);
  }

  schemaVersion(): string {
    return this.k('meta', 'schemaVersion');
  }
}

/**
 * A hash read that distinguishes "no such row" from "a row with no fields".
 *
 * `HGETALL` answers `{}` for a key that does not exist, which is
 * indistinguishable from an empty hash at the call site — and every reader here
 * means "not found".
 */
export async function readHash(client: Redis, key: string): Promise<Record<string, string> | null> {
  const hash = await client.hgetall(key);
  return Object.keys(hash).length === 0 ? null : hash;
}

/** Parses a hash field that should be an integer. */
export function intField(hash: Record<string, string>, field: string): number {
  return Number(hash[field] ?? 0);
}

/** Parses a hash field that should be an integer or absent. */
export function nullableIntField(hash: Record<string, string>, field: string): number | null {
  const raw = hash[field];
  return raw === undefined || raw === '' ? null : Number(raw);
}

/**
 * A meal date key as a sorted-set score.
 *
 * `YYYY-MM-DD` already sorts correctly as a string, but a sorted set scores with
 * a double, so the separators come out: 2026-09-30 becomes 20260930. The format
 * is fixed-width, which is what keeps the numeric order the same as the string's.
 */
export function mealDateScore(mealDateKey: string): number {
  return Number(mealDateKey.replace(/-/g, ''));
}

/** Turns a flat `HGETALL` reply into a hash. */
export function hashFromReply(reply: unknown): Record<string, string> {
  if (!Array.isArray(reply)) {
    return {};
  }

  const hash: Record<string, string> = {};

  for (let index = 0; index + 1 < reply.length; index += 2) {
    hash[String(reply[index])] = String(reply[index + 1]);
  }

  return hash;
}

/**
 * Every key matching a pattern.
 *
 * `SCAN` rather than `KEYS`, because `KEYS` holds the server for the whole walk
 * and this application shares its Redis with nothing but still should not be the
 * reason a command times out.
 */
export async function scanKeys(client: Redis, pattern: string, count = 500): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';

  // A bounded walk: a cursor that never returns to zero would otherwise spin
  // forever, and a hundred thousand keys is far past anything this bot holds.
  for (let step = 0; step < 100_000; step += 1) {
    const [next, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', count);
    keys.push(...batch);
    cursor = next;

    if (cursor === '0') {
      return keys;
    }
  }

  return keys;
}
