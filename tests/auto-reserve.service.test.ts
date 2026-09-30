import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoReserveService } from '../src/app/auto-reserve.service';
import { ReservationService } from '../src/app/reservation.service';
import { SessionService } from '../src/app/session.service';
import { MemorySessionStore } from '../src/cache/session.store';
import { AesSecretBox } from '../src/crypto/secret-box';
import type { Notifier } from '../src/domain/ports';
import type { User } from '../src/domain/models';
import { SessionExpiredError } from '../src/shared/errors';
import { FixedClock } from '../src/shared/clock';
import { type TestStores, createFakeGateway, fixedClock, makeUser, mealOption, createTestStores } from './helpers';

const KEY = 'a-test-key-that-is-definitely-long-enough-for-the-required-minimum-length';

/** Auto-reserve only ever runs for someone who has switched it on. */
const autoReserveUser = (overrides: Partial<User> = {}): User =>
  makeUser({
    encryptedRefreshToken: new AesSecretBox(KEY).encrypt('refresh-token-1'),
    autoReserveEnabled: true,
    autoReserveSelfId: 5,
    autoReserveWeekdays: [3],
    ...overrides,
  });

/** 2026-09-20 is a Sunday, which is weekday 1 in the Iranian week. */
const NOW = '2026-09-20T06:00:00Z';

/** Tuesday 2026-09-22 — weekday 3. */
const TUESDAY = new Date('2026-09-22T07:30:00Z');

function createFakeNotifier(): Notifier & { notify: ReturnType<typeof vi.fn> } {
  return { notify: vi.fn(async () => undefined) };
}

