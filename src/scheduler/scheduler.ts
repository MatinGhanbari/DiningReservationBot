import cron, { type ScheduledTask } from 'node-cron';
import { config } from '../config/env';
import { scopedLogger } from '../shared/logger';

const log = scopedLogger('scheduler');

export interface ScheduledJob {
  name: string;
  /** Five-field cron expression: minute hour day-of-month month day-of-week. */
  expression: string;
  run: () => Promise<void>;
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

      log.info({ job: job.name, expression: job.expression, timezone: config.TZ }, 'scheduled job registered');
    }
  }

  stop(): void {
    for (const task of this.tasks) {
      task.stop();
    }

    this.tasks.length = 0;

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
