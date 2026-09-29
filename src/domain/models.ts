/**
 * Domain models.
 *
 * These types are the contract between the layers. They deliberately contain no
 * persistence annotations and no HTTP shapes: the database schema and the Samad
 * payloads both map onto these, which is what lets either side change without
 * the other noticing.
 */

/** A user who has connected their Samad account to the bot. */
export interface User {
  telegramId: number;
  /** Display name from Samad, used in greetings. */
  firstName: string;
  lastName: string | null;
  universityId: number;
  samadUsername: string;
  /**
   * Password encrypted with an authenticated cipher.
   *
   * It has to be recoverable, not hashed: the bot replays it to Samad whenever
   * the access token expires. The bot's own copy is what makes re-login invisible
   * to the user, and the trade-off is documented in the README.
   */
  encryptedPassword: string;
  autoReserveEnabled: boolean;
  /**
   * Which dining hall auto-reserve books at.
   *
   * Required before auto-reserve can run. Without it the bot would have to guess,
   * and guessing across several halls means several meals reserved and charged on
   * the same day — a mistake the user pays for.
   */
  autoReserveSelfId: number | null;
  /** Weekdays to auto-reserve on, 0 = Saturday through 6 = Friday. */
  autoReserveWeekdays: readonly number[];
  /** Date-only key of the last low-credit reminder, or null if never reminded. */
  creditReminderSentOn: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The subset needed to render the «اطلاعات من» (my details) screen. */
export interface UserProfile {
  firstName: string;
  lastName: string | null;
  samadUsername: string;
  universityId: number;
  creditRial: number;
}

/** A dining hall. */
export interface Self {
  id: number;
  name: string;
}

/** One orderable meal: a program, the food chosen within it, and when it is served. */
export interface MealOption {
  programId: number;
  foodTypeId: number;
  /**
   * The meal slot Samad reported for this program — lunch, dinner, and so on.
   *
   * It has to be carried through to the reserve call: the endpoint echoes it back,
   * so a hard-coded value books the wrong slot or is rejected outright.
   */
  mealTypeId: number;
  selfId: number;
  foodName: string;
  mealTypeName: string;
  priceRial: number;
  servedAt: Date;
  /** Persian weekday name as reported by Samad, already normalised. */
  weekdayName: string;
  /** Whole days between today and the meal. Used to hide meals Samad still locks. */
  daysAhead: number;
}

/** A meal the user has already reserved. */
export interface ReservedMeal {
  reserveId: number;
  programId: number;
  selfId: number;
  selfName: string;
  foodName: string;
  mealTypeName: string;
  servedAt: Date;
  weekdayName: string;
  /** How many times this meal may still be transferred to another student. */
  transferableCount: number;
}

/** A week's worth of reservations, plus the credit left on the account. */
export interface WeeklyReserves {
  meals: readonly ReservedMeal[];
  remainingCreditRial: number;
  weekStart: Date;
}

/**
 * A forget code shared by a student, so someone who lost their card can still eat.
 *
 * Codes are single-use by design: the student who shares one gives up that meal,
 * and the pool would be worthless if the same code could be claimed twice.
 */
export interface ForgetCode {
  id: number;
  code: string;
  /** Date-only key (`YYYY-MM-DD`) of the meal this code unlocks. */
  mealDateKey: string;
  universityId: number;
  selfId: number;
  samadUsername: string;
  sharedByTelegramId: number;
  claimedByTelegramId: number | null;
  claimedAt: Date | null;
  createdAt: Date;
}

/** A freshly issued forget code, returned by Samad before it is pooled. */
export interface IssuedForgetCode {
  code: string;
  selfName: string;
  foodName: string;
  mealDate: Date;
  /** How many more times the same card may be printed. Zero means unusable. */
  remainingCount: number;
}

/** A report from a student that a shared forget code did not work. */
export interface ForgetCodeReport {
  id: number;
  telegramId: number;
  code: string;
  createdAt: Date;
}

/** What Samad says after a reservation attempt. */
export interface ReservationOutcome {
  succeeded: boolean;
  /** Samad's own Persian explanation, shown to the user as-is when present. */
  message: string;
}

/** Samad's answer to a login attempt. */
export interface SamadSession {
  accessToken: string;
  expiresAt: Date;
  firstName: string;
  lastName: string | null;
  samadUsername: string;
  universityId: number;
}

export type SupportTicketStatus = 'open' | 'closed';
export type SupportDirection = 'in' | 'out';

/** A support conversation between one user and the admins. */
export interface SupportTicket {
  id: number;
  telegramId: number;
  status: SupportTicketStatus;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
}

/** A ticket with the counts and preview an admin list needs. */
export interface SupportTicketSummary extends SupportTicket {
  /** The user's name as recorded in the bot, or a placeholder when unknown. */
  displayName: string;
  messageCount: number;
  lastMessage: string;
}

export interface SupportMessage {
  id: number;
  ticketId: number;
  direction: SupportDirection;
  content: string;
  createdAt: Date;
}

export type ChatRole = 'user' | 'assistant';

/** One stored chatbot exchange. */
export interface ChatbotMessage {
  id: number;
  telegramId: number;
  role: ChatRole;
  content: string;
  model: string | null;
  createdAt: Date;
}

/** A single turn handed to the language model. */
export interface ChatTurn {
  role: ChatRole;
  content: string;
}

/** A message the bot forwards to admins on a user's behalf. */
export interface SupportEnvelope {
  telegramId: number;
  displayName: string;
  username: string | null;
  /** Telegram's id for the message, used to forward it verbatim. */
  messageId: number;
  /** Text or caption; a placeholder for media, which has no text of its own. */
  content: string;
}
