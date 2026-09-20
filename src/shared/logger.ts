import { pino, type Logger } from 'pino';
import { config, isProduction } from '../config/env';

/**
 * Structured logger.
 *
 * Secrets must never reach the log files, so redaction is configured centrally
 * rather than relying on every call site to remember. This matters here because
 * user passwords and Samad access tokens flow through the request path.
 */
const redactPaths = [
  'password',
  '*.password',
  'encryptedPassword',
  '*.encryptedPassword',
  'accessToken',
  '*.accessToken',
  'token',
  '*.token',
  'authorization',
  '*.authorization',
  'headers.authorization',
  'BOT_TOKEN',
  'ENCRYPTION_KEY',
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
