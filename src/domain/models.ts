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
  /** Weekdays to auto-reserve on, ۰ = شنبه through ۶ = جمعه. */
  autoReserveWeekdays: readonly number[];
  createdAt: Date;
  updatedAt: Date;
}

/** The subset needed to render the «اطلاعات من» screen. */
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

/**
 * Which meal slot a reservation targets.
 *
 * Samad's `mealTypeId` is 2 for lunch across every deployment we support. It is
 * named here rather than inlined so the assumption is visible and easy to revisit.
 */
export const LUNCH_MEAL_TYPE_ID = 2;
