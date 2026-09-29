import { UpstreamUnavailableError } from './errors';

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/**
 * Rejects if a promise does not settle in time.
 *
 * Every outbound call to Samad goes through this. Without a deadline a single
 * hung socket holds a Telegram handler open forever, and the person waiting in
 * the chat gets no answer at all — the failure mode the original code had.
 */
export async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export interface RetryOptions {
  /** Total number of attempts, including the first one. */
  attempts: number;
  /** Delay before the second attempt; doubles after each further failure. */
  baseDelayMs: number;
  /** Upper bound for the backoff delay. */
  maxDelayMs?: number;
  /** Decides whether a given failure is worth another attempt. */
  shouldRetry: (error: unknown, attempt: number) => boolean;
  /** Called before each retry, for logging. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Retries an operation with exponential backoff and jitter.
 *
 * Jitter matters when many users trigger the same upstream call at once, which
 * is exactly what the 7am auto-reserve run does: without it every request
 * retries in lockstep and hammers a service that is already struggling.
 */
export async function retry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { attempts, baseDelayMs, maxDelayMs = 5_000, shouldRetry, onRetry } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      const isLastAttempt = attempt === attempts;
      if (isLastAttempt || !shouldRetry(error, attempt)) {
        throw error;
      }

      const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const delay = Math.round(exponential * (0.5 + Math.random() * 0.5));

      onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }

  throw lastError;
}

/** True for failures that a later attempt could plausibly survive. */
export function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof UpstreamUnavailableError) {
    return true;
  }

  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return (
      code === 'ECONNRESET' ||
      code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT' ||
      code === 'EAI_AGAIN' ||
      code === 'ENOTFOUND' ||
      error.name === 'AbortError'
    );
  }

  return false;
}

/**
 * A promise-chain mutex.
 *
 * The auto-reserve run must not overlap itself: two concurrent passes would read
 * the same "not reserved yet" state and reserve the same meal twice.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  private waiters = 0;

  async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.tail;

    let release = (): void => undefined;
    this.tail = new Promise<void>(resolve => {
      release = resolve;
    });

    this.waiters += 1;

    await previous;

    try {
      return await task();
    } finally {
      this.waiters -= 1;
      release();
    }
  }

  /**
   * Runs the task only when the lock is free, and reports `null` when it is not.
   *
   * Queueing is the wrong shape for a scheduled job: a pass that takes longer
   * than its own interval would build a backlog of runs replaying a plan that is
   * already stale. Skipping is safe because the next tick is a day away.
   *
   * The check and the increment are both synchronous, so no second caller can
   * slip between them.
   */
  async tryRunExclusive<T>(task: () => Promise<T>): Promise<T | null> {
    if (this.waiters > 0) {
      return null;
    }

    return this.runExclusive(task);
  }

  /** True while a task holds the lock or is queued behind one. */
  get isBusy(): boolean {
    return this.waiters > 0;
  }
}
