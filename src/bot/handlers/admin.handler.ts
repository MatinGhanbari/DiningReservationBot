import type { Context, Telegraf } from 'telegraf';
import type { ExtraReplyMessage } from 'telegraf/typings/telegram-types';
import { config } from '../../config/env';
import { copy } from '../../copy/fa';
import type { FeatureKey } from '../../domain/features';
import type { User } from '../../domain/models';
import { findUniversityById } from '../../domain/universities';
import type { ScheduleField, ScheduledJobTiming } from '../../scheduler/scheduler';
import { startOfConfiguredDay } from '../../shared/dates';
import { toAppError } from '../../shared/errors';
import { scopedLogger } from '../../shared/logger';
import { formatJalaliDateTime, formatNumber, toPersianDigits, weekdayByIndex } from '../../shared/persian';
import { requireAdmin } from '../guards';
import {
  BTN,
  adminMenu,
  adminSubMenu,
  adminUserPicker,
  broadcastConfirm,
  clockLabel,
  featureToggles,
  logoutConfirm,
  purgeConfirm,
  scheduleEditor,
  schedulePicker,
  ticketList,
  userActions,
} from '../keyboards';
import { handler, replyHtml, tryReplyHtml, withTyping } from '../reply';
import type { BotServices } from '../services';
import type { AdminOverview } from '../../app/admin.service';

const log = scopedLogger('bot:admin');

/**
 * The operator panel.
 *
 * Every entry point re-checks authorisation rather than trusting that the button
 * was only shown to an admin: a keyboard from an earlier deployment is still in
 * someone's chat history, and its buttons still work.
 *
 * The handlers here are deliberately thin. They ask `AdminService` for data and
 * hand it to `copy`, so nothing in this file knows about SQL, and a screen can be
 * reworded without touching the logic that produces it.
 */

function displayNameOf(user: User): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return name.length === 0 ? 'بی‌نام' : name;
}

function universityNameOf(universityId: number): string {
  return findUniversityById(universityId)?.name ?? 'نامشخص';
}

function autoReserveLabel(user: User): string {
  if (!user.autoReserveEnabled) {
    return 'غیرفعال';
  }

  const days = [...user.autoReserveWeekdays].sort((left, right) => left - right).map(weekdayByIndex);

  return days.length === 0 ? 'فعال (روزی انتخاب نشده)' : `فعال — ${days.join('، ')}`;
}

function formatBytes(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);

  if (mebibytes >= 1) {
    return `${toPersianDigits(mebibytes.toFixed(1))} مگابایت`;
  }

  return `${toPersianDigits((bytes / 1024).toFixed(1))} کیلوبایت`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);

  const parts: string[] = [];

  if (days > 0) {
    parts.push(`${toPersianDigits(days)} روز`);
  }
  if (hours > 0) {
    parts.push(`${toPersianDigits(hours)} ساعت`);
  }

  parts.push(`${toPersianDigits(minutes)} دقیقه`);

  return parts.join(' و ');
}

/** The headline numbers, shared by the panel home and the statistics screen. */
function headlineStats(overview: AdminOverview): string[] {
  return [
    `👥 کاربران: <b>${formatNumber(overview.users)}</b> (${formatNumber(overview.usersToday)} نفر در ۲۴ ساعت گذشته)`,
    `⚙️ رزرو خودکار فعال: <b>${formatNumber(overview.withAutoReserve)}</b>`,
    `🔐 نشست فعال: ${formatNumber(overview.sessions)}`,
    `📮 تیکت باز: <b>${formatNumber(overview.openTickets)}</b>`,
    `✍️ پیام پشتیبانی امروز: ${formatNumber(overview.supportMessagesToday)}`,
    `🤖 پیام چت‌بات امروز: ${formatNumber(overview.chatbotMessagesToday)}`,
    `🎫 کد فراموشی در مخزن: ${formatNumber(overview.forgetCodesPooled)}`,
  ];
}

