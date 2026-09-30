import { Telegraf } from 'telegraf';
import { AdminService } from './app/admin.service';
import { AutoReserveService } from './app/auto-reserve.service';
import { AuthService } from './app/auth.service';
import { ChatbotService } from './app/chatbot.service';
import { CreditWatchService } from './app/credit-watch.service';
import { FeatureService } from './app/feature.service';
import { ForgetCodeService } from './app/forget-code.service';
import { ReservationService } from './app/reservation.service';
import { SessionService } from './app/session.service';
import { SupportService } from './app/support.service';
import { TelegramBot } from './bot/bot';
import { TelegramNotifier } from './bot/notifier';
import type { BotServices } from './bot/services';
import { MemoryConversationStore } from './bot/state';
import { MemorySessionStore } from './cache/session.store';
import { config, isChatbotEnabled } from './config/env';
import { copy } from './copy/fa';
import { AesSecretBox } from './crypto/secret-box';
import { RedisChatbotRepository } from './db/redis/chatbot.repository';
import { RedisForgetCodeReportRepository, RedisForgetCodeRepository } from './db/redis/forget-code.repository';
import { RedisFeatureRepository, RedisSettingsRepository } from './db/redis/keyvalue.repository';
import { RedisStore } from './db/redis/store';
import { RedisSupportRepository } from './db/redis/support.repository';
import { RedisSystemProbe } from './db/redis/system.probe';
import { RedisUserRepository } from './db/redis/user.repository';
import { HealthServer, type HealthReport } from './http/health';
import { SamadHttpClient } from './samad/client';
import { SamadApiGateway } from './samad/gateway';
import { Scheduler, type ScheduledJob } from './scheduler/scheduler';
import { SystemClock } from './shared/clock';
import { scopedLogger } from './shared/logger';
import { formatJalaliDateTime } from './shared/persian';
import { SECOND } from './shared/time';
import { OpenRouterAssistant } from './support/openrouter.client';
import https from 'node:https';

const log = scopedLogger('container');

/**
 * How long a shutdown waits for the updates that are already being processed.
 *
 * Bounded rather than open-ended because the process has a deadline of its own:
 * `main.ts` exits after eight seconds and Docker sends SIGKILL after ten. What
 * is left when the deadline passes is logged by the receiver, and the database
 * is closed either way.
 */
const UPDATE_DRAIN_MS = 3 * SECOND;

export interface Container {
  store: RedisStore;
  bot: TelegramBot;
  scheduler: Scheduler;
  health: HealthServer;
  /** Brings up health, the bot and the scheduler, in that order. */
  start: () => Promise<void>;
  /** Ordered shutdown: stop taking work, then close what holds resources. */
  shutdown: (reason: string) => Promise<void>;
}

/**
 * The composition root.
 *
 * Every dependency is constructed here, explicitly, in one file. Nothing else in
 * the codebase reaches for a global or constructs its own collaborator, which is
 * what makes the rest of it testable: a test builds the pieces it needs and wires
 * them the same way this function does.
 *
 * The original project had services instantiating each other inside their own
 * constructors, which is how `AuthService` and `UserService` ended up in a
 * dependency cycle that neither could be tested around.
 */
