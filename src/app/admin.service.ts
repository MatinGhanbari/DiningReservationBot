import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { config, isChatbotEnabled } from '../config/env';
import type { User } from '../domain/models';
import type { ChatbotRepository, ForgetCodeRepository, SessionStore, SupportMessenger, SystemProbe, UserRepository } from '../domain/ports';
import type { ScheduledJobTiming, ScheduleField, Scheduler } from '../scheduler/scheduler';
import { addDays, startOfConfiguredDay } from '../shared/dates';
import { ValidationError } from '../shared/errors';
import { sanitizeTelegramHtml } from '../shared/sanitize';
import { DAY } from '../shared/time';
import { scopedLogger } from '../shared/logger';
import type { AuthService } from './auth.service';
import type { ChatbotService } from './chatbot.service';
import type { ForgetCodeService } from './forget-code.service';
import type { SupportService } from './support.service';
import type { ConversationStore } from '../bot/state';

const log = scopedLogger('admin');

export interface AdminOverview {
  users: number;
  usersToday: number;
  withAutoReserve: number;
  sessions: number;
  conversations: number;
  openTickets: number;
  supportMessagesToday: number;
  chatbotMessagesToday: number;
  chatbotUsersToday: number;
  forgetCodesPooled: number;
  schemaVersion: number;
  databaseBytes: number;
  uptimeSeconds: number;
  memoryUsedBytes: number;
  chatbotEnabled: boolean;
}

export interface MaintenanceResult {
  purgedForgetCodes: number;
  sweptSessions: number;
  sweptConversations: number;
  purgedChatbotMessages: number;
}

export interface BroadcastResult {
  sent: number;
  failed: number;
}

/**
 * Everything an operator needs, gathered in one place.
 *
 * This exists so the admin handlers stay declarative: they ask for data and
 * render it, and never reach into a repository or the database themselves. That
 * boundary is what keeps the panel from becoming the place where unrelated
 * concerns accumulate.
 */
export class AdminService {
  constructor(
    private readonly users: UserRepository,
    private readonly support: SupportService,
    private readonly chatbot: ChatbotService,
    private readonly chatbotMessages: ChatbotRepository,
    private readonly forgetCodes: ForgetCodeRepository,
    private readonly forgetCodeService: ForgetCodeService,
    private readonly sessions: SessionStore,
    private readonly conversations: ConversationStore,
    private readonly auth: AuthService,
    private readonly system: SystemProbe,
    private readonly messenger: SupportMessenger,
    private readonly scheduler: Scheduler,
  ) {}

  async overview(): Promise<AdminOverview> {
    const dayStart = startOfConfiguredDay();

    const [
      users,
      usersToday,
      withAutoReserve,
      openTickets,
      supportMessagesToday,
      chatbotMessagesToday,
      chatbotUsersToday,
      forgetCodesPooled,
      schemaVersion,
      size,
    ] = await Promise.all([
      this.users.count(),
      this.users.countCreatedSince(dayStart),
      this.users.findAllWithAutoReserveEnabled(),
      this.support.countOpen(),
      this.support.countMessagesSince(dayStart),
      this.chatbotMessages.countSince(dayStart),
      this.chatbotMessages.countUsersSince(dayStart),
      this.forgetCodes.countAllAvailable(),
      this.system.schemaVersion(),
      this.system.size(),
    ]);

    const memory = process.memoryUsage();

    return {
      users,
      usersToday,
      withAutoReserve: withAutoReserve.length,
      sessions: this.sessions.size(),
      conversations: this.conversations.size(),
      openTickets,
      supportMessagesToday,
      chatbotMessagesToday,
      chatbotUsersToday,
      forgetCodesPooled,
      schemaVersion,
      databaseBytes: size.databaseBytes + size.walBytes,
      uptimeSeconds: Math.round(process.uptime()),
      memoryUsedBytes: memory.rss,
      chatbotEnabled: isChatbotEnabled,
    };
  }

  /** When each scheduled job fires next, in the bot's timezone. */
  schedule(): readonly ScheduledJobTiming[] {
    return this.scheduler.upcoming();
  }

  /**
   * Moves one field of a job's time.
   *
   * Stored and applied by the scheduler in one step, so the panel cannot end up
   * showing a time the timer does not use.
   */
  async stepScheduleTime(name: string, field: ScheduleField, delta: number): Promise<void> {
    await this.scheduler.stepTime(name, field, delta);
  }

  /** Puts a job back on the time its configuration gives it. */
  async resetScheduleTime(name: string): Promise<void> {
    await this.scheduler.resetTime(name);
  }

  /**
   * Runs one scheduled job now instead of waiting for its next tick.
   *
   * The job's own function is what runs, so a manual run and a timer run cannot
   * drift apart — and a job that is already running is dropped rather than
   * doubled up, because that guard lives in the job, not here.
   */
  async runScheduleJob(name: string): Promise<void> {
    await this.scheduler.runNow(name);
  }