function systemLines(overview: AdminOverview): string[] {
  return [
    `محیط اجرا: <code>${config.NODE_ENV}</code>`,
    `نسخهٔ Node: <code>${process.version}</code>`,
    `نسخهٔ اسکیمای دیتابیس: ${formatNumber(overview.schemaVersion)}`,
    `حجم دیتابیس: ${formatBytes(overview.databaseBytes)}`,
    `حافظهٔ مصرفی: ${formatBytes(overview.memoryUsedBytes)}`,
    `آپ‌تایم: ${formatUptime(overview.uptimeSeconds)}`,
    `گفت‌وگوهای نیمه‌کاره: ${formatNumber(overview.conversations)}`,
    `چت‌بات: ${overview.chatbotEnabled ? 'فعال' : 'غیرفعال'}`,
    `منطقهٔ زمانی: <code>${config.TZ}</code>`,
    `پنجرهٔ رزرو: ${formatNumber(config.RESERVABLE_DAYS_AHEAD)} روز`,
  ];
}

function alertsOf(overview: AdminOverview): string[] {
  const alerts: string[] = [];

  if (!overview.chatbotEnabled) {
    alerts.push('چت‌بات غیرفعاله چون کلید OpenRouter تنظیم نشده.');
  }

  if (overview.openTickets > 0) {
    alerts.push(`${formatNumber(overview.openTickets)} تیکت پشتیبانی بی‌جواب مونده.`);
  }

  return alerts;
}

async function onPanel(ctx: Context, services: BotServices): Promise<void> {
  const adminId = await requireAdmin(ctx);

  if (adminId === null) {
    return;
  }

  await services.conversations.clear(adminId);

  const overview = await services.admin.overview();

  await replyHtml(ctx, copy.admin.home({ stats: headlineStats(overview), alerts: alertsOf(overview) }), adminMenu());
}

async function onStats(ctx: Context, services: BotServices): Promise<void> {
  if ((await requireAdmin(ctx)) === null) {
    return;
  }

  const overview = await services.admin.overview();

  await replyHtml(
    ctx,
    copy.admin.statsReport({
      lines: [...headlineStats(overview), `💾 حجم دیتابیس: ${formatBytes(overview.databaseBytes)}`],
      updatedAt: formatJalaliDateTime(services.clock.now()),
    }),
    adminSubMenu(),
  );
}

async function onUsers(ctx: Context, services: BotServices): Promise<void> {
  if ((await requireAdmin(ctx)) === null) {
    return;
  }

  const [overview, recent] = await Promise.all([services.admin.overview(), services.admin.recentUsers(5)]);

  const rows = recent.map(user =>
    copy.admin.userRow({
      telegramId: user.telegramId,
      displayName: displayNameOf(user),
      universityName: universityNameOf(user.universityId),
      autoReserve: user.autoReserveEnabled,
    }),
  );

  await replyHtml(
    ctx,
    copy.admin.usersReport({
      total: overview.users,
      activeToday: overview.usersToday,
      withAutoReserve: overview.withAutoReserve,
      rows,
    }),
    recent.length === 0
      ? adminSubMenu()
      : adminUserPicker(recent.map(user => ({ telegramId: user.telegramId, displayName: displayNameOf(user) }))),
  );

  await tryReplyHtml(ctx, copy.admin.hint('برای جست‌وجوی هر کاربر، دستور /user و بعد شناسه یا نام کاربری سماد رو بفرست.'));
}

/** Renders one user's record, reached from the picker, a search, or the command. */
async function showUser(ctx: Context, services: BotServices, actorId: number, query: string): Promise<void> {
  const user = await services.admin.findUser(query);

  if (user === null) {
    await replyHtml(ctx, copy.admin.userNotFound(query), adminSubMenu());
    return;
  }

  await services.conversations.clear(actorId);

  await replyHtml(
    ctx,
    copy.admin.userDetail({
      telegramId: user.telegramId,
      displayName: displayNameOf(user),
      universityName: universityNameOf(user.universityId),
      samadUsername: user.samadUsername,
      autoReserve: autoReserveLabel(user),
      createdAt: formatJalaliDateTime(user.createdAt),
      updatedAt: formatJalaliDateTime(user.updatedAt),
    }),
    userActions(user.telegramId),
  );
}

/** Entered from the wizard, after the admin was asked for a search term. */
export async function handleAdminUserQuery(ctx: Context, services: BotServices, telegramId: number, query: string): Promise<void> {
  await showUser(ctx, services, telegramId, query);
}

