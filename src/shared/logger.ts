import { pino, type Logger } from 'pino';
import { config, isProduction } from '../config/env';

/**
 * Structured logger.
 *
 * Secrets must never reach the log files, so redaction is configured centrally
 * rather than relying on every call site to remember. This matters here because
 * user passwords, Samad access tokens and the OpenRouter key all flow through the
 * request path.
 *
 * The list below is intentionally broader than the fields that exist today. A
 * request object is logged whole in several places, and anything nested inside it
 * — a header, a form body, a query string — is one refactor away from carrying a
 * credential. Whole request-shaped fields are therefore redacted rather than
 * enumerated.
 */
const redactPaths = [
  // Credentials by name, wherever they appear.
  'password',
  '*.password',
  '*.encryptedPassword',
  'encryptedPassword',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'token',
  '*.token',
  'secret',
  '*.secret',
  'apiKey',
  '*.apiKey',
  'key',
  '*.key',
  // Whole structures that are never worth logging and always risky.
  'headers',
  '*.headers',
  'extraHeaders',
  '*.extraHeaders',
  'formBody',
  '*.formBody',
  'jsonBody',
  '*.jsonBody',
  'query',
  '*.query',
  'authorization',
  '*.authorization',
  // Environment secrets, in case a snapshot of the environment is ever logged.
  'BOT_TOKEN',
  'ENCRYPTION_KEY',
  'OPENROUTER_API_KEY',
  // Telegram's webhook secret travels in the `setWebhook` payload, and a failed
  // call reaches the log inside the thrown error — `err.on.payload.secret_token`
  // — rather than at the top level, so the nested path is named explicitly.
  'secret_token',
  '*.secret_token',
  'err.on.payload.secret_token',
];

export const logger: Logger = pino({
  level: config.LOG_LEVEL,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: redactPaths, censor: '[حذف‌شده]' },
  ...(config.LOG_PRETTY && !isProduction
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
});

/**
 * Creates a logger that tags every line with a scope, so a single grep is enough
 * to follow one subsystem through interleaved output.
 */
export function scopedLogger(scope: string): Logger {
  return logger.child({ scope });
}
