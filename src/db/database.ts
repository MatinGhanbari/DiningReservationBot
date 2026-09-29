import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { config, isTest } from '../config/env';
import { scopedLogger } from '../shared/logger';

const log = scopedLogger('db');

export type SqliteDatabase = Database.Database;

/** In-memory databases are used by the test suite and by `DATABASE_PATH=:memory:`. */
export const IN_MEMORY_PATH = ':memory:';

export function isInMemory(db: SqliteDatabase): boolean {
  return db.memory;
}

/**
 * Applies the pragmas that make SQLite behave like an in-memory store while
 * still keeping the data on disk.
 *
 * The defaults SQLite ships with are tuned for a floppy disk and a single user:
 * a full fsync on every commit and a 2 MB page cache. For a bot that reads a
 * handful of rows per message and writes rarely, the settings below are worth
 * roughly two orders of magnitude on write latency and keep every hot page
 * resident.
 *
 * On durability: `synchronous = NORMAL` with WAL can lose the last few committed
 * transactions if the machine loses power — but not the database. That is the
 * right trade here because every transaction is a user re-saving credentials or
 * sharing a forget code, both of which the user can repeat. `FULL` would cost a
 * disk flush per message for no practical benefit.
 */
export function applyPerformancePragmas(db: SqliteDatabase): void {
  if (!db.memory) {
    // WAL is persistent in the file, but re-asserting it is harmless and keeps
    // an externally created database consistent with our expectations.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('wal_autocheckpoint = 1000');
  } else {
    db.pragma('synchronous = OFF');
  }

  // Keep the whole database mapped into the process address space. Reads then
  // touch memory instead of the page cache, which is what makes this feel like
  // an in-memory store.
  db.pragma(`mmap_size = ${config.DB_MMAP_MB * 1024 * 1024}`);

  // Negative cache_size means kibibytes rather than pages.
  db.pragma(`cache_size = -${config.DB_CACHE_MB * 1024}`);

  // Temporary tables and sort buffers stay in RAM.
  db.pragma('temp_store = MEMORY');

  db.pragma('foreign_keys = ON');

  // Wait for a competing writer instead of failing immediately with SQLITE_BUSY.
  db.pragma(`busy_timeout = ${config.DB_BUSY_TIMEOUT_MS}`);
}

export interface OpenDatabaseOptions {
  /** Overrides the configured path. Pass `:memory:` for an ephemeral database. */
  path?: string;
  /** Skips the pragmas that only make sense for a file-backed database. */
  applyPragmas?: boolean;
}

/**
 * Opens a database connection and prepares it for use.
 *
 * The parent directory is created on demand: in Docker the volume mount point
 * exists but is empty, and failing to boot because a folder is missing is a
 * needless outage.
 */
export function openDatabase(options: OpenDatabaseOptions = {}): SqliteDatabase {
  const { path = config.DATABASE_PATH, applyPragmas = true } = options;

  const target = path === IN_MEMORY_PATH ? IN_MEMORY_PATH : resolve(path);

  if (target !== IN_MEMORY_PATH) {
    mkdirSync(dirname(target), { recursive: true });
  }

  const db = new Database(target);

  if (applyPragmas) {
    applyPerformancePragmas(db);
  }

  if (!isTest) {
    log.info({ path: target === IN_MEMORY_PATH ? 'in-memory' : target }, 'database opened');
  }

  return db;
}

/**
 * Closes the connection cleanly.
 *
 * Running a WAL checkpoint first folds the write-ahead log back into the main
 * file, so a container restart does not have to replay it.
 */
export function closeDatabase(db: SqliteDatabase): void {
  try {
    if (!db.memory && db.open) {
      db.pragma('wal_checkpoint(TRUNCATE)');
    }
  } catch (error) {
    log.warn({ err: error }, 'WAL checkpoint failed during shutdown');
  }

  if (db.open) {
    db.close();
  }
}
