import { expect, vi } from 'vitest';
import { RedisChatbotRepository } from '../src/db/redis/chatbot.repository';
import { RedisForgetCodeReportRepository, RedisForgetCodeRepository } from '../src/db/redis/forget-code.repository';
import { RedisFeatureRepository, RedisSettingsRepository } from '../src/db/redis/keyvalue.repository';
import { RedisStore, scanKeys } from '../src/db/redis/store';
import { RedisSupportRepository } from '../src/db/redis/support.repository';
import { RedisSystemProbe } from '../src/db/redis/system.probe';
import { RedisUserRepository } from '../src/db/redis/user.repository';
import type {
  IssuedForgetCode,
  MealOption,
  ReservationOutcome,
  ReservedMeal,
  SamadSession,
  Self,
  User,
  UserProfile,
  WeeklyReserves,
} from '../src/domain/models';
import type { SamadGateway } from '../src/domain/ports';
import { toAppError } from '../src/shared/errors';
import { FixedClock } from '../src/shared/clock';

/**
 * The instant every test freezes its clock at: 2026-09-20T06:00Z, a Sunday.
 *
 * Fake sessions are anchored to this rather than to `Date.now()`, so a test that
 * advances a `FixedClock` sees the session age exactly as much as it expects.
 * A wall-clock expiry would make "the token expires in an hour" true relative to
 * the real world and false relative to the frozen one.
 */
export const TEST_NOW_ISO = '2026-09-20T06:00:00Z';

/** An hour after {@link TEST_NOW_ISO}. */
export const TEST_SESSION_EXPIRY_ISO = '2026-09-20T07:00:00Z';

/**
 * The Redis the suite runs against.
 *
 * Overridable so a developer can point the tests at a container on a different
 * port; the default is the conventional one.
 */
function testRedisUrl(): string {
  return process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
}

let storeCounter = 0;

export interface TestStores {
  store: RedisStore;
  users: RedisUserRepository;
  forgetCodes: RedisForgetCodeRepository;
  forgetCodeReports: RedisForgetCodeReportRepository;
  support: RedisSupportRepository;
  chatbot: RedisChatbotRepository;
  features: RedisFeatureRepository;
  settings: RedisSettingsRepository;
  system: RedisSystemProbe;
  /** Removes every key this test wrote, and nothing else. */
  cleanup: () => Promise<void>;
}

/**
 * A private slice of Redis for one test.
 *
 * Each call takes its own key prefix rather than flushing the database, so two
 * test files running side by side cannot delete each other's data — which a
 * `FLUSHDB` in a `beforeEach` would do on every run. The prefix carries a random
 * component as well as a counter, because two files sharing a process would
 * otherwise both start counting at one.
 */
export function createTestStores(): TestStores {
  storeCounter += 1;

  const prefix = `drb-test:${process.pid}:${storeCounter}:${Math.random().toString(36).slice(2, 8)}:`;
  const store = new RedisStore({ url: testRedisUrl(), prefix });
  const client = store.client;

  return {
    store,
    users: new RedisUserRepository(store, client),
    forgetCodes: new RedisForgetCodeRepository(store, client),
    forgetCodeReports: new RedisForgetCodeReportRepository(store, client),
    support: new RedisSupportRepository(store, client),
    chatbot: new RedisChatbotRepository(store, client),
    features: new RedisFeatureRepository(store, client),
    settings: new RedisSettingsRepository(store, client),
    system: new RedisSystemProbe(store, client),
    cleanup: async () => {
      const keys = await scanKeys(client, `${prefix}*`);

      for (let start = 0; start < keys.length; start += 500) {
        const batch = keys.slice(start, start + 500);

        if (batch.length > 0) {
          await client.del(...batch);
        }
      }

      await store.close();
    },
  };
}

/** A clock frozen at an instant, so date-dependent logic is deterministic. */
export function fixedClock(isoInstant: string = TEST_NOW_ISO): FixedClock {
  return new FixedClock(new Date(isoInstant));
}

/**
 * A user record with sensible defaults, so a test only states what it varies.
 *
 * Shared rather than duplicated per file: the shape of `User` is a contract, and
 * a field added to it should not have to be added to four factories in four
 * places to keep the suite compiling.
 */
