import { copy } from '../copy/fa';
import type { MealOption, User } from '../domain/models';
import type { Clock, Notifier, UserRepository } from '../domain/ports';
import { todayKey } from '../shared/dates';
import { formatJalaliDate, persianWeekday } from '../shared/persian';
import { scopedLogger } from '../shared/logger';
import { weekdayIndexOf } from '../shared/dates';
import type { ReservationService } from './reservation.service';

const log = scopedLogger('credit-watch');

export interface CreditWatchSummary {
  checked: number;
  reminded: number;
  skipped: number;
}

/**
 * Warns people whose balance will not cover the meals they are about to book.
 *
 * Auto-reserve fails silently from the user's side when the account is short: the
 * run reports a rejection, and by the time they read it the window may already be
 * closed. Checking ahead of time turns a lost meal into a chore they can still
 * finish.
 *
 * Only users with auto-reserve enabled are checked. Everyone else books by hand
 * and sees the shortfall at the moment they tap, which is soon enough.
 */
export class CreditWatchService {
  constructor(
    private readonly users: UserRepository,
    private readonly reservations: ReservationService,
    private readonly notifier: Notifier,
    private readonly clock: Clock,
  ) {}

  async runDaily(): Promise<CreditWatchSummary> {
    const candidates = await this.users.findAllWithAutoReserveEnabled();

    const summary: CreditWatchSummary = { checked: 0, reminded: 0, skipped: 0 };

    for (const user of candidates) {
      summary.checked += 1;

      try {
        const reminded = await this.checkForUser(user);
        summary.reminded += reminded ? 1 : 0;
      } catch (error) {
        summary.skipped += 1;
        log.warn({ err: error, telegramId: user.telegramId }, 'credit check failed for user');
      }
    }

    log.info(summary, 'credit watch finished');

    return summary;
  }

  /** Returns true when a reminder was actually delivered. */
  async checkForUser(user: User): Promise<boolean> {
    if (user.autoReserveSelfId === null || user.autoReserveWeekdays.length === 0) {
      return false;
    }

    const dayKey = todayKey(this.clock.now());

    // Once a day at most: the job may run several times, and a reminder every run
    // would be indistinguishable from spam.
    if (user.creditReminderSentOn === dayKey) {
      return false;
    }

    const upcoming = await this.upcomingMeals(user);

    if (upcoming.length === 0) {
      return false;
    }

    const requiredRial = upcoming.reduce((total, meal) => total + meal.priceRial, 0);
    const profile = await this.reservations.getProfile(user.telegramId);

    if (profile.creditRial >= requiredRial) {
      return false;
    }

    const body = copy.credit.reminder({
      creditRial: profile.creditRial,
      requiredRial,
      shortfallRial: requiredRial - profile.creditRial,
      meals: upcoming.map(meal =>
        copy.credit.mealLine({
          weekday: persianWeekday(meal.servedAt),
          dateLabel: formatJalaliDate(meal.servedAt),
          foodName: meal.foodName,
          priceRial: meal.priceRial,
        }),
      ),
    });

    try {
      await this.notifier.notify(user.telegramId, body);
      log.info({ telegramId: user.telegramId, shortfallRial: requiredRial - profile.creditRial }, 'credit reminder sent');
    } catch (error) {
      // A blocked bot is not worth retrying, and the flag is set below anyway so
      // the same user is not attempted again until tomorrow.
      log.warn({ err: error, telegramId: user.telegramId }, 'could not deliver credit reminder');
    }

    await this.users.markCreditReminderSent(user.telegramId, dayKey);

    return true;
  }

  /**
   * The meals auto-reserve would book right now.
   *
   * Both weeks are queried because the reservable window reaches into the next
   * one near the end of the week, and the dedupe by program id keeps a meal that
   * appears in both from being counted twice.
   */
  private async upcomingMeals(user: User): Promise<readonly MealOption[]> {
    const selected = new Set(user.autoReserveWeekdays);
    const seen = new Set<number>();
    const upcoming: MealOption[] = [];

    for (const week of ['current', 'next'] as const) {
      const options = await this.reservations.listMealOptions(user.telegramId, user.autoReserveSelfId as number, week);

      for (const option of options) {
        if (seen.has(option.programId) || !selected.has(weekdayIndexOf(option.servedAt))) {
          continue;
        }

        seen.add(option.programId);
        upcoming.push(option);
      }
    }

    return upcoming.sort((left, right) => left.servedAt.getTime() - right.servedAt.getTime());
  }
}
