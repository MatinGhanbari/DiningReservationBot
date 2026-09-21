import type { FeatureKey, FeatureState } from '../domain/features';
import type { FeatureRepository } from '../domain/ports';
import type { SqliteDatabase } from './database';

interface FlagRow {
  key: string;
  enabled: number;
}

export class SqliteFeatureRepository implements FeatureRepository {
  private readonly statements;

  constructor(db: SqliteDatabase) {
    this.statements = {
      all: db.prepare<[], FlagRow>('SELECT key, enabled FROM feature_flags'),
      upsert: db.prepare<[string, number, number]>(
        `INSERT INTO feature_flags (key, enabled, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
      ),
    };
  }

  async all(): Promise<readonly FeatureState[]> {
    return this.statements.all.all().map(row => ({ key: row.key as FeatureKey, enabled: row.enabled === 1 }));
  }

  async set(key: FeatureKey, enabled: boolean): Promise<void> {
    this.statements.upsert.run(key, enabled ? 1 : 0, Date.now());
  }
}
