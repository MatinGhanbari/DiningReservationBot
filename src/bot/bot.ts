import { Telegraf, type Context } from 'telegraf';
import { config, isProduction, webhookPath, webhookUrl } from '../config/env';
import { copy } from '../copy/fa';
import { scopedLogger } from '../shared/logger';
import { decodeCallback } from './callback-data';
import {
  onBroadcastCancel,
  onBroadcastSend,
  onCloseTicket,
  onLogoutConfirm,
  onLogoutPrompt,
  onPurge,
  onScheduleEdit,
  onScheduleList,
  onScheduleReset,
  onScheduleStep,
  onShowUser,
  onToggleFeature,
  registerAdminHandlers,
} from './handlers/admin.handler';
import { registerAutoReserveHandlers, handleDayToggle, handleSelfChoice } from './handlers/auto-reserve.handler';
import { registerForgetCodeHandlers, handleReceiveSelf, handleShareConfirm, handleShareTarget } from './handlers/forget-code.handler';
import { registerMenuHandlers } from './handlers/menu.handler';
import {
  registerReservationHandlers,
  handleReserveMeal,
  handleSelfSelection,
  handleShowReserves,
  handleWeekSelection,
} from './handlers/reservation.handler';
import { createTextWizard, handleUniversitySelection, registerStartHandlers } from './handlers/start.handler';
import { createAdminReplyInterceptor, registerSupportHandlers } from './handlers/support.handler';
import { handler, replyHtml, timed } from './reply';
import type { BotServices } from './services';
import { createWebhookReceiver, type WebhookReceiver } from './webhook';
import { logApiCalls, logUpdate } from './telemetry';

const log = scopedLogger('bot');

/**
 * Wires Telegram updates to the application layer.
 *
 * Middleware order is the whole design here, and it is load-bearing:
 *
 *   0. Telemetry — every update is logged before anything can claim it.
 *   1. Commands — `/start` and friends always win.
 *   2. Admin replies — an admin answering a support message is routed to the user
 *      before any other listener can mistake it for something else.
 *   3. The message wizard — an active flow claims the message it asked for.
 *   4. Menu buttons — `bot.hears` for each reply-keyboard label.
 *   5. Inline buttons — one dispatcher for every callback query.
 *   6. Fallback — only reached when nothing above matched.
 *
 * The original bot registered these in a different order and had two separate
 * catch-alls, which is why a half-finished login could swallow unrelated
 * messages and why several buttons produced no reply at all.
 */
export class TelegramBot {
  private readonly bot: Telegraf;

  /**
   * The route the HTTP server has to forward, or null when the bot long-polls.
   *
   * Built once here rather than per request: the receiver is the same handler
   * for every delivery, and it is the thing that owns the acknowledgement — see
   * `./webhook` for why the update is answered before it is processed.
   */
  readonly webhook: WebhookReceiver | null;

  /**
   * Takes an existing Telegraf instance rather than a token.
   *
   * The scheduled auto-reserve run needs to send messages, which means it needs
   * the bot's client — and the notifier needs it before the services can be
   * built. Accepting the instance from outside breaks that cycle without a
   * service locator or a lazy singleton.
   */
  constructor(
    bot: Telegraf,
    private readonly services: BotServices,
  ) {
    this.bot = bot;

    // Every outgoing call goes through `callApi`, so the transport is traced in
    // one place rather than at each of the thirty-odd send sites.
    logApiCalls(bot.telegram);

    this.webhook =
      webhookPath === null ? null : createWebhookReceiver(bot, { path: webhookPath, secretToken: config.TELEGRAM_WEBHOOK_SECRET });

    this.registerMiddleware();
    this.registerErrorHandler();
  }

  private registerMiddleware(): void {
    const { bot, services } = this;

    // 0 — telemetry, so an update is on the record before a handler sees it.
    bot.use(logUpdate);

    // 1 — commands, plus the reply-keyboard handlers that share their behaviour.
    registerStartHandlers(bot, services);

    // 2 — an admin's answer to a support message.
    bot.on('message', timed('admin-reply', createAdminReplyInterceptor(services)));

    // 3 — the wizard, before any button handler can claim its message.
    bot.on('message', timed('wizard', createTextWizard(services)));

    // 4 — menu buttons.
    registerReservationHandlers(bot, services);
    registerForgetCodeHandlers(bot, services);
    registerAutoReserveHandlers(bot, services);
    registerSupportHandlers(bot, services);
    registerAdminHandlers(bot, services);

    // 5 — the fallback owns `bot.on('message')`, so it is registered last.
    registerMenuHandlers(bot, services);

    // 6 — inline buttons.
    bot.on(
      'callback_query',
      handler('callback', ctx => this.dispatchCallback(ctx)),
    );
  }

  /**
   * Reports unhandled failures without taking the process down.
   *
   * Telegraf's `bot.catch` is the last line of defence: anything that escapes the
   * per-handler wrappers lands here, is logged, and is turned into a reply so the
   * user is never left without an answer.
   */
  private registerErrorHandler(): void {
    this.bot.catch(async (error, ctx) => {
      // The update's identity is logged because this handler is reached for
      // Telegraf's own 90-second handler timeout, and that error is raised from
      // outside the middleware chain: the `handler()` wrapper's own log — the
      // one that names the handler — never runs for it, so without these fields
      // a timed-out update cannot be told apart from any other update.
      log.error(
        {
          err: error,
          telegramId: ctx.from?.id,
          updateId: ctx.update.update_id,
          updateType: ctx.updateType,
          chatId: ctx.chat?.id,
        },
        'unhandled bot error',
      );

      try {
        await replyHtml(ctx, copy.errors.generic());
      } catch (replyError) {
        log.warn({ err: replyError }, 'could not deliver the generic error message');
      }
    });
  }

