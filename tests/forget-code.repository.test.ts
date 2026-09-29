import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqliteDatabase } from '../src/db/database';
import { SqliteForgetCodeRepository } from '../src/db/forget-code.repository';
import { createTestDatabase } from './helpers';

const baseCode = {
  code: 'CODE-1',
  mealDateKey: '2026-09-22',
  universityId: 8,
  selfId: 5,
  samadUsername: '99123456',
  sharedByTelegramId: 100,
};

describe('SqliteForgetCodeRepository', () => {
  let db: SqliteDatabase;
  let codes: SqliteForgetCodeRepository;

  beforeEach(() => {
    db = createTestDatabase();
    codes = new SqliteForgetCodeRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('stores a code and reports that it is available', async () => {
    expect(await codes.insert(baseCode)).toBe(true);
    expect(await codes.hasAvailableForMeal(8, 5, '2026-09-22')).toBe(true);
    expect(await codes.countAvailable(8)).toBe(1);
  });

  it('refuses to pool the same code twice', async () => {
    await codes.insert(baseCode);

    // The original implementation checked for a duplicate with a missing `await`,
    // so the check was always true and every share attempt failed. The constraint
    // is now enforced by the database and the insert reports what actually happened.
    expect(await codes.insert(baseCode)).toBe(false);
    expect(await codes.countAvailable(8)).toBe(1);
  });

  it('scopes availability to the university and dining hall', async () => {
    await codes.insert(baseCode);

    expect(await codes.hasAvailableForMeal(3, 5, '2026-09-22')).toBe(false);
    expect(await codes.hasAvailableForMeal(8, 6, '2026-09-22')).toBe(false);
    expect(await codes.hasAvailableForMeal(8, 5, '2026-09-23')).toBe(false);
  });

  it('claims a code once and marks who took it', async () => {
    await codes.insert(baseCode);

    const claimed = await codes.claim(8, 5, '2026-09-22', 200);

    expect(claimed).not.toBeNull();
    expect(claimed?.code).toBe('CODE-1');
    expect(claimed?.claimedByTelegramId).toBe(200);
    expect(claimed?.claimedAt).toBeInstanceOf(Date);
    expect(await codes.countAvailable(8)).toBe(0);
  });

  it('gives a code to exactly one of two simultaneous claimants', async () => {
    await codes.insert(baseCode);

    // Both students tap at the same moment. The claim is a single UPDATE, so one
    // of them wins and the other gets nothing rather than both getting the code.
    const [first, second] = await Promise.all([codes.claim(8, 5, '2026-09-22', 200), codes.claim(8, 5, '2026-09-22', 201)]);

    const winners = [first, second].filter(result => result !== null);
    expect(winners).toHaveLength(1);
  });

  it('hands out codes oldest first', async () => {
    await codes.insert({ ...baseCode, code: 'OLD' });
    await new Promise(resolve => setTimeout(resolve, 5));
    await codes.insert({ ...baseCode, code: 'NEW' });

    const claimed = await codes.claim(8, 5, '2026-09-22', 200);
    expect(claimed?.code).toBe('OLD');
  });

  it('returns null when nothing is left for that meal', async () => {
    expect(await codes.claim(8, 5, '2026-09-22', 200)).toBeNull();
  });

  it('purges codes for meals that have already passed', async () => {
    await codes.insert({ ...baseCode, code: 'PAST', mealDateKey: '2026-09-20' });
    await codes.insert({ ...baseCode, code: 'TODAY', mealDateKey: '2026-09-22' });

    const removed = await codes.deleteForMealsBefore('2026-09-22');

    expect(removed).toBe(1);
    expect(await codes.hasAvailableForMeal(8, 5, '2026-09-22')).toBe(true);
  });

  it('keeps a claimed code out of the pool', async () => {
    await codes.insert(baseCode);
    await codes.claim(8, 5, '2026-09-22', 200);

    expect(await codes.hasAvailableForMeal(8, 5, '2026-09-22')).toBe(false);
  });
});
