import { expect, vi } from 'vitest';
import type { SqliteDatabase } from '../src/db/database';
import { openDatabase } from '../src/db/database';
import { migrate } from '../src/db/migrations';
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

/** A migrated in-memory database. Each call gets its own, so tests cannot leak into each other. */
export function createTestDatabase(): SqliteDatabase {
  const db = openDatabase({ path: ':memory:' });
  migrate(db);
  return db;
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