/** Entered from the inline picker under the user list. */
async function onShowUser(ctx: Context, services: BotServices, targetId: number): Promise<void> {
  const adminId = await requireAdmin(ctx);

  if (adminId === null) {
    return;
  }

  await showUser(ctx, services, adminId, String(targetId));
}

async function onUserQuery(ctx: Context, services: BotServices): Promise<void> {
  const adminId = await requireAdmin(ctx);

  if (adminId === null) {
    return;
  }

  const query = ctx.message !== undefined && 'text' in ctx.message ? ctx.message.text.slice('/user'.length).trim() : '';

  if (query.length === 0) {
    await services.conversations.set(adminId, { step: 'awaiting-admin-user-query' });
    await replyHtml(ctx, copy.admin.userSearchPrompt(), adminSubMenu());
    return;
  }

  await showUser(ctx, services, adminId, query);
}

async function onLogoutPrompt(ctx: Context, services: BotServices, targetId: number): Promise<void> {
  if ((await requireAdmin(ctx)) === null) {
    return;
  }

  const user = await services.admin.findUser(String(targetId));

  if (user === null) {
    await replyHtml(ctx, copy.admin.userNotFound(String(targetId)), adminSubMenu());
    return;
  }

  await replyHtml(ctx, copy.admin.logoutConfirm(displayNameOf(user)), logoutConfirm(targetId));
}

async function onLogoutConfirm(ctx: Context, services: BotServices, targetId: number): Promise<void> {
  if ((await requireAdmin(ctx)) === null) {
    return;
  }

  const user = await services.admin.findUser(String(targetId));

  if (user === null) {
    await replyHtml(ctx, copy.admin.userNotFound(String(targetId)), adminSubMenu());
    return;
  }

  const displayName = displayNameOf(user);

  await services.admin.logoutUser(targetId);
  await replyHtml(ctx, copy.admin.logoutDone(displayName), adminSubMenu());
}

async function onSupportTickets(ctx: Context, services: BotServices): Promise<void> {
  if ((await requireAdmin(ctx)) === null) {
    return;
  }

  const [open, closed, today, tickets] = await Promise.all([
    services.support.countOpen(),
    services.support.countClosed(),
    services.support.countMessagesSince(startOfConfiguredDay(services.clock.now())),
    services.support.listOpen(5),
  ]);

  const rows = tickets.map(ticket =>
    copy.admin.ticketRow({
      ticketId: ticket.id,
      displayName: ticket.displayName,
      telegramId: ticket.telegramId,
      messageCount: ticket.messageCount,
      lastMessage: ticket.lastMessage,
      updatedAt: formatJalaliDateTime(ticket.updatedAt),
    }),
  );

  await replyHtml(
    ctx,
    copy.admin.supportReport({ open, closed, today, rows }),
    tickets.length === 0 ? adminSubMenu() : ticketList(tickets.map(ticket => ({ id: ticket.id, displayName: ticket.displayName }))),
  );
}

async function onCloseTicket(ctx: Context, services: BotServices, ticketId: number): Promise<void> {
  if ((await requireAdmin(ctx)) === null) {
    return;
  }

  const closed = await services.support.closeTicket(ticketId);

  await replyHtml(ctx, closed ? copy.support.ticketClosed(ticketId) : copy.support.ticketAlreadyClosed(ticketId), adminSubMenu());
}

async function onChatbotReport(ctx: Context, services: BotServices): Promise<void> {
  if ((await requireAdmin(ctx)) === null) {
    return;
  }

  const report = await services.admin.chatbotReport();

  await replyHtml(
    ctx,
    copy.admin.chatbotReport({
      today: report.today,
      week: report.week,
      usersToday: report.usersToday,
      model: config.OPENROUTER_MODEL,
      enabled: services.admin.chatbotAvailable,
      questions: report.questions,
    }),
    adminSubMenu(),
  );
}

