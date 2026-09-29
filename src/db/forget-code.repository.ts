import type { ForgetCode } from '../domain/models';
import type { ForgetCodeReportRepository, ForgetCodeRepository } from '../domain/ports';
import type { SqliteDatabase } from './database';

interface ForgetCodeRow {
  id: number;
  code: string;
  meal_date_key: string;
  university_id: number;
  self_id: number;
  samad_username: string;
  shared_by_telegram_id: number;
  claimed_by_telegram_id: number | null;
  claimed_at: number | null;
  created_at: number;
}

interface InsertParameters {
  code: string;
  mealDateKey: string;
  universityId: number;
  selfId: number;
  samadUsername: string;
  sharedByTelegramId: number;
  createdAt: number;
}

interface ClaimParameters {
  universityId: number;
  selfId: number;
  mealDateKey: string;
  claimedBy: number;
  claimedAt: number;
}

function toForgetCode(row: ForgetCodeRow): ForgetCode {
  return {
    id: row.id,
    code: row.code,
    mealDateKey: row.meal_date_key,
    universityId: row.university_id,
    selfId: row.self_id,
    samadUsername: row.samad_username,
    sharedByTelegramId: row.shared_by_telegram_id,
    claimedByTelegramId: row.claimed_by_telegram_id,
    claimedAt: row.claimed_at === null ? null : new Date(row.claimed_at),
    createdAt: new Date(row.created_at),
  };
}

export class SqliteForgetCodeRepository implements ForgetCodeRepository {
  private readonly statements;

  constructor(db: SqliteDatabase) {
    this.statements = {
      // OR IGNORE leans on the unique index on (university_id, self_id, code):
      // printing the same card twice must not put it in the pool twice.
      insert: db.prepare<InsertParameters>(`
        INSERT OR IGNORE INTO forget_codes (
          code, meal_date_key, university_id, self_id, samad_username,
          shared_by_telegram_id, claimed_by_telegram_id, claimed_at, created_at
        ) VALUES (
          @code, @mealDateKey, @universityId, @selfId, @samadUsername,
          @sharedByTelegramId, NULL, NULL, @createdAt
        )
      `),
      hasAvailable: db.prepare<[number, number, string], { present: number }>(`
        SELECT 1 AS present
        FROM forget_codes
        WHERE university_id = ? AND self_id = ? AND meal_date_key = ?
          AND claimed_by_telegram_id IS NULL
        LIMIT 1
      `),
      /**
       * Claiming is one statement on purpose.
       *
       * Two students can tap «دریافت کد» (get a code) at the same instant. A
       * pair would let both of them see the same unclaimed row; this UPDATE with
       * a LIMIT 1 subquery lets exactly one of them win, and the loser simply
       * gets no rows back.
       */
      claim: db.prepare<ClaimParameters, ForgetCodeRow>(`
        UPDATE forget_codes
        SET claimed_by_telegram_id = @claimedBy,
            claimed_at            = @claimedAt
        WHERE id = (
          SELECT id
          FROM forget_codes
          WHERE university_id = @universityId
            AND self_id       = @selfId
            AND meal_date_key = @mealDateKey
            AND claimed_by_telegram_id IS NULL
          ORDER BY created_at ASC
          LIMIT 1
        )
        RETURNING *
      `),
      deleteBefore: db.prepare<[string]>('DELETE FROM forget_codes WHERE meal_date_key < ?'),
      countAvailable: db.prepare<[number], { total: number }>(`
        SELECT COUNT(*) AS total
        FROM forget_codes
        WHERE university_id = ? AND claimed_by_telegram_id IS NULL
      `),
      countAllAvailable: db.prepare<[], { total: number }>(
        'SELECT COUNT(*) AS total FROM forget_codes WHERE claimed_by_telegram_id IS NULL',
      ),
    };
  }

  async insert(forgetCode: Omit<ForgetCode, 'id' | 'claimedByTelegramId' | 'claimedAt' | 'createdAt'>): Promise<boolean> {
    const result = this.statements.insert.run({
      code: forgetCode.code,
      mealDateKey: forgetCode.mealDateKey,
      universityId: forgetCode.universityId,
      selfId: forgetCode.selfId,
      samadUsername: forgetCode.samadUsername,
      sharedByTelegramId: forgetCode.sharedByTelegramId,
      createdAt: Date.now(),
    });

    return result.changes > 0;
  }

  async hasAvailableForMeal(universityId: number, selfId: number, mealDateKey: string): Promise<boolean> {
    return this.statements.hasAvailable.get(universityId, selfId, mealDateKey) !== undefined;
  }

  async claim(universityId: number, selfId: number, mealDateKey: string, claimedByTelegramId: number): Promise<ForgetCode | null> {
    const row = this.statements.claim.get({
      universityId,
      selfId,
      mealDateKey,
      claimedBy: claimedByTelegramId,
      claimedAt: Date.now(),
    });

    return row === undefined ? null : toForgetCode(row);
  }

  async deleteForMealsBefore(mealDateKey: string): Promise<number> {
    return this.statements.deleteBefore.run(mealDateKey).changes;
  }

  async countAvailable(universityId: number): Promise<number> {
    return this.statements.countAvailable.get(universityId)?.total ?? 0;
  }

  async countAllAvailable(): Promise<number> {
    return this.statements.countAllAvailable.get()?.total ?? 0;
  }
}

export class SqliteForgetCodeReportRepository implements ForgetCodeReportRepository {
  private readonly insertStatement;

  constructor(db: SqliteDatabase) {
    this.insertStatement = db.prepare('INSERT INTO forget_code_reports (telegram_id, code, created_at) VALUES (?, ?, ?)');
  }

  async insert(telegramId: number, code: string): Promise<void> {
    this.insertStatement.run(telegramId, code, Date.now());
  }
}
