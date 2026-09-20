import { copy } from '../copy/fa';
import type { User } from '../domain/models';
import type { Clock, Notifier, UserRepository } from '../domain/ports';
import { Mutex } from '../shared/async';
import { weekdayIndexOf } from '../shared/dates';
import { isAppError, toAppError } from '../shared/errors';
import { scopedLogger } from '../shared/logger';
import { WEEKDAY_NAMES } from '../shared/persian';
import type { ReservationService } from './reservation.service';

const log = scopedLogger('auto-reserve');

export interface AutoReserveSettings {
  enabled: boolean;
  selfId: number | null;
  weekdays: readonly number[];
}

export interface AutoReserveRunSummary {
  usersConsidered: number;
  usersSkipped: number;
  reservedCount: number;
  failureCount: number;
  durationMs: number;
  /** True when this tick was dropped because the previous run was still going. */
  skipped: boolean;
}

const EMPTY_SUMMARY: AutoReserveRunSummary = {
  usersConsidered: 0,
  usersSkipped: 0,
  reservedCount: 0,
  failureCount: 0,
  durationMs: 0,
  skipped: true,
};

/**
 * Books meals ahead of time on the days the user says they eat.
 *
 * Two design points worth stating, because both are easy to get wrong:
 *
 *   - **It books as soon as the meal becomes reservable, not on the day itself.**
 *     Samad locks a meal roughly two days out, so a job that fires on Wednesday
 *     to reserve Wednesday's lunch would always be too late. Each run looks at
 *     every unreserved meal in the reservable window that falls on one of the
 *     user's chosen weekdays.
 *
 *   - **It never overlaps itself.** Two concurrent runs would both read the same
 *     "not reserved yet" state and book the same meal twice, which costs the user
 *     real money. The mutex is not optional.
 */
export class AutoReserveService {
  private readonly mutex = new Mutex();

  constructor(
    private readonly users: UserRepository,
    private readonly reservations: ReservationService,
    private readonly notifier: Notifier,
    private readonly clock: Clock,
  ) {}

  async getSettings(telegramId: number): Promise<AutoReserveSettings> {
    const user = await this.users.findByTelegramId(telegramId);

    return {
      enabled: user?.autoReserveEnabled ?? false,
      selfId: user?.autoReserveSelfId ?? null,
      weekdays: user?.autoReserveWeekdays ?? [],
    };
  }

  /**
   * Turns auto-reserve on or off.
   *
   * Refuses to enable without a chosen dining hall. Turning it on and then
   * silently doing nothing is worse than saying what is missing.
   */
  async setEnabled(telegramId: number, enabled: boolean): Promise<void> {
    if (enabled) {
      const user = await this.users.findByTelegramId(telegramId);

      if (user === null || user.autoReserveSelfId === null) {
        throw new Error('AUTO_RESERVE_SELF_REQUIRED');
      }
    }

    await this.users.setAutoReserveEnabled(telegramId, enabled);
  }

  async setSelf(telegramId: number, selfId: number): Promise<void> {
    await this.users.setAutoReserveSelf(telegramId, selfId);
  }

  /** Adds or removes a weekday. Returns whether it is now selected. */
  async toggleWeekday(telegramId: number, weekday: number): Promise<boolean> {
    return this.users.toggleAutoReserveWeekday(telegramId, weekday);
  }

  /**
   * One pass over every user with auto-reserve enabled.
   *
   * A failure for one user must never stop the run: the remaining users still
   * need their meals, so every user is wrapped individually.
   *
   * A tick that arrives while a previous pass is still running is dropped rather
   * than queued. Queuing would let a slow run build a backlog of passes, each
   * replaying a plan that has already gone stale.
   */
  async runDaily(): Promise<AutoReserveRunSummary> {
    const summary = await this.mutex.tryRunExclusive(() => this.runOnce());

    if (summary === null) {
      log.warn('auto-reserve tick skipped; the previous run is still in progress');

      return EMPTY_SUMMARY;
    }

    return summary;
  }

