import { statSync, writeFileSync } from 'node:fs';
import type Redis from 'ioredis';
import type { DatabaseSize, SystemProbe } from '../../domain/ports';
import { LATEST_SCHEMA_VERSION, scanKeys, type RedisStore } from './store';

/**
 * The only shape a snapshot path may take: letters, digits, and the separators
 * and suffix we generate ourselves. A path outside this is refused rather than
 * quoted into something harmless-looking.
 */
const SAFE_PATH_PATTERN = /^[A-Za-z0-9._\-/\\ ]+\.json$/;

/** How many keys one `DUMP` pass covers before giving the connection back. */
const DUMP_BATCH = 500;

/** A field out of an `INFO` section, or zero when the section does not report it. */
function infoField(info: string, field: string): number {
  const line = info.split('\n').find(entry => entry.startsWith(`${field}:`));
  const value = line?.slice(field.length + 1).trim();
  return value === undefined ? 0 : Number(value);
}

/**
 * Reads the state of the storage layer for the admin panel.
 *
 * Redis reports itself rather than a file, so the two sizes the panel adds
 * together are the resident dataset and the append-only log beside it. The AOF
 * is the closer analogue of the SQLite WAL: it is what would have to be replayed
 * after a crash, and it is zero when persistence is configured as RDB-only.
 */
export class RedisSystemProbe implements SystemProbe {
  constructor(
    private readonly store: RedisStore,
    private readonly client: Redis,
  ) {}

  async size(): Promise<DatabaseSize> {
    const [memory, persistence] = await Promise.all([this.client.info('memory'), this.client.info('persistence')]);

    return {
      databaseBytes: infoField(memory, 'used_memory'),
      walBytes: infoField(persistence, 'aof_current_size'),
    };
  }

  async schemaVersion(): Promise<number> {
    const value = await this.client.get(this.store.schemaVersion());
    const parsed = value === null ? Number.NaN : Number(value);

    return Number.isFinite(parsed) ? parsed : LATEST_SCHEMA_VERSION;
  }

  /**
   * Writes every key to a JSON file and returns its size in bytes.
   *
   * There is no `VACUUM INTO` here: the bot runs in its own container and cannot
   * read the Redis data directory, so a copy of the file is not something it can
   * make. What it can do is walk the keyspace and dump each value, which is what
   * this is — the values are Redis' own serialised form, so the file restores
   * with `RESTORE <key> 0 <base64-decoded value>` and needs no knowledge of the
   * schema. It is slower than copying a file, which is acceptable for something
   * an admin asks for by hand.
   */
  async snapshot(path: string): Promise<number> {
    if (!SAFE_PATH_PATTERN.test(path) || path.includes('..') || path.includes('\u0000')) {
      throw new Error(`Refusing to write a database snapshot to an unsafe path: ${path}`);
    }

    const keys = await scanKeys(this.client, `${this.store.prefix}*`);
    const dump: Record<string, string> = {};

    for (let start = 0; start < keys.length; start += DUMP_BATCH) {
      const batch = keys.slice(start, start + DUMP_BATCH);
      const pipeline = this.client.pipeline();

      for (const key of batch) {
        pipeline.dump(key);
      }

      const replies = (await pipeline.exec()) ?? [];

      for (const [index, entry] of replies.entries()) {
        const value = entry?.[1] as Buffer | null | undefined;
        const key = batch[index];

        if (key === undefined || entry?.[0] !== null || value === null || value === undefined) {
          continue;
        }

        dump[key] = value.toString('base64');
      }
    }

    writeFileSync(path, JSON.stringify(dump), 'utf8');

    return sizeOf(path);
  }
}

/** Size of a file in bytes, or zero when it does not exist. */
function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
