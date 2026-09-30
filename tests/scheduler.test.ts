import { afterEach, describe, expect, it } from 'vitest';
import type { SettingsRepository } from '../src/domain/ports';
import { Scheduler, type ScheduledJob } from '../src/scheduler/scheduler';

/** The stored values, without a database. */
class MemorySettings implements SettingsRepository {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

const noop = async (): Promise<void> => undefined;

const job = (name: string, defaultExpression: string): ScheduledJob => ({ name, defaultExpression, run: noop });

describe('scheduler time overrides', () => {
  let scheduler: Scheduler | null = null;

  afterEach(() => {
    // The tasks hold real timers; leaving one running keeps the suite alive.
    scheduler?.stop();
    scheduler = null;
  });

  it('prefers a stored time over the configured default at start-up', async () => {
    const settings = new MemorySettings();
    await settings.set('schedule.auto-reserve', '23:45');

    scheduler = new Scheduler(settings);
    await scheduler.start([job('auto-reserve', '0 7 * * *'), job('maintenance', '17 */6 * * *')]);

    expect(scheduler.upcoming()[0]).toMatchObject({
      name: 'auto-reserve',
      expression: '45 23 * * *',
      hour: 23,
      minute: 45,
      isCustom: true,
    });

    // A step expression has no clock time, so the panel shows it read-only.
    expect(scheduler.upcoming()[1]).toMatchObject({
      name: 'maintenance',
      expression: '17 */6 * * *',
      hour: null,
      minute: null,
      isCustom: false,
    });
  });

  it('falls back to the default when nothing is stored', async () => {
    scheduler = new Scheduler(new MemorySettings());
    await scheduler.start([job('auto-reserve', '0 7 * * *')]);

    expect(scheduler.upcoming()[0]).toMatchObject({ expression: '0 7 * * *', hour: 7, minute: 0, isCustom: false });
  });

  it('wraps an hour below midnight and stores the result', async () => {
    const settings = new MemorySettings();
    scheduler = new Scheduler(settings);
    await scheduler.start([job('credit-watch', '0 0 * * *')]);

    await scheduler.stepTime('credit-watch', 'hour', -1);

    expect(scheduler.upcoming()[0]).toMatchObject({ expression: '0 23 * * *', hour: 23, minute: 0, isCustom: true });
    await expect(settings.get('schedule.credit-watch')).resolves.toBe('23:00');
  });

  it('wraps a minute past fifty-nine', async () => {
    const settings = new MemorySettings();
    scheduler = new Scheduler(settings);
    await scheduler.start([job('auto-reserve', '59 20 * * *')]);

    await scheduler.stepTime('auto-reserve', 'minute', 1);

    expect(scheduler.upcoming()[0]).toMatchObject({ expression: '0 20 * * *', hour: 20, minute: 0 });
    await expect(settings.get('schedule.auto-reserve')).resolves.toBe('20:00');
  });

  it('goes back to the default when the stored time is dropped', async () => {
    const settings = new MemorySettings();
    await settings.set('schedule.auto-reserve', '09:30');

    scheduler = new Scheduler(settings);
    await scheduler.start([job('auto-reserve', '0 7 * * *')]);

    await scheduler.resetTime('auto-reserve');

    expect(scheduler.upcoming()[0]).toMatchObject({ expression: '0 7 * * *', hour: 7, minute: 0, isCustom: false });
    await expect(settings.get('schedule.auto-reserve')).resolves.toBeNull();
  });

  it('refuses to nudge a job that runs on a step', async () => {
    scheduler = new Scheduler(new MemorySettings());
    await scheduler.start([job('maintenance', '17 */6 * * *')]);

    await expect(scheduler.stepTime('maintenance', 'hour', 1)).rejects.toThrow(/no clock time/);
  });
});