async function onFeatures(ctx: Context, services: BotServices): Promise<void> {
  if ((await requireAdmin(ctx)) === null) {
    return;
  }

  const states = await services.features.list();

  await replyHtml(
    ctx,
    copy.admin.featuresReport(states.map(state => copy.admin.featureRow(copy.features.name(state.key), state.enabled))),
    featureToggles(states.map(state => ({ key: state.key, name: copy.features.name(state.key), enabled: state.enabled }))),
  );
}

export async function onToggleFeature(ctx: Context, services: BotServices, key: FeatureKey): Promise<void> {
  if ((await requireAdmin(ctx)) === null) {
    return;
  }

  const enabled = await services.features.isEnabled(key);

  await services.features.setEnabled(key, !enabled);
  await onFeatures(ctx, services);
}

async function onBroadcast(ctx: Context, services: BotServices): Promise<void> {
  const adminId = await requireAdmin(ctx);

  if (adminId === null) {
    return;
  }

  const audience = await services.admin.broadcastAudience();

  await services.conversations.set(adminId, { step: 'awaiting-broadcast-text' });
  await replyHtml(ctx, copy.admin.broadcastPrompt(audience), adminSubMenu());
}

/** Stores the draft and shows the preview. Called by the wizard. */
export async function handleBroadcastText(ctx: Context, services: BotServices, telegramId: number, text: string): Promise<void> {
  const audience = await services.admin.broadcastAudience();

  await services.conversations.set(telegramId, { step: 'awaiting-broadcast-confirm', text });
  await replyHtml(ctx, copy.admin.broadcastConfirm(audience, text), broadcastConfirm());
}

async function onBroadcastSend(ctx: Context, services: BotServices): Promise<void> {
  const adminId = await requireAdmin(ctx);

  if (adminId === null) {
    return;
  }

  const state = await services.conversations.get(adminId);

  if (state === null || state.step !== 'awaiting-broadcast-confirm') {
    await replyHtml(ctx, copy.menu.useButtons(), adminSubMenu());
    return;
  }

  await services.conversations.clear(adminId);
  await tryReplyHtml(ctx, copy.admin.broadcastRunning());

  // The run is deliberately not awaited, and that is the whole point of this
  // shape. A broadcast is one API call per recipient plus the pacing sleep, so
  // it takes minutes by design — far past Telegraf's 90-second handler timeout,
  // which kills the update rather than waiting. Awaiting it here told the admin
  // the send had failed while it was still going, and told them it had
  // finished minutes later; both messages were wrong, and the first one was
  // wrong about the whole run. Detached, the update is short and the run
  // reports itself when it is actually done.
  //
  // The typing indicator goes with it: `withTyping` wraps the run, not the
  // reply, and it is the only sign in that chat that the run is still alive.
  void withTyping(ctx, () => services.admin.broadcast(state.text))
    .then(result => tryReplyHtml(ctx, copy.admin.broadcastDone(result), adminSubMenu()))
    .catch(async error => {
      // Same contract as the `handler()` wrapper this no longer runs inside:
      // an expected failure keeps its own Persian message.
      const appError = toAppError(error);

      log.error({ err: error, telegramId: adminId, code: appError.code }, 'broadcast failed');

      await tryReplyHtml(ctx, appError.userMessage, adminSubMenu());
    });
}

async function onBroadcastCancel(ctx: Context, services: BotServices): Promise<void> {
  const adminId = await requireAdmin(ctx);

  if (adminId === null) {
    return;
  }

  await services.conversations.clear(adminId);
  await replyHtml(ctx, copy.menu.chooseOption(), adminMenu());
}

async function onSystem(ctx: Context, services: BotServices): Promise<void> {
  if ((await requireAdmin(ctx)) === null) {
    return;
  }

  const overview = await services.admin.overview();

  await replyHtml(ctx, copy.admin.systemReport({ lines: systemLines(overview) }), adminSubMenu());
}

/** A scheduled job whose hour and minute the panel can set. */
type EditableJob = ScheduledJobTiming & { hour: number; minute: number };

function editableJobOf(services: BotServices, name: string): EditableJob | null {
  const job = services.admin.schedule().find(entry => entry.name === name);

  if (job === undefined || job.hour === null || job.minute === null) {
    return null;
  }

  return { ...job, hour: job.hour, minute: job.minute };
}

