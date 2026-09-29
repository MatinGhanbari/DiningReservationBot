import type { MealOption, WeeklyReserves } from '../domain/models';
import { copy } from '../copy/fa';
import { formatJalaliDate } from '../shared/persian';

/**
 * Turns domain objects into the bodies of Telegram messages.
 *
 * Kept apart from both the copy module (which owns wording) and the handlers
 * (which own flow) so a change to how a meal is described happens in one place
 * and applies to every screen that lists meals.
 */

export function formatMealList(input: { selfName: string; weekLabel: string; meals: readonly MealOption[] }): string {
  const entries = input.meals.map((meal, index) =>
    copy.reservation.mealEntry({
      index: index + 1,
      weekday: meal.weekdayName,
      dateLabel: formatJalaliDate(meal.servedAt),
      mealTypeName: meal.mealTypeName,
      foodName: meal.foodName,
      priceRial: meal.priceRial,
    }),
  );

  return copy.reservation.mealList(input.selfName, input.weekLabel, entries);
}

export function formatReserves(input: { weekLabel: string; reserves: WeeklyReserves }): string {
  const entries = input.reserves.meals.map(meal =>
    copy.reserves.entry({
      weekday: meal.weekdayName,
      dateLabel: formatJalaliDate(meal.servedAt),
      foodName: meal.foodName,
      selfName: meal.selfName,
    }),
  );

  return copy.reserves.list(input.weekLabel, entries);
}

/** The human label for a week, taken from the copy module so it never diverges. */
export function weekLabel(week: 'current' | 'next'): string {
  return week === 'current' ? copy.reserves.weekLabel.current : copy.reserves.weekLabel.next;
}
