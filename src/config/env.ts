import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Minimal .env loader.
 *
 * Node's built-in `process.loadEnvFile` would do, but it overwrites values that
 * were already injected by the orchestrator. In production the real environment
 * must always win, so we only fill in what is genuinely missing.
 */
function loadDotEnvFile(fileName = '.env'): void {
  const filePath = resolve(process.cwd(), fileName);
  if (!existsSync(filePath)) {
    return;
  }

  const content = readFileSync(filePath, 'utf8');

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    const isQuoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));

    if (isQuoted && value.length >= 2) {
      value = value.slice(1, -1);
    }

    if (key.length > 0 && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnvFile();

/** A non-negative integer with a fallback, accepting numeric strings from the environment. */
const integer = (fallback: number) => z.coerce.number().int().nonnegative().default(fallback);

/** A positive integer with a fallback. */
const positiveInteger = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const booleanFlag = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .default(fallback ? 'true' : 'false')
    .transform(value => value === 'true');

/**
 * Telegram numeric ids, provided as a JSON array: `[111,222]`.
 *
 * Parsing is strict on purpose — a silently malformed admin list would mean
 * support messages are delivered to nobody.
 */
const telegramIds = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((raw, ctx) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'مقدار ADMINS باید آرایهٔ JSON باشد، مثل [111,222].' });
        return z.NEVER;
      }

      if (!Array.isArray(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'مقدار ADMINS باید آرایه باشد، نه مقدار تکی.' });
        return z.NEVER;
      }

      const ids: number[] = [];
      for (const entry of parsed) {
        const id = Number(entry);
        if (!Number.isSafeInteger(id) || id <= 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `شناسهٔ «${String(entry)}» در ADMINS یک عدد صحیح مثبت نیست.` });
          return z.NEVER;
        }
        ids.push(id);
      }

      return ids;
    });

/** A five-field cron expression, validated by field count so a typo fails at boot, not at 7am. */
const cronExpression = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .refine(value => value.trim().split(/\s+/).length === 5, {
      message: 'قالب زمان‌بندی باید پنج فیلد داشته باشد: دقیقه ساعت روز ماه هفته',
    });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).default('development'),

  // Telegram
  BOT_TOKEN: z.string().min(1, 'توکن ربات خالی است. مقدار BOT_TOKEN را از @BotFather بگیرید.'),
  ADMINS: telegramIds('[116969885]'),
  /** Base URL of the Telegram Bot API. Override to point at a local Bot API server or a proxy; defaults to the public cloud endpoint. */
  TELEGRAM_API_ROOT: z.string().url().default('https://api.telegram.org'),

  // Database
  DATABASE_PATH: z.string().min(1).default('./data/bot.db'),
  DB_BUSY_TIMEOUT_MS: positiveInteger(5_000),
  DB_CACHE_MB: positiveInteger(64),
  DB_MMAP_MB: positiveInteger(256),

  // Security
  ENCRYPTION_KEY: z.string().min(32, 'کلید رمزنگاری باید حداقل ۳۲ کاراکتر باشد. با دستور «openssl rand -hex 32» یکی بسازید.'),

  // Session / cache
  SESSION_TTL_MINUTES: positiveInteger(60),
  SESSION_MAX_ENTRIES: positiveInteger(10_000),

  // Auto reserve
  AUTO_RESERVE_CRON: cronExpression('0 7 * * *'),
  TZ: z.string().min(1).default('Asia/Tehran'),

  // Reservations
  RESERVABLE_DAYS_AHEAD: integer(3),

  // Credit reminder
  CREDIT_CHECK_CRON: cronExpression('0 20 * * *'),

  // Support chatbot
  OPENROUTER_API_KEY: z.string().default(''),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  OPENROUTER_MODEL: z.string().min(1).default('meta-llama/llama-3.3-70b-instruct:free'),
  OPENROUTER_TIMEOUT_MS: positiveInteger(30_000),
  CHATBOT_DAILY_LIMIT: positiveInteger(20),
  CHATBOT_HISTORY_TURNS: positiveInteger(8),
  /** A question longer than this is truncated before it reaches the model: it is a cost and context budget, not a guess at how much someone can type. */
  CHATBOT_MAX_QUESTION_CHARS: positiveInteger(500),
  /** Cap on a stored answer, so a runaway completion cannot fill the database. */
  CHATBOT_MAX_ANSWER_CHARS: positiveInteger(2_000),
  /** Chatbot transcripts older than this are removed by the maintenance job. */
  CHATBOT_RETENTION_DAYS: positiveInteger(90),

  // Samad upstream
  SAMAD_TIMEOUT_MS: positiveInteger(15_000),
  SAMAD_MAX_RETRIES: integer(2),
  /**
   * Whether to verify Samad's TLS certificate chain. Leave on unless Samad's
   * host serves an incomplete chain that Node cannot validate (browsers fetch
   * the missing intermediate, Node does not). Disabling weakens transport
   * security for Samad traffic and should be a last resort.
   */
  SAMAD_TLS_VERIFY: booleanFlag(true),

  // Health server
  PORT: z.coerce.number().int().min(0).max(65_535).default(3_000),

  // Logging
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: booleanFlag(false),
});

export type AppConfig = Readonly<z.infer<typeof EnvSchema>>;

function readConfig(): AppConfig {
  const result = EnvSchema.safeParse(process.env);

  if (!result.success) {
    const details = result.error.issues
      .map(issue => {
        const field = issue.path.length > 0 ? issue.path.join('.') : 'ریشه';
        return `  • ${field}: ${issue.message}`;
      })
      .join('\n');

    throw new Error(`پیکربندی محیطی نامعتبر است:\n${details}\n\nراهنما: فایل .env.example را ببینید.`);
  }

  return Object.freeze(result.data);
}

export const config = readConfig();

export const isProduction = config.NODE_ENV === 'production';
export const isTest = config.NODE_ENV === 'test';

const ADMIN_IDS: ReadonlySet<number> = new Set(config.ADMINS);

export function isAdmin(telegramId: number): boolean {
  return ADMIN_IDS.has(telegramId);
}

/** The chatbot needs a key; without one the bot offers human support instead. */
export const isChatbotEnabled = config.OPENROUTER_API_KEY.trim().length > 0;
