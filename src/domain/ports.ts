import type {
  ForgetCode,
  IssuedForgetCode,
  MealOption,
  ReservationOutcome,
  ReservedMeal,
  SamadSession,
  Self,
  User,
  UserProfile,
  WeeklyReserves,
} from './models';

/**
 * Ports — the interfaces the application layer depends on.
 *
 * Everything here is async even though the current SQLite driver is synchronous.
 * That is a deliberate trade: it costs an `await` today and buys the ability to
 * move a store to a networked database later without touching a single caller.
 */

export interface UserRepository {
  findByTelegramId(telegramId: number): Promise<User | null>;
  /** Inserts a new user, or refreshes the stored credentials of an existing one. */
  save(user: User): Promise<void>;
  deleteByTelegramId(telegramId: number): Promise<void>;
  setAutoReserveEnabled(telegramId: number, enabled: boolean): Promise<void>;
  /** Chooses which dining hall auto-reserve books at. */
  setAutoReserveSelf(telegramId: number, selfId: number): Promise<void>;
  /** Adds or removes a weekday and reports whether it is now selected. */
  toggleAutoReserveWeekday(telegramId: number, weekday: number): Promise<boolean>;
  /** Everyone with auto-reserve switched on, for the scheduled run. */
  findAllWithAutoReserveEnabled(): Promise<readonly User[]>;
  count(): Promise<number>;
}

export interface ForgetCodeRepository {
  /** Stores a newly issued code. Returns false when the same code already exists. */
  insert(forgetCode: Omit<ForgetCode, 'id' | 'claimedByTelegramId' | 'claimedAt' | 'createdAt'>): Promise<boolean>;
  /** True when any unused code already covers this exact meal. */
  hasAvailableForMeal(universityId: number, selfId: number, mealDateKey: string): Promise<boolean>;
  /**
   * Atomically takes an unused code for a meal and marks it claimed.
   *
   * Returns null when someone else got there first — the claim must be a single
   * statement so two students tapping at the same moment cannot both win.
   */
  claim(universityId: number, selfId: number, mealDateKey: string, claimedByTelegramId: number): Promise<ForgetCode | null>;
  /** Removes codes for meals that have already passed. Returns how many were deleted. */
  deleteForMealsBefore(mealDateKey: string): Promise<number>;
  countAvailable(universityId: number): Promise<number>;
}

export interface ForgetCodeReportRepository {
  insert(telegramId: number, code: string): Promise<void>;
}

/** Samad access tokens, held in process memory with a hard expiry. */
export interface SessionStore {
  get(telegramId: number): Promise<SamadSession | null>;
  set(telegramId: number, session: SamadSession, ttlMs: number): Promise<void>;
  delete(telegramId: number): Promise<void>;
  size(): number;
}

/** Encrypts and decrypts the stored Samad passwords. */
export interface SecretBox {
  encrypt(plainText: string): string;
  /** Throws when the payload was produced with a different key or is corrupt. */
  decrypt(payload: string): string;
}

/** Injectable time source, so scheduling and expiry are testable. */
export interface Clock {
  now(): Date;
}

export interface LoginInput {
  universityId: number;
  samadUsername: string;
  password: string;
}

export interface ProgramQuery {
  universityId: number;
  accessToken: string;
  selfId: number;
  /** Week to look at; omitted means the current week. */
  weekStart?: Date;
  /**
   * Minimum days ahead a meal must be to appear.
   *
   * Defaults to Samad's reservation lock. The forget-code flow passes 0, because
   * it cares about today's meal — the one a lost card would otherwise cost.
   */
  minimumDaysAhead?: number;
  /** Include meals already reserved. Defaults to false; the forget-code flow needs true. */
  includeReserved?: boolean;
}

export interface ReserveInput {
  universityId: number;
  accessToken: string;
  programId: number;
  foodTypeId: number;
}

export interface ReservesQuery {
  universityId: number;
  accessToken: string;
  /** Week to look at; omitted means the current week. */
  weekStart?: Date;
}

/**
 * Everything the bot needs from Samad.
 *
 * The gateway takes an explicit `universityId` on every call rather than reading
 * it from ambient state, because a single process serves users from all
 * universities at once and ambient state is how that gets crossed by accident.
 */
export interface SamadGateway {
  login(input: LoginInput): Promise<SamadSession>;
  listSelfs(universityId: number, accessToken: string): Promise<readonly Self[]>;
  listMealOptions(query: ProgramQuery): Promise<readonly MealOption[]>;
  listReserves(query: ReservesQuery): Promise<WeeklyReserves>;
  reserve(input: ReserveInput): Promise<ReservationOutcome>;
  fetchProfile(universityId: number, accessToken: string): Promise<UserProfile>;
  /**
   * Prints one forget code for an already-reserved meal.
   *
   * `mealDate` is passed in rather than read from the response because the
   * response's own date fields are inconsistent across deployments, and the
   * caller already knows which meal it is looking at.
   */
  issueForgetCode(
    universityId: number,
    accessToken: string,
    reserveId: number,
    mealDate: Date,
  ): Promise<IssuedForgetCode>;
}

/** Resolves a Samad access token for a user, refreshing it when needed. */
export interface TokenProvider {
  getAccessToken(telegramId: number): Promise<{ accessToken: string; universityId: number }>;
  invalidate(telegramId: number): Promise<void>;
}

/**
 * Sends a message to a user outside a request/response cycle.
 *
 * The scheduled auto-reserve run has no Telegram update to reply to, so it needs
 * a way to reach people. This port keeps that ability from dragging Telegraf's
 * context types into the application layer.
 */
export interface Notifier {
  /** `html` is already escaped and formatted for Telegram's HTML parse mode. */
  notify(telegramId: number, html: string): Promise<void>;
}

/** The slice of a reserved meal needed to describe it in a list. */
export type ReservedMealSummary = ReservedMeal;