  /** The most recently created users, newest first. */
  async recentUsers(limit = 5): Promise<readonly User[]> {
    return this.users.list({ limit, offset: 0 });
  }

  /**
   * Finds one user by Telegram id or by Samad username.
   *
   * Both are accepted because an admin usually has one of the two in front of
   * them and should not have to work out which.
   */
  async findUser(query: string): Promise<User | null> {
    const trimmed = query.trim();

    if (/^\d+$/.test(trimmed)) {
      const byId = await this.users.findByTelegramId(Number(trimmed));

      if (byId !== null) {
        return byId;
      }
    }

    return this.users.findBySamadUsername(trimmed);
  }

  /** Unlinks the account and drops the session, the same as the user logging out. */
  async logoutUser(telegramId: number): Promise<void> {
    await this.auth.logout(telegramId);
  }

  async chatbotReport(): Promise<{
    today: number;
    week: number;
    usersToday: number;
    questions: readonly string[];
  }> {
    const dayStart = startOfConfiguredDay();
    const weekStart = addDays(dayStart, -7);

    const [today, week, usersToday, recent] = await Promise.all([
      this.chatbotMessages.countSince(dayStart),
      this.chatbotMessages.countSince(weekStart),
      this.chatbotMessages.countUsersSince(dayStart),
      this.chatbotMessages.recentQuestions(10),
    ]);

    return {
      today,
      week,
      usersToday,
      questions: recent.map(row => row.content),
    };
  }

  /**
   * Removes data nothing can use any more.
   *
   * Every step here is safe to run at any time: expired forget codes, expired
   * cache entries and transcripts past their retention window.
   */
  async runMaintenance(): Promise<MaintenanceResult> {
    const purgedForgetCodes = await this.forgetCodeService.purgeExpired();
    const sweptSessions = this.sessions.sweep();
    const sweptConversations = this.conversations.sweep();

    const cutoff = new Date(Date.now() - config.CHATBOT_RETENTION_DAYS * DAY);
    const purgedChatbotMessages = await this.chatbotMessages.purgeBefore(cutoff);

    const result: MaintenanceResult = {
      purgedForgetCodes,
      sweptSessions,
      sweptConversations,
      purgedChatbotMessages,
    };

    log.info(result, 'maintenance finished');

    return result;
  }

  /**
   * Writes a consistent snapshot of every key to a temporary file and sends it
   * to the admin who asked.
   *
   * The file is removed in a `finally`, so a failed upload does not leave copies
   * of the data lying around in the container.
   */
  async sendBackup(adminTelegramId: number, caption: string): Promise<{ sizeBytes: number; users: number }> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(tmpdir(), `bot-backup-${stamp}.json`);

    try {
      const sizeBytes = await this.system.snapshot(path);
      const users = await this.users.count();

      await this.messenger.sendDocument(adminTelegramId, path, caption);

      return { sizeBytes, users };
    } finally {
      await rm(path, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Sends one message to every user.
   *
   * The markup is reduced to the tags Telegram understands before it goes out.
   * A broadcast is the only message in the system that one person writes and
   * everybody receives, so a stray tag is not a rendering problem — it is a
   * message that either fails for the whole audience or carries whatever the
   * author put in it.
   *
   * Failures are counted rather than thrown: a blocked bot or a deleted account
   * is normal in a list of a few thousand, and aborting the run would leave the
   * remaining users without the message.
   */
  async broadcast(html: string, onProgress?: (sent: number, total: number) => Promise<void>): Promise<BroadcastResult> {
    const safeHtml = sanitizeTelegramHtml(html).trim();

    if (safeHtml.length === 0) {
      throw new ValidationError('Broadcast text was empty after sanitising', 'متن پیام خالی بود. یه متن بنویس و دوباره بفرست.');
    }

    const recipients = await this.users.listAll();

    const result: BroadcastResult = { sent: 0, failed: 0 };

    for (const user of recipients) {
      try {
        const messageId = await this.messenger.send(user.telegramId, safeHtml);
        result.sent += messageId === null ? 0 : 1;
        result.failed += messageId === null ? 1 : 0;
      } catch (error) {
        result.failed += 1;
        log.debug({ err: error, telegramId: user.telegramId }, 'broadcast delivery failed');
      }

      // Telegram allows roughly thirty messages a second; staying under it keeps
      // the bot from being rate limited into a ban.
      await sleep(40);

      if (onProgress !== undefined && (result.sent + result.failed) % 25 === 0) {
        await onProgress(result.sent + result.failed, recipients.length);
      }
    }

    log.info(result, 'broadcast finished');

    return result;
  }

  /** How many people a broadcast would reach. */
  async broadcastAudience(): Promise<number> {
    return this.users.count();
  }

  get chatbotAvailable(): boolean {
    return this.chatbot.available;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}