/** The schedule report, plus the picker that leads to each job's stepper. */
function scheduleScreen(services: BotServices): { text: string; extra: ExtraReplyMessage } {
  const now = services.clock.now();
  const jobs = services.admin.schedule();

  const rows = jobs.map(job =>
    copy.admin.scheduleRow({
      name: copy.admin.scheduleJobName(job.name),
      expression: job.expression,
      nextRun: job.nextRunAt === null ? copy.admin.scheduleUnknown() : formatJalaliDateTime(job.nextRunAt),
      countdown: job.nextRunAt === null ? null : copy.admin.countdown(job.nextRunAt.getTime() - now.getTime()),
    }),
  );

  const editable = jobs.filter((job): job is EditableJob => job.hour !== null && job.minute !== null);

  return {
    text: copy.admin.scheduleReport({
      rows,
      updatedAt: formatJalaliDateTime(now),
      timezone: config.TZ,
      pickHint: editable.length === 0 ? null : copy.admin.schedulePickHint(),
    }),
    extra:
      editable.length === 0
        ? adminSubMenu()
        : schedulePicker(
            editable.map(job => ({
              name: job.name,
              label: copy.admin.schedulePickLabel(copy.admin.scheduleJobName(job.name), clockLabel(job.hour, job.minute)),
            })),
          ),
  };
}

/**
 * Re-draws the message a button was pressed on.
 *
 * Editing rather than sending is what keeps a stepper usable: holding an arrow
 * would otherwise leave sixty messages behind. A failure is logged and dropped
 * because the new value is already stored — not being able to re-draw the screen
 * is a rendering problem, not a lost setting.
 */
async function editHtml(ctx: Context, html: string, extra: ExtraEditMessageText): Promise<void> {
  try {
    await ctx.editMessageText(html, { parse_mode: 'HTML', ...extra });
  } catch (error) {
    log.warn({ err: error, telegramId: ctx.from?.id }, 'could not re-render the schedule screen');
  }
}

async function renderScheduleEditor(ctx: Context, services: BotServices, job: EditableJob): Promise<void> {
  const now = services.clock.now();

  await editHtml(
    ctx,
    copy.admin.scheduleEditor({
      name: copy.admin.scheduleJobName(job.name),
      nextRun: job.nextRunAt === null ? copy.admin.scheduleUnknown() : formatJalaliDateTime(job.nextRunAt),
      countdown: job.nextRunAt === null ? null : copy.admin.countdown(job.nextRunAt.getTime() - now.getTime()),
      custom: job.isCustom,
    }),
    scheduleEditor({ job: job.name, hour: job.hour, minute: job.minute, custom: job.isCustom }),
  );
}

/**
 * Runs an admin action against a job whose time is editable.
 *
 * The job is resolved from the live schedule rather than trusted from the
 * button: an inline keyboard from an earlier deployment is still tappable, and a
 * job that runs on a step has no clock time to nudge.
 */
async function withEditableJob(
  ctx: Context,
  services: BotServices,
  jobName: string,
  action: (() => Promise<void>) | null,
): Promise<void> {
  if ((await requireAdmin(ctx)) === null) {
    return;
  }

  if (editableJobOf(services, jobName) === null) {
    await replyHtml(ctx, copy.admin.scheduleNotEditable(), adminSubMenu());
    return;
  }

  if (action !== null) {
    await action();
  }

  // Read again after the action: the screen exists to show the time it now has.
  const updated = editableJobOf(services, jobName);

  if (updated !== null) {
    await renderScheduleEditor(ctx, services, updated);
  }
}

async function onSchedule(ctx: Context, services: BotServices): Promise<void> {
  if ((await requireAdmin(ctx)) === null) {
    return;
  }

  const { text, extra } = scheduleScreen(services);

  await replyHtml(ctx, text, extra);
}

/** The same report, re-drawn on the message the «برگشت» button was pressed on. */
async function onScheduleList(ctx: Context, services: BotServices): Promise<void> {
  if ((await requireAdmin(ctx)) === null) {
    return;
  }

  const { text, extra } = scheduleScreen(services);

  await editHtml(ctx, text, extra);
}