export function createContainer(): Container {
  // ── Infrastructure ────────────────────────────────────────────────────────

  const store = new RedisStore({ url: config.REDIS_URL, prefix: config.REDIS_KEY_PREFIX });
  const redis = store.client;

  const clock = new SystemClock();
  const secretBox = new AesSecretBox(config.ENCRYPTION_KEY);

  const users = new RedisUserRepository(store, redis);
  const forgetCodes = new RedisForgetCodeRepository(store, redis);
  const forgetCodeReports = new RedisForgetCodeReportRepository(store, redis);
  const supportTickets = new RedisSupportRepository(store, redis);
  const chatbotMessages = new RedisChatbotRepository(store, redis);
  const featureFlags = new RedisFeatureRepository(store, redis);
  const settings = new RedisSettingsRepository(store, redis);
  const system = new RedisSystemProbe(store, redis);

  const sessions = new MemorySessionStore(clock);
  const conversations = new MemoryConversationStore(clock);

  const samadHttp = new SamadHttpClient({
    timeoutMs: config.SAMAD_TIMEOUT_MS,
    maxRetries: config.SAMAD_MAX_RETRIES,
    logger: scopedLogger('samad'),
    verifyTls: config.SAMAD_TLS_VERIFY,
  });
  const gateway = new SamadApiGateway(samadHttp, config.RESERVABLE_DAYS_AHEAD);

  // The chatbot is optional: with no key configured the feature is hidden rather
  // than broken, and `null` is what makes that a compile-time fact everywhere it
  // is consumed.
  const assistant = isChatbotEnabled
    ? new OpenRouterAssistant({
        apiKey: config.OPENROUTER_API_KEY,
        baseUrl: config.OPENROUTER_BASE_URL,
        model: config.OPENROUTER_MODEL,
        timeoutMs: config.OPENROUTER_TIMEOUT_MS,
      })
    : null;

  // ── Application ───────────────────────────────────────────────────────────

  const sessionService = new SessionService(users, sessions, gateway, secretBox, clock);
  const auth = new AuthService(users, gateway, secretBox, sessionService, clock);
  const reservations = new ReservationService(users, gateway, sessionService, clock);
  const forgetCodeService = new ForgetCodeService(forgetCodes, forgetCodeReports, users, reservations, gateway, sessionService, clock);
  const features = new FeatureService(featureFlags);

  // ── Presentation ──────────────────────────────────────────────────────────

  const noKeepAliveAgent = new https.Agent({
    keepAlive: false,
  });

  const telegram = new Telegraf(config.BOT_TOKEN, { telegram: { apiRoot: config.TELEGRAM_API_ROOT, agent: noKeepAliveAgent } });
  const notifier = new TelegramNotifier(telegram, config.ADMINS);

  const autoReserve = new AutoReserveService(users, reservations, notifier, clock);
  const creditWatch = new CreditWatchService(users, reservations, notifier, clock);
  const support = new SupportService(supportTickets, notifier);
  const chatbot = new ChatbotService(assistant, chatbotMessages, clock);

  // Built here rather than in the scheduled-work section below because the admin
  // panel reports on it, and because it holds the time overrides an admin sets.
  // The jobs themselves are registered at start-up.
  const scheduler = new Scheduler(settings);

  const admin = new AdminService(
    users,
    support,
    chatbot,
    chatbotMessages,
    forgetCodes,
    forgetCodeService,
    sessions,
    conversations,
    auth,
    system,
    notifier,
    scheduler,
  );

  const services: BotServices = {
    auth,
    reservations,
    forgetCodes: forgetCodeService,
    autoReserve,
    creditWatch,
    support,
    chatbot,
    admin,
    features,
    messenger: notifier,
    conversations,
    clock,
  };

  const bot = new TelegramBot(telegram, services);

  // ── Health ────────────────────────────────────────────────────────────────

  const health = new HealthServer({
    port: config.PORT,
    // In production the same listener also takes Telegram's deliveries, so the
    // container needs exactly one port open to the outside world.
    webhook: bot.webhook ?? undefined,
    check: async (): Promise<HealthReport> => {
      // A real query, not just "is the socket open": a connection to a Redis that
      // has been flushed or replaced is still open and still useless.
      const userCount = await users.count();

      return {
        status: 'ok',
        uptimeSeconds: Math.round(process.uptime()),
        details: {
          database: 'ok',
          users: userCount,
          sessions: sessionService.sessionCount(),
          conversations: conversations.size(),
          openTickets: await support.countOpen(),
        },
      };
    },
  });

  // ── Scheduled work ────────────────────────────────────────────────────────

  // The expressions here are defaults, not the last word: an admin can set the
  // hour and minute of a job from the panel, and the stored time wins until it
  // is dropped. See `Scheduler.start`.
  const jobs: ScheduledJob[] = [
    {
      name: 'auto-reserve',
      defaultExpression: config.AUTO_RESERVE_CRON,
      run: async () => {
        await autoReserve.runDaily();
      },
    },
    {
      name: 'credit-watch',
      // The evening before the next window opens, so there is still time to pay.
      defaultExpression: config.CREDIT_CHECK_CRON,
      run: async () => {
        await creditWatch.runDaily();
      },
    },
    {
      name: 'maintenance',
      // Every six hours: often enough to keep memory flat, rare enough to be free.
      defaultExpression: '17 */6 * * *',
      run: async () => {
        await admin.runMaintenance();
      },
    },
  ];

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  let shuttingDown = false;

  /**
   * Tells the admins the deployment came up.
   *
   * Every failure is swallowed on purpose: an admin who blocked the bot, or a
   * Telegram outage at boot, must not turn a working deployment into a crash
   * loop. `send` already logs what went wrong.
   */
  const announceStartup = async (): Promise<void> => {
    const text = copy.startup.running({ env: config.NODE_ENV, startedAt: formatJalaliDateTime(clock.now()) });

    await Promise.all(config.ADMINS.map(adminId => notifier.send(adminId, text)));
  };

  /**
   * Brings the process up in dependency order.
   *
   * Health first, so the container reports itself as starting rather than
   * refusing connections; then the bot; then the scheduler, which must not fire
   * a job before the bot can deliver its result.
   */
  const start = async (): Promise<void> => {
    await health.start();
    await bot.start();
    await scheduler.start(jobs);
    await announceStartup();

    log.info({ env: config.NODE_ENV, port: config.PORT, chatbot: isChatbotEnabled, admins: config.ADMINS.length }, 'application started');
  };

  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    log.info({ reason }, 'shutting down');

    // Order matters: stop accepting new work before closing the resources it uses.
    scheduler.stop();

    await Promise.allSettled([bot.stop(reason), health.stop()]);

    // Updates are acknowledged before they are processed, so nothing else is
    // holding them open: the connection that delivered them is already closed,
    // and without this the database would be shut under work that is still
    // running. The deadline is short because the process is not the only thing
    // on a clock — `main.ts` gives up at eight seconds and Docker sends SIGKILL
    // at ten.
    await bot.webhook?.drain(UPDATE_DRAIN_MS);

    await store.close();

    log.info('shutdown complete');
  };

  return { store, bot, scheduler, health, start, shutdown };
}
