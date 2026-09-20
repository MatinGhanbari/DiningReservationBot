/**
 * Application error taxonomy.
 *
 * Every error carries two messages on purpose:
 *   - `message`     — technical, English, for logs and stack traces.
 *   - `userMessage` — Persian, ready to be shown to the person in Telegram.
 *
 * Keeping them together means a handler never has to invent copy at the point
 * of failure, which is exactly where wording tends to become robotic.
 */
export type AppErrorCode =
  | 'SESSION_EXPIRED'
  | 'INVALID_CREDENTIALS'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_REJECTED'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION'
  | 'FORBIDDEN'
  | 'INTERNAL';

export interface AppErrorOptions {
  cause?: unknown;
  /** Extra context written to the log, never shown to the user. */
  context?: Record<string, unknown>;
  /** Whether the operation is worth retrying as-is. */
  retryable?: boolean;
}

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly userMessage: string;
  readonly context: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(code: AppErrorCode, message: string, userMessage: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.userMessage = userMessage;
    this.context = options.context ?? {};
    this.retryable = options.retryable ?? false;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** The stored session is gone or was rejected upstream: the user must log in again. */
export class SessionExpiredError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(
      'SESSION_EXPIRED',
      'No valid session for this user',
      'نشستت منقضی شده. لطفاً یک‌بار دیگر وارد حساب سمادت شو.',
      options,
    );
  }
}

/** Samad refused the username/password pair. */
export class InvalidCredentialsError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(
      'INVALID_CREDENTIALS',
      'Samad rejected the supplied credentials',
      'نام کاربری یا رمز سماد درست نبود. یک‌بار دیگر امتحان کن.',
      options,
    );
  }
}

export interface UpstreamUnavailableErrorOptions extends AppErrorOptions {
  /** Overrides the default technical message, for upstreams other than Samad. */
  message?: string;
  /** Overrides the default Persian copy, so the advice matches the upstream. */
  userMessage?: string;
}

/** Samad could not be reached, or answered too slowly. */
export class UpstreamUnavailableError extends AppError {
  constructor(options: UpstreamUnavailableErrorOptions = {}) {
    const { message, userMessage, ...rest } = options;

    super(
      'UPSTREAM_UNAVAILABLE',
      message ?? 'Samad did not respond in time',
      userMessage ?? 'الان نتوانستم به سماد وصل شوم. چند لحظه بعد یک‌بار دیگر امتحان کن.',
      { retryable: true, ...rest },
    );
  }
}

/** Samad answered, but with a business-level failure (no credit, already reserved, ...). */
export class UpstreamRejectedError extends AppError {
  constructor(message: string, userMessage: string, options: AppErrorOptions = {}) {
    super('UPSTREAM_REJECTED', message, userMessage, options);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, userMessage: string, options: AppErrorOptions = {}) {
    super('NOT_FOUND', message, userMessage, options);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, userMessage: string, options: AppErrorOptions = {}) {
    super('CONFLICT', message, userMessage, options);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, userMessage: string, options: AppErrorOptions = {}) {
    super('VALIDATION', message, userMessage, options);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string, userMessage: string, options: AppErrorOptions = {}) {
    super('FORBIDDEN', message, userMessage, options);
  }
}

/** The caller has spent an allowance, such as the chatbot's daily message budget. */
export class RateLimitedError extends AppError {
  constructor(message: string, userMessage: string, options: AppErrorOptions = {}) {
    super('RATE_LIMITED', message, userMessage, options);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Narrows anything thrown into an AppError so handlers always have Persian copy
 * to fall back on, even for a bug we did not anticipate.
 */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return new AppError('INTERNAL', error.message, 'یه مشکل غیرمنتظره پیش آمد. لطفاً یک‌بار دیگر امتحان کن.', {
      cause: error,
    });
  }

  return new AppError('INTERNAL', String(error), 'یه مشکل غیرمنتظره پیش آمد. لطفاً یک‌بار دیگر امتحان کن.', {
    cause: error,
  });
}
