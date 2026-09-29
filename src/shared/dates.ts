import { config } from '../config/env';
import { DAY, WEEK } from './time';

/**
 * `en-CA` is used purely because its short date format is already `YYYY-MM-DD`,
 * which sorts lexicographically and reads unambiguously in the database.
 */
const dateKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: config.TZ,
});

/**
 * A calendar date, not an instant: `YYYY-MM-DD` in the configured timezone.
 *
 * Forget codes are matched to the meal they unlock by calendar day. Storing the
 * instant instead — as the original code did with `toISOString()` — breaks
 * whenever the server timezone and the user's timezone disagree, which is
 * guaranteed for a bot running in UTC and serving Tehran.
 */
export function toMealDateKey(date: Date): string {
  return dateKeyFormatter.format(date);
}

/** Today's calendar date in the configured timezone. */
export function todayKey(now: Date = new Date()): string {
  return toMealDateKey(now);
}

const wallClockFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: config.TZ,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/**
 * How far the configured timezone is ahead of UTC at a given instant.
 *
 * Derived from `Intl` rather than hard-coded, because the offset is a property of
 * the zone (and of its daylight-saving rules) rather than of this application.
 */
function timezoneOffsetMs(instant: Date): number {
  const parts = wallClockFormatter.formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find(part => part.type === type)?.value ?? '0');

  const asIfUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    // `hour12: false` can render midnight as 24 in some engines.
    value('hour') % 24,
    value('minute'),
    value('second'),
  );

  return asIfUtc - instant.getTime();
}

/**
 * The instant midnight started for a `YYYY-MM-DD` key, in the configured
 * timezone.
 *
 * Every calendar day in this module is a day in `config.TZ`, never in the
 * process's own zone. That distinction matters because the container's `TZ` is a
 * deployment detail: a process running in UTC and a user living in Tehran
 * disagree about which day it is for three and a half hours of every day, and a
 * day computed in the wrong one is wrong in a way nobody notices until a meal
 * shows up on the wrong date.
 */
function configuredMidnightForKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);

  if (year === undefined || month === undefined || day === undefined) {
    return new Date(Number.NaN);
  }

  const utcMidnight = Date.UTC(year, month - 1, day);
  return new Date(utcMidnight - timezoneOffsetMs(new Date(utcMidnight)));
}

/**
 * The instant midnight started, in the configured timezone.
 *
 * Used for anything that resets on a calendar day — the chatbot's daily
 * allowance and the once-a-day credit reminder. A rolling 24-hour window would be
 * simpler but reads as a bug to the user, who expects their budget to come back
 * at the start of the day.
 */
export function startOfConfiguredDay(now: Date = new Date()): Date {
  return configuredMidnightForKey(toMealDateKey(now));
}

/**
 * Shifts a `YYYY-MM-DD` key by whole days.
 *
 * The arithmetic happens on the key rather than on an instant, so adding a day
 * can never be swallowed by a daylight-saving transition or land back on the day
 * it started from.
 */
function shiftDayKey(key: string, days: number): string {
  const [year, month, day] = key.split('-').map(Number);

  if (year === undefined || month === undefined || day === undefined || !Number.isFinite(days)) {
    return key;
  }

  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** The weekday of a `YYYY-MM-DD` key, where 0 is Sunday as in `Date#getDay`. */
function weekdayOfDayKey(key: string): number {
  const [year, month, day] = key.split('-').map(Number);

  if (year === undefined || month === undefined || day === undefined) {
    return Number.NaN;
  }

  // Anchored at noon so no offset can push the answer onto a neighbouring day.
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
}

/** Parses a `YYYY-MM-DD` key into a Date at local midnight. */
export function fromMealDateKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return new Date(Number.NaN);
  }
  return new Date(year, month - 1, day);
}

/** True when both instants fall on the same calendar day in the configured timezone. */
export function isSameMealDay(left: Date, right: Date): boolean {
  return toMealDateKey(left) === toMealDateKey(right);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY);
}

export function addWeeks(date: Date, weeks: number): Date {
  return new Date(date.getTime() + weeks * WEEK);
}

/**
 * The Saturday that starts the week containing `date`, at midnight in the
 * configured timezone.
 *
 * The Iranian week runs Saturday to Friday, so the ISO week helpers in most
 * libraries point at the wrong boundary here.
 *
 * Both the weekday and the day itself are resolved in `config.TZ`. Reading the
 * weekday off the instant with `getDay()` would answer in the process's own
 * zone, which is a different day from the user's for part of every day.
 */
export function startOfIranianWeek(date: Date): Date {
  const dayKey = toMealDateKey(date);
  const daysSinceSaturday = (weekdayOfDayKey(dayKey) + 1) % 7;

  return configuredMidnightForKey(shiftDayKey(dayKey, -daysSinceSaturday));
}

/** Whole days from `from` to `to`, counted by calendar day. */
export function daysBetween(from: Date, to: Date): number {
  const fromMidnight = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const toMidnight = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((toMidnight.getTime() - fromMidnight.getTime()) / DAY);
}

/**
 * Weekday index where 0 is Saturday and 6 is Friday.
 *
 * JavaScript's `getDay()` starts the week on Sunday, which is the wrong boundary
 * for an Iranian calendar. Every place that compares a date against a stored
 * weekday goes through here so the offset lives in exactly one place.
 */
export function weekdayIndexOf(date: Date): number {
  return (date.getDay() + 1) % 7;
}