describe('AutoReserveService', () => {
  let stores: TestStores;
  let users: TestStores['users'];
  let clock: FixedClock;

  beforeEach(() => {
    stores = createTestStores();
    users = stores.users;
    clock = fixedClock(NOW);
  });

  afterEach(async () => {
    await stores.cleanup();
  });

  function build(options: Parameters<typeof createFakeGateway>[0] = {}) {
    // Typed as the fake, not the port, so a test can still reach the underlying
    // `vi.fn` and make a single call blow up.
    const gateway = createFakeGateway(options);
    const secretBox = new AesSecretBox(KEY);
    const sessionService = new SessionService(users, new MemorySessionStore(clock), gateway, secretBox, clock);
    const reservations = new ReservationService(users, gateway, sessionService, clock);
    const notifier = createFakeNotifier();
    const autoReserve = new AutoReserveService(users, reservations, notifier, clock);

    return { gateway, reservations, notifier, autoReserve };
  }

  describe('settings', () => {
    it('refuses to enable before a dining hall is chosen', async () => {
      const { autoReserve } = build();
      await users.save(autoReserveUser({ autoReserveSelfId: null }));

      // Enabling without a hall would silently do nothing, which is worse than
      // saying what is missing.
      await expect(autoReserve.setEnabled(555, true)).rejects.toThrow('AUTO_RESERVE_SELF_REQUIRED');
    });

    it('enables once a hall is set', async () => {
      const { autoReserve } = build();
      await users.save(autoReserveUser({ autoReserveEnabled: false }));

      await autoReserve.setEnabled(555, true);

      expect((await autoReserve.getSettings(555)).enabled).toBe(true);
    });

    it('toggles a weekday and reports the new state', async () => {
      const { autoReserve } = build();
      await users.save(autoReserveUser({ autoReserveWeekdays: [] }));

      expect(await autoReserve.toggleWeekday(555, 1)).toBe(true);
      expect((await autoReserve.getSettings(555)).weekdays).toEqual([1]);
      expect(await autoReserve.toggleWeekday(555, 1)).toBe(false);
    });
  });

  describe('runForUser', () => {
    it('skips a user with no dining hall configured', async () => {
      const { autoReserve, gateway } = build();
      const user = autoReserveUser({ autoReserveSelfId: null });

      const result = await autoReserve.runForUser(user);

      expect(result.skipped).toBe(true);
      expect(gateway.listMealOptions).not.toHaveBeenCalled();
    });

    it('skips a user with no weekdays selected', async () => {
      const { autoReserve } = build();

      expect((await autoReserve.runForUser(autoReserveUser({ autoReserveWeekdays: [] }))).skipped).toBe(true);
    });

    it('reserves meals that fall on a selected weekday', async () => {
      const { autoReserve, gateway, notifier } = build({
        mealOptions: [mealOption({ programId: 1, servedAt: TUESDAY, daysAhead: 2 })],
      });
      await users.save(autoReserveUser());

      const result = await autoReserve.runForUser(autoReserveUser());

      expect(result.reserved).toBe(1);
      expect(gateway.reserve).toHaveBeenCalledTimes(1);
      expect(notifier.notify).toHaveBeenCalledTimes(1);
    });

    it('ignores meals on weekdays the user did not choose', async () => {
      // Wednesday 2026-09-23 is weekday 4; the user only wants 3.
      const { autoReserve, gateway } = build({
        mealOptions: [mealOption({ programId: 1, servedAt: new Date('2026-09-23T07:30:00Z') })],
      });
      await users.save(autoReserveUser());

      const result = await autoReserve.runForUser(autoReserveUser());

      expect(result.reserved).toBe(0);
      expect(gateway.reserve).not.toHaveBeenCalled();
    });

    it('does not notify when there was nothing to do', async () => {
      const { autoReserve, notifier } = build({ mealOptions: [] });
      await users.save(autoReserveUser());

      await autoReserve.runForUser(autoReserveUser());

      // A daily "nothing happened" message would train people to ignore the bot.
      expect(notifier.notify).not.toHaveBeenCalled();
    });

    it('keeps going after one meal fails and reports the failure', async () => {
      const gateway = createFakeGateway({
        mealOptions: [mealOption({ programId: 1, servedAt: TUESDAY }), mealOption({ programId: 2, servedAt: TUESDAY, foodName: 'قیمه' })],
        reserveOutcome: { succeeded: false, message: 'موجودی کافی نیست.' },
      });

      const secretBox = new AesSecretBox(KEY);
      const sessionService = new SessionService(users, new MemorySessionStore(clock), gateway, secretBox, clock);
      const reservations = new ReservationService(users, gateway, sessionService, clock);
      const notifier = createFakeNotifier();
      const autoReserve = new AutoReserveService(users, reservations, notifier, clock);

      await users.save(autoReserveUser());

      const result = await autoReserve.runForUser(autoReserveUser());

      expect(result.failed).toBe(2);
      expect(gateway.reserve).toHaveBeenCalledTimes(2);
      expect(notifier.notify).toHaveBeenCalledTimes(1);
    });

    it('stops early when the session is dead instead of hammering Samad', async () => {
      const gateway = createFakeGateway({
        mealOptions: [
          mealOption({ programId: 1, servedAt: TUESDAY }),
          mealOption({ programId: 2, servedAt: TUESDAY, foodName: 'قیمه' }),
          mealOption({ programId: 3, servedAt: TUESDAY, foodName: 'کوکو' }),
        ],
      });
      gateway.reserve.mockRejectedValue(new SessionExpiredError());

      const secretBox = new AesSecretBox(KEY);
      const sessionService = new SessionService(users, new MemorySessionStore(clock), gateway, secretBox, clock);
      const reservations = new ReservationService(users, gateway, sessionService, clock);
      const autoReserve = new AutoReserveService(users, reservations, createFakeNotifier(), clock);

      await users.save(autoReserveUser());

      await autoReserve.runForUser(autoReserveUser());

      // Three meals were bookable and one failed, so the run has to stop rather
      // than repeat the same dead-session error three times.
      //
      // The count is 2, not 1: `withToken` spends one extra attempt trying to
      // recover from a token Samad revoked early, and that recovery is worth the
      // single repeat. What matters is that the third candidate is never tried.
      expect(gateway.reserve).toHaveBeenCalledTimes(2);
    });
  });

  describe('runDaily', () => {
    it('summarises the run across users', async () => {
      const { autoReserve } = build({
        mealOptions: [mealOption({ programId: 1, servedAt: TUESDAY })],
      });

      await users.save(autoReserveUser({ telegramId: 1, samadUsername: 'a' }));
      await users.save(autoReserveUser({ telegramId: 2, samadUsername: 'b' }));

      const summary = await autoReserve.runDaily();

      expect(summary.usersConsidered).toBe(2);
      expect(summary.reservedCount).toBe(2);
      expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('does not let one failing user stop the others', async () => {
      const { autoReserve, gateway } = build({
        mealOptions: [mealOption({ programId: 1, servedAt: TUESDAY })],
      });

      await users.save(autoReserveUser({ telegramId: 1, samadUsername: 'a' }));
      await users.save(autoReserveUser({ telegramId: 2, samadUsername: 'b' }));

      // The first user's token resolution blows up.
      gateway.listSelfs.mockRejectedValueOnce(new Error('boom'));

      const summary = await autoReserve.runDaily();

      expect(summary.usersConsidered).toBe(2);
      expect(gateway.reserve).toHaveBeenCalledTimes(2);
    });

    it('never overlaps itself, so no meal is reserved twice', async () => {
      const gateway = createFakeGateway({
        mealOptions: [mealOption({ programId: 1, servedAt: TUESDAY })],
      });

      // Slow Samad down so the two runs genuinely overlap.
      gateway.reserve.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 30));
        return { succeeded: true, message: 'ok' };
      });

      const secretBox = new AesSecretBox(KEY);
      const sessionService = new SessionService(users, new MemorySessionStore(clock), gateway, secretBox, clock);
      const reservations = new ReservationService(users, gateway, sessionService, clock);
      const autoReserve = new AutoReserveService(users, reservations, createFakeNotifier(), clock);

      await users.save(autoReserveUser());

      // Two concurrent runs would both see "not reserved yet" and book twice,
      // which costs the user real money. The second tick is dropped, not queued.
      const [first, second] = await Promise.all([autoReserve.runDaily(), autoReserve.runDaily()]);

      expect(gateway.reserve).toHaveBeenCalledTimes(1);
      expect(first?.skipped).toBe(false);
      expect(second?.skipped).toBe(true);
    });
  });
});
