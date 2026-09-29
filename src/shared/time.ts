export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

/**
 * How many days ahead a program must be before it can be reserved.
 *
 * Samad locks reservations closer to the meal, and its own rule is expressed in
 * days, so the filter is kept in the same unit rather than converted to ms.
 *
 * Overridable through `RESERVABLE_DAYS_AHEAD`, because universities do not all
 * share one window.
 */
export const RESERVABLE_DAYS_AHEAD = 3;
