import cron, { type ScheduledTask } from 'node-cron';
import { config } from '../config/env';
import type { SettingsRepository } from '../domain/ports';
import { scopedLogger } from '../shared/logger';

const log = scopedLogger('scheduler');

/** Which half of a clock time an admin is nudging. */
export type ScheduleField = 'hour' | 'minute';

/** How many values the field cycles through, which is also its wrap-around. */
const FIELD_SPAN: Record<ScheduleField, number> = { hour: 24, minute: 60 };

const SETTINGS_PREFIX = 'schedule.';

export interface ScheduledJob {
  name: string;
  /** Used whenever no admin override is stored for this job. */
  defaultExpression: string;
  run: () => Promise<void>;
}

export interface ScheduledJobTiming {
  name: string;
  expression: string;
  /** Null when the task is stopped, or has no match in node-cron's search window. */
  nextRunAt: Date | null;
  /** The clock time the panel edits. Null when the expression is not a plain daily run. */
  hour: number | null;
  minute: number | null;
  /** Whether the expression comes from a stored override rather than the default. */
  isCustom: boolean;
}

/** `minute hour * * *` — the only shape an admin-set time can produce. */
const DAILY_EXPRESSION = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/;

/** The stored form of a clock time: two digits, a colon, two digits. */
const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseClockTime(value: string): { hour: number; minute: number } | null {
  const match = CLOCK_TIME.exec(value.trim());

  return match === null ? null : { hour: Number(match[1]), minute: Number(match[2]) };
}

