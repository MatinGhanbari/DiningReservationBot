import type {
  ChatRole,
  ChatTurn,
  ForgetCode,
  IssuedForgetCode,
  MealOption,
  ReservationOutcome,
  ReservedMeal,
  SamadSession,
  Self,
  SupportDirection,
  SupportEnvelope,
  SupportMessage,
  SupportTicket,
  SupportTicketSummary,
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
  /** Records that a low-credit reminder was delivered on this meal date. */
  markCreditReminderSent(telegramId: number, mealDateKey: string): Promise<void>;
  /** A page of users, newest first, for the admin panel. */
  list(options: { limit: number; offset: number }): Promise<readonly User[]>;
  /** Everyone, for a broadcast. Callers must page; this is not bounded. */
  listAll(): Promise<readonly User[]>;
  findBySamadUsername(samadUsername: string): Promise<User | null>;
  count(): Promise<number>;
  countCreatedSince(since: Date): Promise<number>;
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
  /** Unclaimed codes across every university, for the admin overview. */
  countAllAvailable(): Promise<number>;
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
  /** Drops expired entries and reports how many went. */
  sweep(): number;
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

/** Support conversations, and the mapping that routes an admin's reply back. */
export interface SupportRepository {
  /**
   * Opens a ticket and records the first message in one transaction.
   *
   * Reuses the user's open ticket when there is one, so a back-and-forth stays a
   * single conversation rather than a new ticket per message.
   */
  openTicket(envelope: SupportEnvelope): Promise<{ ticket: SupportTicket; created: boolean }>;
  findOpenTicket(telegramId: number): Promise<SupportTicket | null>;
  appendMessage(ticketId: number, direction: SupportDirection, content: string): Promise<void>;
  listMessages(ticketId: number, limit: number): Promise<readonly SupportMessage[]>;
  countMessages(ticketId: number): Promise<number>;
  /** Remembers which message in an admin's chat belongs to which ticket. */
  recordDelivery(ticketId: number, adminTelegramId: number, messageId: number): Promise<void>;
  /** Resolves a reply from an admin back to its ticket, or null if unknown. */
  findTicketByDelivery(adminTelegramId: number, messageId: number): Promise<SupportTicket | null>;
  findById(ticketId: number): Promise<SupportTicket | null>;
  closeTicket(ticketId: number): Promise<boolean>;
  listOpen(limit: number): Promise<readonly SupportTicketSummary[]>;
  countByStatus(status: 'open' | 'closed'): Promise<number>;
  countMessagesSince(since: Date): Promise<number>;
  lastMessageAt(): Promise<Date | null>;
}

/** Every chatbot exchange, so admins can report on what people actually ask. */
export interface ChatbotRepository {
  append(telegramId: number, role: ChatRole, content: string, model: string | null): Promise<void>;
  /** The most recent turns for one user, oldest first, ready to send to the model. */
  historyForUser(telegramId: number, limit: number): Promise<readonly ChatTurn[]>;
  countForUserSince(telegramId: number, since: Date): Promise<number>;
  countSince(since: Date): Promise<number>;
  countUsersSince(since: Date): Promise<number>;
  recent(limit: number): Promise<readonly ChatbotMessageRow[]>;
  /** The questions people asked, most recent first, for the admin report. */
  recentQuestions(limit: number): Promise<readonly ChatbotMessageRow[]>;
  purgeBefore(cutoff: Date): Promise<number>;
}

export interface ChatbotMessageRow {
  telegramId: number;
  role: ChatRole;
  content: string;
  createdAt: Date;
}

/** The language model behind the support chatbot. */
export interface AssistantGateway {
  /** Returns the assistant's Persian answer. Throws when the upstream is unusable. */
  answer(input: { question: string; history: readonly ChatTurn[] }): Promise<string>;
}

/**
 * Sends messages outside a request/response cycle, and can address an arbitrary
 * chat so support replies can be routed.
 *
 * Every method returns the id of the message it created, or null when delivery
 * failed — a user who blocked the bot is an expected outcome, not an error.
 */
export interface SupportMessenger {
  send(telegramId: number, html: string): Promise<number | null>;
  /** Forwards a user's own message into another chat, preserving media. */
  forward(targetTelegramId: number, sourceTelegramId: number, messageId: number): Promise<number | null>;
  reply(telegramId: number, replyToMessageId: number, html: string): Promise<number | null>;
  /** Sends a file from disk; used to hand a database backup to an admin. */
  sendDocument(telegramId: number, filePath: string, caption: string): Promise<number | null>;
  /** The admins who receive support traffic. */
  adminIds(): readonly number[];
}

/** Runs a synchronous read against the database, for the readiness probe. */
export interface HealthProbe {
  check(): Promise<void>;
}

export interface DatabaseSize {
  databaseBytes: number;
  walBytes: number;
}

/** Introspection the admin panel and the health endpoint report on. */
export interface SystemProbe {
  size(): Promise<DatabaseSize>;
  schemaVersion(): Promise<number>;
  /** Writes a consistent copy of the database and returns its size in bytes. */
  snapshot(path: string): Promise<number>;
}

export interface DatabaseSize {
  databaseBytes: number;
  /** The write-ahead log, which can be larger than the database between checkpoints. */
  walBytes: number;
}

/**
 * Reads the state of the storage layer for the admin panel.
 *
 * Separate from `HealthProbe` because the two answer different questions: the
 * probe asks whether the process can serve traffic, this asks how much room the
 * data takes and whether the schema is where it should be.
 */
export interface SystemProbe {
  size(): Promise<DatabaseSize>;
  schemaVersion(): Promise<number>;
  /** Writes a consistent copy to `path` and returns its size in bytes. */
  snapshot(path: string): Promise<number>;
}
