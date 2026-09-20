import { Telegraf } from 'telegraf';
import { AutoReserveService } from './app/auto-reserve.service';
import { AuthService } from './app/auth.service';
import { ForgetCodeService } from './app/forget-code.service';
import { ReservationService } from './app/reservation.service';
import { SessionService } from './app/session.service';
import { TelegramBot } from './bot/bot';
import { TelegramNotifier } from './bot/notifier';
import type { BotServices } from './bot/services';
import { MemoryConversationStore } from './bot/state';
import { MemorySessionStore } from './cache/session.store';
import { config } from './config/env';
import { AesSecretBox } from './crypto/secret-box';
import { SqliteForgetCodeReportRepository, SqliteForgetCodeRepository } from './db/forget-code.repository';
import { closeDatabase, openDatabase, type SqliteDatabase } from './db/database';
import { migrate } from './db/migrations';
import { SqliteUserRepository } from './db/user.repository';
import { HealthServer, type HealthReport } from './http/health';
import { SamadHttpClient } from './samad/client';
import { SamadApiGateway } from './samad/gateway';
import { Scheduler, type ScheduledJob } from './scheduler/scheduler';
import { SystemClock } from './shared/clock';
import { scopedLogger } from './shared/logger';

const log = scopedLogger('container');

export interface Container {
  db: SqliteDatabase;
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

  const db = openDatabase();
  migrate(db);

  const clock = new SystemClock();
  const secretBox = new AesSecretBox(config.ENCRYPTION_KEY);

  const users = new SqliteUserRepository(db);
  const forgetCodes = new SqliteForgetCodeRepository(db);
  const forgetCodeReports = new SqliteForgetCodeReportRepository(db);

  const sessions = new MemorySessionStore(clock);
  const conversations = new MemoryConversationStore(clock);

  const samadHttp = new SamadHttpClient({
    timeoutMs: config.SAMAD_TIMEOUT_MS,
    maxRetries: config.SAMAD_MAX_RETRIES,
    logger: scopedLogger('samad'),
  });
  const gateway = new SamadApiGateway(samadHttp, config.RESERVABLE_DAYS_AHEAD);

  // ── Application ───────────────────────────────────────────────────────────

  const sessionService = new SessionService(users, sessions, gateway, secretBox, clock);
  const auth = new AuthService(users, gateway, secretBox, sessionService, clock);
  const reservations = new ReservationService(users, gateway, sessionService, clock);
  const forgetCodeService = new ForgetCodeService(
    forgetCodes,
    forgetCodeReports,
    users,
    reservations,
    gateway,
    sessionService,
    clock,
  );

  // ── Presentation ──────────────────────────────────────────────────────────

  const telegram = new Telegraf(config.BOT_TOKEN);
  const notifier = new TelegramNotifier(telegram);

  const autoReserve = new AutoReserveService(users, reservations, notifier, clock);

  const services: BotServices = {
    auth,
    reservations,
    forgetCodes: forgetCodeService,
    autoReserve,
    conversations,
    clock,
  };

  const bot = new TelegramBot(telegram, services);

  // ── Health ────────────────────────────────────────────────────────────────

  const health = new HealthServer({
    port: config.PORT,
    check: async (): Promise<HealthReport> => {
      // A real query, not just "is the handle open": a database whose file was
      // removed underneath the process is still open and still useless.
      const userCount = await users.count();

      return {
        status: 'ok',
        uptimeSeconds: Math.round(process.uptime()),
        details: {
          database: 'ok',
          users: userCount,
          sessions: sessionService.sessionCount(),
          conversations: conversations.size(),
        },
      };
    },
  });

  // ── Scheduled work ────────────────────────────────────────────────────────

  const scheduler = new Scheduler();

  const jobs: ScheduledJob[] = [
    {
      name: 'auto-reserve',
      expression: config.AUTO_RESERVE_CRON,
      run: async () => {
        await autoReserve.runDaily();
      },
    },
    {
      name: 'maintenance',
      // Every six hours: often enough to keep memory flat, rare enough to be free.
      expression: '17 */6 * * *',
      run: async () => {
        const purgedCodes = await forgetCodeService.purgeExpired();
        const sweptSessions = sessions.sweep();
        const sweptConversations = conversations.sweep();

        log.debug({ purgedCodes, sweptSessions, sweptConversations }, 'maintenance sweep finished');
      },
    },
  ];

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  let shuttingDown = false;

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
    scheduler.start(jobs);

    log.info({ env: config.NODE_ENV, port: config.PORT }, 'application started');
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

    closeDatabase(db);

    log.info('shutdown complete');
  };

  return { db, bot, scheduler, health, start, shutdown };
}
