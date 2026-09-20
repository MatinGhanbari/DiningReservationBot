import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteUserRepository } from '../src/db/user.repository';
import type { SqliteDatabase } from '../src/db/database';
import { createTestDatabase, makeUser } from './helpers';


describe('SqliteUserRepository', () => {
  let db: SqliteDatabase;
  let users: SqliteUserRepository;

  beforeEach(() => {
    db = createTestDatabase();
    users = new SqliteUserRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('stores a user and reads it back', async () => {
    await users.save(makeUser());

    const found = await users.findByTelegramId(555);

    expect(found).not.toBeNull();
    expect(found?.samadUsername).toBe('99123456');
    expect(found?.firstName).toBe('مهدی');
    expect(await users.count()).toBe(1);
  });

  it('returns null for an unknown user', async () => {
    expect(await users.findByTelegramId(999)).toBeNull();
  });

  it('keeps auto-reserve settings when the user logs in again', async () => {
    await users.save(makeUser());
    await users.setAutoReserveSelf(555, 5);
    await users.setAutoReserveEnabled(555, true);
    await users.toggleAutoReserveWeekday(555, 2);

    // Re-login updates the credentials and must not wipe configuration.
    await users.save(makeUser({ encryptedPassword: 'v1:new:tag:cipher', firstName: 'مهدی' }));

    const found = await users.findByTelegramId(555);

    expect(found?.autoReserveEnabled).toBe(true);
    expect(found?.autoReserveSelfId).toBe(5);
    expect(found?.autoReserveWeekdays).toEqual([2]);
    expect(found?.encryptedPassword).toBe('v1:new:tag:cipher');
  });

  it('refuses to link one Samad account to a second Telegram account', async () => {
    await users.save(makeUser({ telegramId: 555 }));

    // Same university and username, different Telegram account.
    await expect(users.save(makeUser({ telegramId: 777 }))).rejects.toThrow(/already linked/i);
  });

  it('allows the same username at a different university', async () => {
    await users.save(makeUser({ telegramId: 555, universityId: 8 }));

    await expect(users.save(makeUser({ telegramId: 777, universityId: 3 }))).resolves.toBeUndefined();
  });

  it('toggles a weekday on and off and reports the new state', async () => {
    await users.save(makeUser());

    expect(await users.toggleAutoReserveWeekday(555, 3)).toBe(true);
    expect(await users.toggleAutoReserveWeekday(555, 1)).toBe(true);
    expect((await users.findByTelegramId(555))?.autoReserveWeekdays).toEqual([1, 3]);

    expect(await users.toggleAutoReserveWeekday(555, 3)).toBe(false);
    expect((await users.findByTelegramId(555))?.autoReserveWeekdays).toEqual([1]);
  });

  it('deletes the user and cascades their weekdays', async () => {
    await users.save(makeUser());
    await users.toggleAutoReserveWeekday(555, 2);

    await users.deleteByTelegramId(555);

    expect(await users.findByTelegramId(555)).toBeNull();

    const remaining = db.prepare('SELECT COUNT(*) AS total FROM user_auto_reserve_weekdays').get() as { total: number };
    expect(remaining.total).toBe(0);
  });

  it('lists only users with auto-reserve switched on', async () => {
    await users.save(makeUser({ telegramId: 1, samadUsername: 'a' }));
    await users.save(makeUser({ telegramId: 2, samadUsername: 'b' }));
    await users.setAutoReserveEnabled(2, true);
    await users.toggleAutoReserveWeekday(2, 4);

    const enabled = await users.findAllWithAutoReserveEnabled();

    expect(enabled).toHaveLength(1);
    expect(enabled[0]?.telegramId).toBe(2);
    expect(enabled[0]?.autoReserveWeekdays).toEqual([4]);
  });
});
