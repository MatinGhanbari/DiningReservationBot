import cron, { type ScheduledTask } from 'node-cron';
import { config } from '../config/env';
import { scopedLogger } from '../shared/logger';
import { MINUTE } from '../shared/time';

const log = scopedLogger('scheduler');

/** How far ahead a next-run search looks: one year, so a yearly expression still resolves. */
const LOOKAHEAD_MINUTES = 366 * 24 * 60;

/** The part of node-cron's matcher that answers "does this instant match?". */
interface CronTimeMatcher {
  match(date: Date): boolean;
}

/** node-cron holds its matcher on a field its own typings do not describe. */
interface ScheduledTaskInternals {
  _scheduler?: { timeMatcher?: CronTimeMatcher };
}

export interface ScheduledJob {
  name: string;
  /** Five-field cron expression: minute hour day-of-month month day-of-week. */
  expression: string;
  run: () => Promise<void>;
}

export interface ScheduledJobTiming {
  name: string;
  expression: string;
  /** Null when the expression has no match within the lookahead window. */
  nextRunAt: Date | null;
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
 */
export class Scheduler {
  private readonly tasks: ScheduledTask[] = [];

  private readonly registered: Array<{ name: string; expression: string; matcher: CronTimeMatcher | null }> = [];

  start(jobs: readonly ScheduledJob[]): void {
    for (const job of jobs) {
      if (!cron.validate(job.expression)) {
        // Failing at boot is better than a job that silently never fires.
        throw new Error(`Invalid cron expression for job "${job.name}": ${job.expression}`);
      }

      const task = cron.schedule(
        job.expression,
        () => {
          void this.execute(job);
        },
        { timezone: config.TZ },
      );

      this.tasks.push(task);
      this.registered.push({ name: job.name, expression: job.expression, matcher: matcherOf(task) });

      log.info({ job: job.name, expression: job.expression, timezone: config.TZ }, 'scheduled job registered');
    }
  }

  /**
   * When each registered job fires next, in `config.TZ`.
   *
   * The matcher is taken off the task that is actually scheduled, so what the
   * panel shows and what the timer does cannot drift apart.
   */
  upcoming(now: Date): readonly ScheduledJobTiming[] {
    return this.registered.map(job => ({
      name: job.name,
      expression: job.expression,
      nextRunAt: job.matcher === null ? null : nextRunAfter(job.matcher, now),
    }));
  }

  stop(): void {
    for (const task of this.tasks) {
      task.stop();
    }

    this.tasks.length = 0;
    this.registered.length = 0;

    log.info('scheduler stopped');
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
    }
  }
}

/**
 * Reads node-cron's own matcher off a scheduled task.
 *
 * Null when the internals move under us, which the panel reports as an unknown
 * next run rather than failing the screen.
 */
function matcherOf(task: ScheduledTask): CronTimeMatcher | null {
  const matcher = (task as unknown as ScheduledTaskInternals)._scheduler?.timeMatcher;

  return matcher !== undefined && typeof matcher.match === 'function' ? matcher : null;
}

/** The first whole minute after `from` the expression matches. */
function nextRunAfter(matcher: CronTimeMatcher, from: Date): Date | null {
  const start = Math.ceil((from.getTime() + 1) / MINUTE) * MINUTE;

  for (let offset = 0; offset < LOOKAHEAD_MINUTES; offset += 1) {
    const candidate = new Date(start + offset * MINUTE);

    if (matcher.match(candidate)) {
      return candidate;
    }
  }

  return null;
}