export const formatClockTime = (time: { hour: number; minute: number }): string =>
  `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;

const toExpression = (time: { hour: number; minute: number }): string => `${time.minute} ${time.hour} * * *`;

/**
 * The clock time of a plain daily expression, or null for anything else.
 *
 * A job that runs on a step — every six hours, say — has no single hour an
 * admin could nudge, so the panel shows it read-only instead of pretending it
 * can be adjusted to a time it would not honour.
 */
export function parseDailyTime(expression: string): { hour: number; minute: number } | null {
  const match = DAILY_EXPRESSION.exec(expression.trim());

  if (match === null) {
    return null;
  }

  const minute = Number(match[1]);
  const hour = Number(match[2]);

  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

/**
 * In-process cron.
 *
 * Kept in the same process as the bot on purpose. A separate worker would need
 * its own deployment, its own database connection, and a coordination mechanism
 * to stop both from running the same job — all to schedule two tasks a day. The
 * `Mutex` inside the auto-reserve service already guarantees the job cannot
 * overlap itself.
 *
 * The trade is stated plainly: running more than one replica would run the job
 * once per replica. The single-container deployment is what makes this correct.
 *
 * The scheduler also owns the stored time overrides. That is deliberate: it is
 * the one place that decides what a job's expression is, so a time an admin
 * saves and the timer that fires cannot drift apart.
 */
export class Scheduler {
  private readonly jobs = new Map<string, { definition: ScheduledJob; expression: string; task: ScheduledTask }>();

  constructor(private readonly settings: SettingsRepository) {}

  /**
   * Registers every job, preferring a stored override over the configured default.
   *
   * Reading the overrides here rather than in the composition root is what makes
   * "restart and it is still the same time" true by construction: there is no
   * second code path that could resolve an expression differently.
   */
  async start(jobs: readonly ScheduledJob[]): Promise<void> {
    for (const job of jobs) {
      const stored = await this.storedTime(job.name);

      this.register(job, stored === null ? job.defaultExpression : toExpression(stored));
    }
  }

  /**
   * When each registered job fires next, in `config.TZ`.
   *
   * The answer comes from the task that is actually scheduled, so what the panel
   * shows and what the timer does cannot drift apart.
   */
  upcoming(): readonly ScheduledJobTiming[] {
    return [...this.jobs.values()].map(entry => {
      const time = parseDailyTime(entry.expression);

      return {
        name: entry.definition.name,
        expression: entry.expression,
        nextRunAt: entry.task.getNextRun(),
        hour: time?.hour ?? null,
        minute: time?.minute ?? null,
        isCustom: entry.expression !== entry.definition.defaultExpression,
      };
    });
  }

  /**
   * Moves one field of a job's time and applies it immediately.
   *
   * The value wraps rather than clamping, so every time is reachable by holding
   * one direction and there is no edge to get stuck against. It is stored before
   * the timer is touched: a value that is applied but not saved would vanish at
   * the next restart, which is exactly the surprise this feature exists to
   * remove.
   */
  async stepTime(name: string, field: ScheduleField, delta: number): Promise<void> {
    const entry = this.jobOrThrow(name);
    const current = this.editableTimeOf(entry.expression, name);

    const span = FIELD_SPAN[field];
    const next = { ...current, [field]: (((current[field] + delta) % span) + span) % span };

    await this.settings.set(SETTINGS_PREFIX + name, formatClockTime(next));
    this.applyExpression(name, toExpression(next));
  }

  /** Drops a stored override, putting the job back on its configured default. */
  async resetTime(name: string): Promise<void> {
    const entry = this.jobOrThrow(name);

    await this.settings.remove(SETTINGS_PREFIX + name);

    if (entry.expression !== entry.definition.defaultExpression) {
      this.applyExpression(name, entry.definition.defaultExpression);
    }
  }

  /**
   * Runs a registered job now, out of band.
   *
   * The run goes through the same path a timer tick takes, so a manual run and
   * a scheduled one cannot behave differently. A failure is thrown rather than
   * swallowed here: a tick has nobody to tell, an admin who pressed a button
   * does.
   */
  async runNow(name: string): Promise<void> {
    await this.execute(this.jobOrThrow(name).definition);
  }

  stop(): void {
    for (const entry of this.jobs.values()) {
      entry.task.stop();
    }

    this.jobs.clear();

    log.info('scheduler stopped');
  }

  /** The stored override as a clock time, or null when there is none to read. */
  private async storedTime(name: string): Promise<{ hour: number; minute: number } | null> {
    const stored = await this.settings.get(SETTINGS_PREFIX + name);

    return stored === null ? null : parseClockTime(stored);
  }

  private jobOrThrow(name: string): { definition: ScheduledJob; expression: string; task: ScheduledTask } {
    const entry = this.jobs.get(name);

    if (entry === undefined) {
      // Only reachable if a caller names a job the container never registered.
      throw new Error(`Unknown scheduled job: ${name}`);
    }

    return entry;
  }

  private editableTimeOf(expression: string, name: string): { hour: number; minute: number } {
    const time = parseDailyTime(expression);

    if (time === null) {
      throw new Error(`Job "${name}" has no clock time to adjust`);
    }

    return time;
  }

  /** Swaps a job's live task for one on a new expression, without a gap. */
  private applyExpression(name: string, expression: string): void {
    const entry = this.jobOrThrow(name);

    // Built before the old task is stopped, so an expression that failed to
    // schedule could never leave the job with no task at all.
    const task = this.createTask(entry.definition, expression);

    entry.task.stop();
    this.jobs.set(name, { definition: entry.definition, expression, task });

    log.info({ job: name, expression }, 'scheduled job rescheduled');
  }

  private register(definition: ScheduledJob, expression: string): void {
    const task = this.createTask(definition, expression);

    this.jobs.set(definition.name, { definition, expression, task });

    log.info({ job: definition.name, expression, timezone: config.TZ }, 'scheduled job registered');
  }

  private createTask(definition: ScheduledJob, expression: string): ScheduledTask {
    if (!cron.validate(expression)) {
      // Failing at boot is better than a job that silently never fires.
      throw new Error(`Invalid cron expression for job "${definition.name}": ${expression}`);
    }

    return cron.schedule(
      expression,
      () => {
        // `execute` logs the failure on its way out, and a tick has no one to
        // report it to — hence the empty catch.
        void this.execute(definition).catch(() => undefined);
      },
      { timezone: config.TZ },
    );
  }

  private async execute(job: ScheduledJob): Promise<void> {
    const startedAt = Date.now();

    try {
      await job.run();
      log.info({ job: job.name, durationMs: Date.now() - startedAt }, 'scheduled job finished');
    } catch (error) {
      // A failing job must never crash the process: the bot has to stay up to
      // serve the people who are still using it.
      log.error({ err: error, job: job.name }, 'scheduled job failed');

      // Rethrown for the manual run, which has an admin waiting to hear whether
      // it worked. The scheduled caller catches it again above.
      throw error;
    }
  }
}