async function onScheduleEdit(ctx: Context, services: BotServices, jobName: string): Promise<void> {
  await withEditableJob(ctx, services, jobName, null);
}

async function onScheduleStep(
  ctx: Context,
  services: BotServices,
  jobName: string,
  field: ScheduleField,
  delta: number,
): Promise<void> {
  await withEditableJob(ctx, services, jobName, async () => {
    await services.admin.stepScheduleTime(jobName, field, delta);
  });
}

async function onScheduleReset(ctx: Context, services: BotServices, jobName: string): Promise<void> {
  await withEditableJob(ctx, services, jobName, async () => {
    await services.admin.resetScheduleTime(jobName);
  });
}

async function onMaintenance(ctx: Context): Promise<void> {
  if ((await requireAdmin(ctx)) === null) {
    return;
  }

  await replyHtml(ctx, copy.admin.maintenanceIntro(), purgeConfirm());
}

async function onPurge(ctx: Context, services: BotServices): Promise<void> {
  if ((await requireAdmin(ctx)) === null) {
    return;
  }

  const result = await withTyping(ctx, () => services.admin.runMaintenance());

  await replyHtml(
    ctx,
    copy.admin.purgeDone(result.purgedForgetCodes, result.sweptSessions, result.sweptConversations, result.purgedChatbotMessages),
    adminSubMenu(),
  );
}

async function onBackup(ctx: Context, services: BotServices): Promise<void> {
  const adminId = await requireAdmin(ctx);

  if (adminId === null) {
    return;
  }

  await replyHtml(ctx, copy.admin.backupIntro(), adminSubMenu());

  try {
    const result = await withTyping(ctx, () => services.admin.sendBackup(adminId, copy.admin.backupCaption()));

    await replyHtml(ctx, copy.admin.backupDone(formatBytes(result.sizeBytes), result.users), adminSubMenu());
  } catch (error) {
    log.error({ err: error, adminId }, 'backup failed');

    await replyHtml(ctx, copy.admin.backupFailed(error instanceof Error ? error.message : 'خطای ناشناخته'), adminSubMenu());
  }
}

export function registerAdminHandlers(bot: Telegraf, services: BotServices): void {
  bot.command(
    'admin',
    handler('admin-panel', ctx => onPanel(ctx, services)),
  );
  bot.command(
    'user',
    handler('admin-user-command', ctx => onUserQuery(ctx, services)),
  );

  bot.hears(
    BTN.adminPanel,
    handler('admin-panel', ctx => onPanel(ctx, services)),
  );
  bot.hears(
    BTN.adminBack,
    handler('admin-back', ctx => onPanel(ctx, services)),
  );
  bot.hears(
    BTN.adminStats,
    handler('admin-stats', ctx => onStats(ctx, services)),
  );
  bot.hears(
    BTN.adminUsers,
    handler('admin-users', ctx => onUsers(ctx, services)),
  );
  bot.hears(
    BTN.adminSupport,
    handler('admin-support', ctx => onSupportTickets(ctx, services)),
  );
  bot.hears(
    BTN.adminChatbot,
    handler('admin-chatbot', ctx => onChatbotReport(ctx, services)),
  );
  bot.hears(
    BTN.adminFeatures,
    handler('admin-features', ctx => onFeatures(ctx, services)),
  );
  bot.hears(
    BTN.adminBroadcast,
    handler('admin-broadcast', ctx => onBroadcast(ctx, services)),
  );
  bot.hears(
    BTN.adminSystem,
    handler('admin-system', ctx => onSystem(ctx, services)),
  );
  bot.hears(
    BTN.adminSchedule,
    handler('admin-schedule', ctx => onSchedule(ctx, services)),
  );
  bot.hears(
    BTN.adminMaintenance,
    handler('admin-maintenance', ctx => onMaintenance(ctx)),
  );
  bot.hears(
    BTN.adminBackup,
    handler('admin-backup', ctx => onBackup(ctx, services)),
  );
}

export {
  onShowUser,
  onLogoutPrompt,
  onLogoutConfirm,
  onCloseTicket,
  onBroadcastSend,
  onBroadcastCancel,
  onPurge,
  onScheduleList,
  onScheduleEdit,
  onScheduleStep,
  onScheduleReset,
};
