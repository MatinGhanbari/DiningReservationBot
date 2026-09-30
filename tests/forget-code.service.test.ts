import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ForgetCodeService } from '../src/app/forget-code.service';
import { ReservationService } from '../src/app/reservation.service';
import { SessionService } from '../src/app/session.service';
import { MemorySessionStore } from '../src/cache/session.store';
import { AesSecretBox } from '../src/crypto/secret-box';
import type { User } from '../src/domain/models';
import { NotFoundError, UpstreamRejectedError } from '../src/shared/errors';
import { FixedClock } from '../src/shared/clock';
import {
  type TestStores,
  createFakeGateway,
  expectUserMessage,
  fixedClock,
  makeUser,
  mealOption,
  reservedMeal,
  createTestStores,
} from './helpers';

const KEY = 'a-test-key-that-is-definitely-long-enough-for-the-required-minimum-length';

/** The shared factory stores a placeholder cipher; these tests need a real one. */
const withRefreshToken = (overrides: Partial<User> = {}): User =>
  makeUser({ encryptedRefreshToken: new AesSecretBox(KEY).encrypt('refresh-token-1'), ...overrides });

/** 2026-09-20 is a Sunday; in Tehran that is 2026-09-20 as well. */
const NOW = '2026-09-20T06:00:00Z';

describe('ForgetCodeService', () => {
  let stores: TestStores;
  let users: TestStores['users'];
  let codes: TestStores['forgetCodes'];
  let reports: TestStores['forgetCodeReports'];
  let clock: FixedClock;

  beforeEach(() => {
    stores = createTestStores();
    users = stores.users;
    codes = stores.forgetCodes;
    reports = stores.forgetCodeReports;
    clock = fixedClock(NOW);
  });

  afterEach(async () => {
    await stores.cleanup();
  });

  function build(overrides: Parameters<typeof createFakeGateway>[0] = {}) {
    const gateway = createFakeGateway(overrides);
    const secretBox = new AesSecretBox(KEY);
    const sessionService = new SessionService(users, new MemorySessionStore(clock), gateway, secretBox, clock);
    const reservations = new ReservationService(users, gateway, sessionService, clock);
    const forgetCodes = new ForgetCodeService(codes, reports, users, reservations, gateway, sessionService, clock);

    return { gateway, reservations, forgetCodes };
  }

  describe('share', () => {
    it('prints a code and adds it to the pool', async () => {
      const { forgetCodes, gateway } = build();
      await users.save(withRefreshToken());
      gateway.listReserves.mockResolvedValue({ meals: [reservedMeal()], remainingCreditRial: 0, weekStart: new Date() });

      const outcome = await forgetCodes.share(555, 101);

      expect(outcome.kind).toBe('shared');
      expect(await codes.countAvailable(8)).toBe(1);
    });

    it('reports a duplicate instead of failing', async () => {
      const { forgetCodes, gateway } = build();
      await users.save(withRefreshToken());
      gateway.listReserves.mockResolvedValue({ meals: [reservedMeal()], remainingCreditRial: 0, weekStart: new Date() });

      await forgetCodes.share(555, 101);
      const second = await forgetCodes.share(555, 101);

      // The original implementation threw "this code is already used" here for
      // every attempt, including the first one, because the duplicate check was
      // missing an `await` and a pending Promise is always truthy.
      expect(second.kind).toBe('already-shared');
      expect(await codes.countAvailable(8)).toBe(1);
    });

    it('refuses a meal that has no transfers left', async () => {
      const { forgetCodes, gateway } = build({ issuedForgetCode: { remainingCount: 0 } });
      await users.save(withRefreshToken());
      gateway.listReserves.mockResolvedValue({ meals: [reservedMeal()], remainingCreditRial: 0, weekStart: new Date() });

      await expect(forgetCodes.share(555, 101)).rejects.toBeInstanceOf(UpstreamRejectedError);
    });

    it("asks the user's own university for the code", async () => {
      const { forgetCodes, gateway } = build();
      await users.save(withRefreshToken({ universityId: 3 }));
      gateway.listReserves.mockResolvedValue({ meals: [reservedMeal()], remainingCreditRial: 0, weekStart: new Date() });

      await forgetCodes.share(555, 101);

      // The original code always called the KNTU host, so students elsewhere got
      // codes belonging to a different university's database.
      expect(gateway.issueForgetCode).toHaveBeenCalledWith(3, expect.anything(), 101, expect.any(Date));
    });

    it('rejects an unknown user', async () => {
      const { forgetCodes } = build();

      await expect(forgetCodes.share(999, 101)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('claimTodaysCode', () => {
    async function seedPool() {
      await codes.insert({
        code: 'POOLED-CODE',
        mealDateKey: '2026-09-20',
        universityId: 8,
        selfId: 5,
        samadUsername: '99123456',
        sharedByTelegramId: 100,
      });
    }

    it('hands over a code for today at the chosen hall', async () => {
      const { forgetCodes, gateway } = build({
        mealOptions: [mealOption({ servedAt: new Date('2026-09-20T07:30:00Z'), daysAhead: 0, selfId: 5 })],
      });

      await users.save(withRefreshToken());
      await seedPool();

      const claimed = await forgetCodes.claimTodaysCode(555, 5);

      expect(claimed.code).toBe('POOLED-CODE');
      expect(claimed.claimedByTelegramId).toBe(555);
      expect(gateway.listMealOptions).toHaveBeenCalled();
    });

    it('explains that a code is useless when there is no meal today', async () => {
      const { forgetCodes } = build({ mealOptions: [] });

      await users.save(withRefreshToken());
      await seedPool();

      // Handing over a code the person cannot spend would look like help and be
      // worthless, so the bot checks first.
      await expectUserMessage(forgetCodes.claimTodaysCode(555, 5), /غذایی نداری/);
    });

    it('says the pool is empty rather than failing silently', async () => {
      const { forgetCodes } = build({
        mealOptions: [mealOption({ servedAt: new Date('2026-09-20T07:30:00Z'), daysAhead: 0, selfId: 5 })],
      });

      await users.save(withRefreshToken());

      await expectUserMessage(forgetCodes.claimTodaysCode(555, 5), /کد آزادی/);
    });

    it('rejects an unknown user', async () => {
      const { forgetCodes } = build();

      await expect(forgetCodes.claimTodaysCode(999, 5)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('reportBadCode', () => {
    it('records a report for an admin to follow up', async () => {
      const { forgetCodes } = build();

      await forgetCodes.reportBadCode(555, '  BROKEN-1  ');

      // The id counter starts at one for a fresh key prefix.
      const report = await stores.store.client.hgetall(stores.store.forgetCodeReport(1));

      expect(report.code).toBe('BROKEN-1');
      expect(report.telegramId).toBe('555');
    });

    it('rejects an empty report', async () => {
      const { forgetCodes } = build();

      await expect(forgetCodes.reportBadCode(555, '   ')).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('purgeExpired', () => {
    it('removes codes whose meal has passed but keeps today', async () => {
      const { forgetCodes } = build();

      await codes.insert({
        code: 'YESTERDAY',
        mealDateKey: '2026-09-19',
        universityId: 8,
        selfId: 5,
        samadUsername: 'u',
        sharedByTelegramId: 100,
      });
      await codes.insert({
        code: 'TODAY',
        mealDateKey: '2026-09-20',
        universityId: 8,
        selfId: 5,
        samadUsername: 'u',
        sharedByTelegramId: 100,
      });

      expect(await forgetCodes.purgeExpired()).toBe(1);
      expect(await codes.countAvailable(8)).toBe(1);
    });
  });
});