  private async runOnce(): Promise<AutoReserveRunSummary> {
    const startedAt = Date.now();
    const users = await this.users.findAllWithAutoReserveEnabled();

    const summary: AutoReserveRunSummary = {
      usersConsidered: users.length,
      usersSkipped: 0,
      reservedCount: 0,
      failureCount: 0,
      durationMs: 0,
      skipped: false,
    };

    log.info({ users: users.length }, 'auto-reserve run started');

    for (const user of users) {
      try {
        const outcome = await this.runForUser(user);
        summary.reservedCount += outcome.reserved;
        summary.failureCount += outcome.failed;

        if (outcome.skipped) {
          summary.usersSkipped += 1;
        }
      } catch (error) {
        summary.failureCount += 1;
        log.error({ err: error, telegramId: user.telegramId }, 'auto-reserve failed for user');
      }
    }

    summary.durationMs = Date.now() - startedAt;

    log.info(summary, 'auto-reserve run finished');

    return summary;
  }

  /**
   * Reserves everything currently bookable for one user.
   *
   * Both the current and the following week are queried: on a Friday the
   * reservable window already reaches into next week, and Samad's "current week"
   * query alone would silently miss those days.
   */
  async runForUser(user: User): Promise<{ reserved: number; failed: number; skipped: boolean }> {
    if (user.autoReserveSelfId === null || user.autoReserveWeekdays.length === 0) {
      return { reserved: 0, failed: 0, skipped: true };
    }

    const selectedWeekdays = new Set(user.autoReserveWeekdays);
    const seenProgramIds = new Set<number>();
    const candidates = [];

    for (const week of ['current', 'next'] as const) {
      const options = await this.reservations.listMealOptions(user.telegramId, user.autoReserveSelfId, week);

      for (const option of options) {
        if (seenProgramIds.has(option.programId)) {
          continue;
        }

        if (!selectedWeekdays.has(weekdayIndexOf(option.servedAt))) {
          continue;
        }

        seenProgramIds.add(option.programId);
        candidates.push(option);
      }
    }

    if (candidates.length === 0) {
      return { reserved: 0, failed: 0, skipped: false };
    }

    let reserved = 0;
    let failed = 0;
    const failures: string[] = [];

    for (const candidate of candidates) {
      try {
        const outcome = await this.reservations.reserve(user.telegramId, candidate.programId, candidate.foodTypeId);

        if (outcome.succeeded) {
          reserved += 1;
        } else {
          failed += 1;
          failures.push(`${candidate.foodName}: ${outcome.message}`);
        }
      } catch (error) {
        failed += 1;

        const appError = toAppError(error);
        failures.push(`${candidate.foodName}: ${appError.userMessage}`);

        log.warn({ err: error, telegramId: user.telegramId }, 'auto-reserve attempt failed');

        // A dead session makes every remaining attempt fail the same way, so stop
        // early rather than hammering Samad with requests that cannot succeed.
        if (isAppError(error) && error.code === 'SESSION_EXPIRED') {
          break;
        }
      }
    }

    if (reserved > 0 || failed > 0) {
      await this.notifyUser(user, reserved, failed, failures);
    }

    return { reserved, failed, skipped: false };
  }

  private async notifyUser(user: User, reserved: number, failed: number, failures: readonly string[]): Promise<void> {
    const weekdayLabel = WEEKDAY_NAMES[weekdayIndexOf(this.clock.now())] ?? '';

    const body = copy.autoReserve.report({
      reserved,
      failed,
      weekdayLabel,
      failures,
    });

    try {
      await this.notifier.notify(user.telegramId, body);
    } catch (error) {
      // A blocked bot is not a reason to fail the run; the reservation already happened.
      log.warn({ err: error, telegramId: user.telegramId }, 'could not deliver auto-reserve report');
    }
  }
}
