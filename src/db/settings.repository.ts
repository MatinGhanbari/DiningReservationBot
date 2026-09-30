import type { SettingsRepository } from '../domain/ports';
import type { SqliteDatabase } from './database';

interface ValueRow {
  value: string;
}

export class SqliteSettingsRepository implements SettingsRepository {
  private readonly statements;

  constructor(db: SqliteDatabase) {
    this.statements = {
      get: db.prepare<[string], ValueRow>('SELECT value FROM app_settings WHERE key = ?'),
      upsert: db.prepare<[string, string, number]>(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ),
      remove: db.prepare<[string]>('DELETE FROM app_settings WHERE key = ?'),
    };
  }

  async get(key: string): Promise<string | null> {
    return this.statements.get.get(key)?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.statements.upsert.run(key, value, Date.now());
  }

  async remove(key: string): Promise<void> {
    this.statements.remove.run(key);
  }
}
