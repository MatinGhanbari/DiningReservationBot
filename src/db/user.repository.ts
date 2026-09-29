import type { User } from '../domain/models';
import type { UserRepository } from '../domain/ports';
import { ConflictError } from '../shared/errors';
import type { SqliteDatabase } from './database';

interface UserRow {
  telegram_id: number;
  first_name: string;
  last_name: string | null;
  university_id: number;
  samad_username: string;
  encrypted_password: string;
  auto_reserve_enabled: number;
  auto_reserve_self_id: number | null;
  credit_reminder_sent_on: string | null;
  created_at: number;
  updated_at: number;
}

interface WeekdayRow {
  weekday: number;
}

function toUser(row: UserRow, weekdays: readonly number[]): User {
  return {
    telegramId: row.telegram_id,
    firstName: row.first_name,
    lastName: row.last_name,
    universityId: row.university_id,
    samadUsername: row.samad_username,
    encryptedPassword: row.encrypted_password,
    autoReserveEnabled: row.auto_reserve_enabled === 1,
    autoReserveSelfId: row.auto_reserve_self_id,
    autoReserveWeekdays: [...weekdays].sort((left, right) => left - right),
    creditReminderSentOn: row.credit_reminder_sent_on,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

interface UserParameters {
  telegramId: number;
  firstName: string;
  lastName: string | null;
  universityId: number;
  samadUsername: string;
  encryptedPassword: string;
  autoReserveEnabled: number;
  autoReserveSelfId: number | null;
  createdAt: number;
  updatedAt: number;
}

export class SqliteUserRepository implements UserRepository {
  private readonly statements;

  constructor(private readonly db: SqliteDatabase) {
    this.statements = {
      findById: db.prepare<[number], UserRow>('SELECT * FROM users WHERE telegram_id = ?'),
      findWeekdays: db.prepare<[number], WeekdayRow>(
        'SELECT weekday FROM user_auto_reserve_weekdays WHERE telegram_id = ? ORDER BY weekday',
      ),
      findBySamadIdentity: db.prepare<[number, string], { telegram_id: number }>(
        'SELECT telegram_id FROM users WHERE university_id = ? AND samad_username = ?',
      ),
      insert: db.prepare<UserParameters>(`
        INSERT INTO users (
          telegram_id, first_name, last_name, university_id,
          samad_username, encrypted_password, auto_reserve_enabled,
          auto_reserve_self_id, created_at, updated_at
        ) VALUES (
          @telegramId, @firstName, @lastName, @universityId,
          @samadUsername, @encryptedPassword, @autoReserveEnabled,
          @autoReserveSelfId, @createdAt, @updatedAt
        )
      `),
      update: db.prepare<UserParameters>(`
        UPDATE users SET
          first_name         = @firstName,
          last_name          = @lastName,
          university_id      = @universityId,
          samad_username     = @samadUsername,
          encrypted_password = @encryptedPassword,
          updated_at         = @updatedAt
        WHERE telegram_id = @telegramId
      `),
      delete: db.prepare<[number]>('DELETE FROM users WHERE telegram_id = ?'),
      setAutoReserveEnabled: db.prepare<[number, number, number]>(
        'UPDATE users SET auto_reserve_enabled = ?, updated_at = ? WHERE telegram_id = ?',
      ),
      setAutoReserveSelf: db.prepare<[number, number, number]>(
        'UPDATE users SET auto_reserve_self_id = ?, updated_at = ? WHERE telegram_id = ?',
      ),
      hasWeekday: db.prepare<[number, number], { present: number }>(
        'SELECT 1 AS present FROM user_auto_reserve_weekdays WHERE telegram_id = ? AND weekday = ?',
      ),
      addWeekday: db.prepare<[number, number]>('INSERT OR IGNORE INTO user_auto_reserve_weekdays (telegram_id, weekday) VALUES (?, ?)'),
      removeWeekday: db.prepare<[number, number]>('DELETE FROM user_auto_reserve_weekdays WHERE telegram_id = ? AND weekday = ?'),
      findAllEnabled: db.prepare<[], UserRow>('SELECT * FROM users WHERE auto_reserve_enabled = 1 ORDER BY telegram_id'),
      markCreditReminder: db.prepare<[string, number, number]>(
        'UPDATE users SET credit_reminder_sent_on = ?, updated_at = ? WHERE telegram_id = ?',
      ),
      list: db.prepare<[number, number], UserRow>('SELECT * FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?'),
      listAll: db.prepare<[], UserRow>('SELECT * FROM users ORDER BY telegram_id'),
      findBySamadUsername: db.prepare<[string], UserRow>('SELECT * FROM users WHERE samad_username = ? ORDER BY updated_at DESC LIMIT 1'),
      count: db.prepare<[], { total: number }>('SELECT COUNT(*) AS total FROM users'),
      countCreatedSince: db.prepare<[number], { total: number }>('SELECT COUNT(*) AS total FROM users WHERE created_at >= ?'),
    };
  }

  async findByTelegramId(telegramId: number): Promise<User | null> {
    const row = this.statements.findById.get(telegramId);
    return row === undefined ? null : this.hydrate(row);
  }

  async findBySamadUsername(samadUsername: string): Promise<User | null> {
    const row = this.statements.findBySamadUsername.get(samadUsername);
    return row === undefined ? null : this.hydrate(row);
  }

  async list(options: { limit: number; offset: number }): Promise<readonly User[]> {
    return this.statements.list.all(options.limit, options.offset).map(row => this.hydrate(row));
  }

  async listAll(): Promise<readonly User[]> {
    return this.statements.listAll.all().map(row => this.hydrate(row));
  }

  async save(user: User): Promise<void> {
    // A Samad account belongs to exactly one Telegram account. Without this check
    // the unique index would surface as a raw SQLite error mid-login, and the user
    // would see a generic failure instead of an explanation.
    const existingOwner = this.statements.findBySamadIdentity.get(user.universityId, user.samadUsername);
    if (existingOwner !== undefined && existingOwner.telegram_id !== user.telegramId) {
      throw new ConflictError(
        `Samad account ${user.samadUsername} is already linked to another Telegram account`,
        'این حساب سماد قبلاً به یک حساب تلگرام دیگر وصل شده. اگر فکر می‌کنی اشتباهی رخ داده، به پشتیبانی پیام بده.',
        { context: { universityId: user.universityId } },
      );
    }

    const parameters = {
      telegramId: user.telegramId,
      firstName: user.firstName,
      lastName: user.lastName,
      universityId: user.universityId,
      samadUsername: user.samadUsername,
      encryptedPassword: user.encryptedPassword,
      autoReserveEnabled: user.autoReserveEnabled ? 1 : 0,
      autoReserveSelfId: user.autoReserveSelfId,
      createdAt: user.createdAt.getTime(),
      updatedAt: user.updatedAt.getTime(),
    };

    // The two branches are deliberately asymmetric, and the reason is the same
    // in both: a configuration the user already set up must survive a login.
    //
    //   - On update the auto-reserve columns are left out of the statement
    //     entirely, so re-authenticating cannot reset them.
    //   - On insert there is no existing configuration to protect, so the row is
    //     written exactly as given.
    const run = this.db.transaction(() => {
      const updated = this.statements.update.run(parameters);

      if (updated.changes > 0) {
        return;
      }

      this.statements.insert.run(parameters);

      // Weekdays live in their own table, so a brand-new account carrying a
      // configuration needs those rows written too.
      for (const weekday of user.autoReserveWeekdays) {
        this.statements.addWeekday.run(user.telegramId, weekday);
      }
    });

    run();
  }

  async deleteByTelegramId(telegramId: number): Promise<void> {
    // Weekday rows disappear through ON DELETE CASCADE.
    this.statements.delete.run(telegramId);
  }

  async setAutoReserveEnabled(telegramId: number, enabled: boolean): Promise<void> {
    this.statements.setAutoReserveEnabled.run(enabled ? 1 : 0, Date.now(), telegramId);
  }

  async setAutoReserveSelf(telegramId: number, selfId: number): Promise<void> {
    this.statements.setAutoReserveSelf.run(selfId, Date.now(), telegramId);
  }

  async toggleAutoReserveWeekday(telegramId: number, weekday: number): Promise<boolean> {
    const run = this.db.transaction(() => {
      const present = this.statements.hasWeekday.get(telegramId, weekday) !== undefined;

      if (present) {
        this.statements.removeWeekday.run(telegramId, weekday);
        return false;
      }

      this.statements.addWeekday.run(telegramId, weekday);
      return true;
    });

    return run();
  }

  async findAllWithAutoReserveEnabled(): Promise<readonly User[]> {
    const rows = this.statements.findAllEnabled.all();

    return rows.map(row => {
      const weekdays = this.statements.findWeekdays.all(row.telegram_id).map(entry => entry.weekday);
      return toUser(row, weekdays);
    });
  }

  async count(): Promise<number> {
    return this.statements.count.get()?.total ?? 0;
  }

  async countCreatedSince(since: Date): Promise<number> {
    return this.statements.countCreatedSince.get(since.getTime())?.total ?? 0;
  }

  async markCreditReminderSent(telegramId: number, mealDateKey: string): Promise<void> {
    this.statements.markCreditReminder.run(mealDateKey, Date.now(), telegramId);
  }

  /** Reads the weekday rows that live outside the users table. */
  private hydrate(row: UserRow): User {
    const weekdays = this.statements.findWeekdays.all(row.telegram_id).map(entry => entry.weekday);
    return toUser(row, weekdays);
  }
}