export function makeUser(overrides: Partial<User> = {}): User {
  return {
    telegramId: 555,
    firstName: 'مهدی',
    lastName: 'احمدی',
    universityId: 8,
    samadUsername: '99123456',
    encryptedPassword: 'v1:iv:tag:cipher',
    autoReserveEnabled: false,
    autoReserveSelfId: null,
    autoReserveWeekdays: [],
    creditReminderSentOn: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

/**
 * Asserts the Persian sentence the user actually reads.
 *
 * Errors carry two texts: a technical `message` for the log and a `userMessage`
 * for the person in the chat. `toThrow` only ever matches the former, so
 * checking that a user sees the right copy needs this instead.
 */
export async function expectUserMessage(operation: Promise<unknown>, pattern: RegExp): Promise<void> {
  const caught = await operation.then(
    () => null,
    (error: unknown) => error,
  );

  expect(caught, 'expected the operation to reject').not.toBeNull();
  expect(toAppError(caught).userMessage).toMatch(pattern);
}

export interface FakeGatewayOptions {
  session?: Partial<SamadSession>;
  selfs?: readonly Self[];
  mealOptions?: readonly MealOption[];
  reserves?: WeeklyReserves;
  profile?: Partial<UserProfile>;
  reserveOutcome?: ReservationOutcome;
  issuedForgetCode?: Partial<IssuedForgetCode>;
  loginError?: Error;
  reserveError?: Error;
}

/**
 * A stand-in for Samad that records what it was asked.
 *
 * Every outbound call is a `vi.fn`, so a test can assert on arguments as well as
 * on behaviour — which is how the "one token per user" and "no retry on reserve"
 * rules are verified without a network.
 */
export interface FakeSamadGateway extends SamadGateway {
  login: ReturnType<typeof vi.fn>;
  listSelfs: ReturnType<typeof vi.fn>;
  listMealOptions: ReturnType<typeof vi.fn>;
  listReserves: ReturnType<typeof vi.fn>;
  reserve: ReturnType<typeof vi.fn>;
  fetchProfile: ReturnType<typeof vi.fn>;
  issueForgetCode: ReturnType<typeof vi.fn>;
}

export function createFakeGateway(options: FakeGatewayOptions = {}): FakeSamadGateway {
  const session: SamadSession = {
    accessToken: 'access-token-1',
    expiresAt: new Date(TEST_SESSION_EXPIRY_ISO),
    firstName: 'مهدی',
    lastName: 'احمدی',
    samadUsername: '99123456',
    universityId: 8,
    ...options.session,
  };

  const reserves: WeeklyReserves = options.reserves ?? {
    meals: [],
    remainingCreditRial: 500_000,
    weekStart: new Date('2026-09-19T00:00:00Z'),
  };

  return {
    login: vi.fn(async () => {
      if (options.loginError !== undefined) {
        throw options.loginError;
      }
      return session;
    }),
    listSelfs: vi.fn(async () => options.selfs ?? []),
    listMealOptions: vi.fn(async () => options.mealOptions ?? []),
    listReserves: vi.fn(async () => reserves),
    reserve: vi.fn(async () => {
      if (options.reserveError !== undefined) {
        throw options.reserveError;
      }
      return options.reserveOutcome ?? { succeeded: true, message: 'رزرو با موفقیت انجام شد.' };
    }),
    fetchProfile: vi.fn(async () => ({
      firstName: 'مهدی',
      lastName: 'احمدی',
      samadUsername: '99123456',
      universityId: 8,
      creditRial: 500_000,
      ...options.profile,
    })),
    issueForgetCode: vi.fn(async () => ({
      code: 'FORGET-1',
      selfName: 'سلف مرکزی',
      foodName: 'چلوکباب',
      mealDate: new Date('2026-09-22T00:00:00Z'),
      remainingCount: 1,
      ...options.issuedForgetCode,
    })),
  } as FakeSamadGateway;
}

/** A meal option with sensible defaults, for building fixtures without repetition. */
export function mealOption(overrides: Partial<MealOption> = {}): MealOption {
  return {
    programId: 1,
    foodTypeId: 10,
    mealTypeId: 2,
    selfId: 5,
    foodName: 'چلوکباب',
    mealTypeName: 'ناهار',
    priceRial: 120_000,
    servedAt: new Date('2026-09-22T07:30:00Z'),
    weekdayName: 'سه‌شنبه',
    daysAhead: 2,
    ...overrides,
  };
}

/** A reserved meal with sensible defaults. */
export function reservedMeal(overrides: Partial<ReservedMeal> = {}): ReservedMeal {
  return {
    reserveId: 101,
    programId: 1,
    selfId: 5,
    selfName: 'سلف مرکزی',
    foodName: 'چلوکباب',
    mealTypeName: 'ناهار',
    servedAt: new Date('2026-09-22T07:30:00Z'),
    weekdayName: 'سه‌شنبه',
    transferableCount: 1,
    ...overrides,
  };
}
