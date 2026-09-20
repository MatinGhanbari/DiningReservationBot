import type { SqliteDatabase } from './database';
import { isTest } from '../config/env';
import { scopedLogger } from '../shared/logger';

const log = scopedLogger('migrate');

interface Migration {
  version: number;
  name: string;
  up: (db: SqliteDatabase) => void;
}

/**
 * Schema migrations, applied in order and tracked with SQLite's `user_version`.
 *
 * `user_version` is used rather than a bookkeeping table because it is a single
 * integer stored in the database header: reading it costs nothing and it cannot
 * get out of sync with the schema it describes.
 *
 * Rules for adding one: append a new entry, never edit a released one, and never
 * reuse a version number.
 */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up: db => {
      db.exec(`
        CREATE TABLE users (
          telegram_id           INTEGER PRIMARY KEY,
          first_name            TEXT    NOT NULL,
          last_name             TEXT,
          university_id         INTEGER NOT NULL,
          samad_username        TEXT    NOT NULL,
          encrypted_password    TEXT    NOT NULL,
          auto_reserve_enabled  INTEGER NOT NULL DEFAULT 0,
          auto_reserve_self_id  INTEGER,
          created_at            INTEGER NOT NULL,
          updated_at            INTEGER NOT NULL
        );

        -- One Samad account maps to exactly one Telegram account.
        CREATE UNIQUE INDEX users_samad_identity
          ON users (university_id, samad_username);

        -- Partial index: the scheduled run only ever asks for the enabled rows,
        -- and that is a tiny fraction of the table.
        CREATE INDEX users_auto_reserve_enabled
          ON users (auto_reserve_enabled)
          WHERE auto_reserve_enabled = 1;

        -- Weekdays live in their own table so toggling one is a single atomic
        -- statement instead of a read-modify-write on a delimited string.
        CREATE TABLE user_auto_reserve_weekdays (
          telegram_id INTEGER NOT NULL REFERENCES users (telegram_id) ON DELETE CASCADE,
          weekday     INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
          PRIMARY KEY (telegram_id, weekday)
        );

        CREATE TABLE forget_codes (
          id                      INTEGER PRIMARY KEY AUTOINCREMENT,
          code                    TEXT    NOT NULL,
          meal_date_key           TEXT    NOT NULL,
          university_id           INTEGER NOT NULL,
          self_id                 INTEGER NOT NULL,
          samad_username          TEXT    NOT NULL,
          shared_by_telegram_id   INTEGER NOT NULL,
          claimed_by_telegram_id  INTEGER,
          claimed_at              INTEGER,
          created_at              INTEGER NOT NULL
        );

        -- The same printed code must not enter the pool twice.
        CREATE UNIQUE INDEX forget_codes_unique_code
          ON forget_codes (university_id, self_id, code);

        -- Drives both "is there anything for this meal?" and the atomic claim.
        CREATE INDEX forget_codes_available
          ON forget_codes (university_id, self_id, meal_date_key, claimed_by_telegram_id);

        CREATE TABLE forget_code_reports (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          telegram_id INTEGER NOT NULL,
          code        TEXT    NOT NULL,
          created_at  INTEGER NOT NULL
        );

        CREATE INDEX forget_code_reports_recent
          ON forget_code_reports (created_at DESC);
      `);
    },
  },
  {
    version: 2,
    name: 'support-chatbot-and-credit-reminders',
    up: db => {
      db.exec(`
        -- Date-only key of the last low-credit reminder, so a user is reminded
        -- once a day rather than on every pass.
        ALTER TABLE users ADD COLUMN credit_reminder_sent_on TEXT;

        CREATE TABLE support_tickets (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          telegram_id INTEGER NOT NULL,
          status      TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL,
          closed_at   INTEGER
        );

        CREATE INDEX support_tickets_open ON support_tickets (status, updated_at DESC);
        CREATE INDEX support_tickets_user ON support_tickets (telegram_id, updated_at DESC);

        CREATE TABLE support_messages (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          ticket_id  INTEGER NOT NULL REFERENCES support_tickets (id) ON DELETE CASCADE,
          direction  TEXT    NOT NULL CHECK (direction IN ('in', 'out')),
          content    TEXT    NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX support_messages_ticket ON support_messages (ticket_id, created_at);

        -- Maps a message in an admin's chat back to its ticket. This is what
        -- makes a reply routable without relying on Telegram's forward metadata,
        -- which disappears when the user has forwarding restricted.
        CREATE TABLE support_deliveries (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          ticket_id         INTEGER NOT NULL REFERENCES support_tickets (id) ON DELETE CASCADE,
          admin_telegram_id INTEGER NOT NULL,
          message_id        INTEGER NOT NULL,
          created_at        INTEGER NOT NULL
        );

        CREATE UNIQUE INDEX support_deliveries_lookup
          ON support_deliveries (admin_telegram_id, message_id);

        -- Every chatbot exchange, kept so admins can report on what people ask.
        CREATE TABLE chatbot_messages (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          telegram_id INTEGER NOT NULL,
          role        TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
          content     TEXT    NOT NULL,
          model       TEXT,
          created_at  INTEGER NOT NULL
        );

        CREATE INDEX chatbot_messages_user ON chatbot_messages (telegram_id, created_at DESC);
        CREATE INDEX chatbot_messages_recent ON chatbot_messages (created_at DESC);
      `);
    },
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0);

function readSchemaVersion(db: SqliteDatabase): number {
  const value = db.pragma('user_version', { simple: true });
  return typeof value === 'number' ? value : 0;
}

/**
 * Brings the database up to the latest schema version.
 *
 * Each migration runs inside its own transaction together with the version bump,
 * so a failure halfway through leaves the database on the previous version
 * rather than in a state that is neither one thing nor the other.
 */
export function migrate(db: SqliteDatabase): number {
  const startingVersion = readSchemaVersion(db);

  const pending = MIGRATIONS.filter(migration => migration.version > startingVersion).sort((left, right) => left.version - right.version);

  if (pending.length === 0) {
    if (!isTest) {
      log.debug({ version: startingVersion }, 'schema already up to date');
    }
    return startingVersion;
  }

  for (const migration of pending) {
    const apply = db.transaction(() => {
      migration.up(db);
      // Interpolated rather than bound: PRAGMA does not accept parameters, and
      // the value is a literal from the migration table above, never user input.
      db.pragma(`user_version = ${migration.version}`);
    });

    apply();

    if (!isTest) {
      log.info({ version: migration.version, name: migration.name }, 'migration applied');
    }
  }

  return readSchemaVersion(db);
}
