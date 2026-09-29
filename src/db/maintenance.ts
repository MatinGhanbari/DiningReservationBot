import { statSync } from 'node:fs';
import type { DatabaseSize, SystemProbe } from '../domain/ports';
import type { SqliteDatabase } from './database';
import { LATEST_SCHEMA_VERSION } from './migrations';

/**
 * The only shape a snapshot path may take: letters, digits, and the separators
 * and suffix we generate ourselves. Used instead of escaping, so an unexpected
 * path fails loudly rather than being quoted into a statement.
 */
const SAFE_PATH_PATTERN = /^[A-Za-z0-9._\-/\\ ]+\.db$/;

/** Size of a file in bytes, or zero when it does not exist. */
function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export class SqliteSystemProbe implements SystemProbe {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly filePath: string,
  ) {}

  async size(): Promise<DatabaseSize> {
    if (this.db.memory) {
      // An in-memory database has no file; report what it costs in pages instead.
      const pageCount = this.db.pragma('page_count', { simple: true });
      const pageSize = this.db.pragma('page_size', { simple: true });
      const bytes = typeof pageCount === 'number' && typeof pageSize === 'number' ? pageCount * pageSize : 0;

      return { databaseBytes: bytes, walBytes: 0 };
    }

    return {
      databaseBytes: sizeOf(this.filePath),
      walBytes: sizeOf(`${this.filePath}-wal`),
    };
  }

  async schemaVersion(): Promise<number> {
    const value = this.db.pragma('user_version', { simple: true });
    return typeof value === 'number' ? value : LATEST_SCHEMA_VERSION;
  }

  async snapshot(path: string): Promise<number> {
    // `VACUUM INTO` takes a literal, not a bound parameter, so this is the one
    // place in the codebase where SQL is built from a string. Escaping a quote
    // would be enough to keep it correct, but "correct" is the wrong bar for
    // something assembled into a statement: the path is required to match the
    // shape we generate ourselves, and anything else is rejected outright rather
    // than quoted into something harmless-looking.
    if (!SAFE_PATH_PATTERN.test(path) || path.includes('..') || path.includes("'") || path.includes('\u0000')) {
      throw new Error(`Refusing to write a database snapshot to an unsafe path: ${path}`);
    }

    this.db.exec(`VACUUM INTO '${path}'`);

    return sizeOf(path);
  }
}