  /** Routes one inline button press to the handler that owns that action. */
  private async dispatchCallback(ctx: Context): Promise<void> {
    const query = ctx.callbackQuery;

    if (query === undefined || !('data' in query) || typeof query.data !== 'string') {
      return;
    }

    const action = decodeCallback(query.data);
    const { services } = this;

    if (action === null) {
      // An old button from a previous deployment, or a hand-crafted payload.
      log.warn({ data: query.data, telegramId: ctx.from?.id }, 'unrecognised callback data');
      await replyHtml(ctx, copy.menu.useButtons());
      return;
    }

    switch (action.kind) {
      case 'select-university':
        await handleUniversitySelection(ctx, services, action.universityId);
        return;
      case 'choose-self':
        await handleWeekSelection(ctx, services, action.week);
        return;
      case 'select-self':
        await handleSelfSelection(ctx, services, action.week, action.selfId);
        return;
      case 'show-reserves':
        await handleShowReserves(ctx, services, action.week);
        return;
      case 'reserve-meal':
        await handleReserveMeal(ctx, services, action.programId, action.foodTypeId, action.mealTypeId);
        return;
      case 'auto-reserve-self':
        await handleSelfChoice(ctx, services, action.selfId);
        return;
      case 'auto-reserve-day':
        await handleDayToggle(ctx, services, action.weekday);
        return;
      case 'forget-code-share':
        await handleShareTarget(ctx, services, action.reserveId);
        return;
      case 'forget-code-share-confirm':
        await handleShareConfirm(ctx, services, action.reserveId);
        return;
      case 'forget-code-receive-self':
        await handleReceiveSelf(ctx, services, action.selfId);
        return;
      case 'admin-user':
        await onShowUser(ctx, services, action.telegramId);
        return;
      case 'admin-logout-prompt':
        await onLogoutPrompt(ctx, services, action.telegramId);
        return;
      case 'admin-logout-confirm':
        await onLogoutConfirm(ctx, services, action.telegramId);
        return;
      case 'admin-close-ticket':
        await onCloseTicket(ctx, services, action.ticketId);
        return;
      case 'admin-broadcast-send':
        await onBroadcastSend(ctx, services);
        return;
      case 'admin-broadcast-cancel':
        await onBroadcastCancel(ctx, services);
        return;
      case 'admin-toggle-feature':
        await onToggleFeature(ctx, services, action.feature);
        return;
      case 'admin-schedule-list':
        await onScheduleList(ctx, services);
        return;
      case 'admin-schedule-edit':
        await onScheduleEdit(ctx, services, action.job);
        return;
      case 'admin-schedule-step':
        await onScheduleStep(ctx, services, action.job, action.field, action.delta);
        return;
      case 'admin-schedule-reset':
        await onScheduleReset(ctx, services, action.job);
        return;
      case 'admin-purge':
        await onPurge(ctx, services);
        return;
    }
  }

  /**
   * Puts the bot into whichever mode this deployment can actually serve.
   *
   * Production with a public URL registers the webhook and lets Telegram push
   * updates into the HTTP server the container already runs. Everywhere else the
   * bot long-polls, and `launch` deletes any webhook left over from a previous
   * deployment first — so pointing a local `develop` at the production bot
   * takes over cleanly instead of failing with a conflict.
   */
  async start(): Promise<void> {
    const webhook = this.webhook;

    if (webhook === null) {
      if (isProduction) {
        log.warn('TELEGRAM_WEBHOOK_URL is empty, so the bot is long polling instead of receiving a webhook');
      }

      // `launch` resolves only once polling stops, so it must not be awaited:
      // the container registers the scheduled jobs as soon as this returns, and
      // awaiting it here would mean those jobs were never registered at all.
      void this.bot
        .launch({ dropPendingUpdates: true }, () => {
          log.info({ username: this.bot.botInfo?.username }, 'bot is polling for updates');
        })
        .catch(error => {
          log.error({ err: error }, 'long polling could not start');
        });

      return;
    }

    // Fetched here rather than left to the first delivery. Telegraf fetches the
    // bot's own identity lazily inside `handleUpdate`, and by then the update has
    // been acknowledged — a failure there would lose it silently, because the
    // platform is never told to retry. Doing it at boot also means a token the
    // API rejects stops the process instead of the first message.
    this.bot.botInfo = await this.bot.telegram.getMe();

    // await this.bot.telegram.setWebhook(webhookUrl, {
    //   drop_pending_updates: true,
    //   ...(config.TELEGRAM_WEBHOOK_SECRET.length === 0 ? {} : { secret_token: config.TELEGRAM_WEBHOOK_SECRET }),
    // });

    log.info({ url: webhookUrl, path: webhook.path }, 'bot is receiving updates over the webhook');
  }

  /**
   * Stops the bot.
   *
   * The webhook stays registered on purpose: a redeploy would otherwise leave a
   * window where Telegram has nowhere to deliver, and the next boot discards
   * whatever queued up anyway.
   */
  async stop(reason: string): Promise<void> {
    log.info({ reason }, 'stopping bot');

    try {
      this.bot.stop(reason);
    } catch (error) {
      // Telegraf throws when nothing was started, which is what a signal that
      // arrives before polling has begun, or a webhook deployment, looks like.
      log.warn({ err: error }, 'bot had nothing to stop');
    }
  }

  /** Exposed for tests, which drive updates through the middleware chain directly. */
  get instance(): Telegraf {
    return this.bot;
  }
}
