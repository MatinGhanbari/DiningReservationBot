import { Telegraf, type Context } from 'telegraf';
import { copy } from '../copy/fa';
import { scopedLogger } from '../shared/logger';
import { decodeCallback } from './callback-data';
import { registerAutoReserveHandlers, handleDayToggle, handleSelfChoice } from './handlers/auto-reserve.handler';
import {
  registerForgetCodeHandlers,
  handleReceiveSelf,
  handleShareConfirm,
  handleShareTarget,
} from './handlers/forget-code.handler';
import { registerMenuHandlers } from './handlers/menu.handler';
import {
  registerReservationHandlers,
  handleReserveMeal,
  handleSelfSelection,
  handleShowReserves,
  handleWeekSelection,
} from './handlers/reservation.handler';
import { createTextWizard, handleUniversitySelection, registerStartHandlers } from './handlers/start.handler';
import { handler, replyHtml } from './reply';
import type { BotServices } from './services';

const log = scopedLogger('bot');

/**
 * Wires Telegram updates to the application layer.
 *
 * Middleware order is the whole design here, and it is load-bearing:
 *
 *   1. Commands — `/start` and friends always win.
 *   2. The login wizard — an active flow claims the message it asked for.
 *   3. Menu buttons — `bot.hears` for each reply-keyboard label.
 *   4. Inline buttons — one dispatcher for every callback query.
 *   5. Fallback — only reached when nothing above matched.
 *
 * The original bot registered these in a different order and had two separate
 * catch-alls, which is why a half-finished login could swallow unrelated
 * messages and why several buttons produced no reply at all.
 */
export class TelegramBot {
  private readonly bot: Telegraf;

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
    this.registerMiddleware();
    this.registerErrorHandler();
  }

  private registerMiddleware(): void {
    const { bot, services } = this;

    // 1 — commands, plus the reply-keyboard handlers that share their behaviour.
    registerStartHandlers(bot, services);

    // 2 — the wizard, before any button handler can claim its message.
    bot.on('text', createTextWizard(services));

    // 3 — menu buttons.
    registerReservationHandlers(bot, services);
    registerForgetCodeHandlers(bot, services);
    registerAutoReserveHandlers(bot, services);
    registerMenuHandlers(bot, services);

    // 4 — inline buttons.
    bot.on('callback_query', handler('callback', ctx => this.dispatchCallback(ctx)));
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
      log.error({ err: error, telegramId: ctx.from?.id }, 'unhandled bot error');

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
        await handleReserveMeal(ctx, services, action.programId, action.foodTypeId);
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
    }
  }

  /**
   * Starts long polling.
   *
   * `dropPendingUpdates` matters after a redeploy: without it Telegram replays
   * every message that arrived while the bot was down, and users get a burst of
   * stale replies.
   */
  async start(): Promise<void> {
    await this.bot.launch({ dropPendingUpdates: true });

    // `botInfo` is populated by launch, but is typed as optional.
    const identity = this.bot.botInfo;
    log.info({ username: identity?.username, id: identity?.id }, 'bot is listening');
  }

  /** Stops polling and waits for in-flight updates to finish. */
  async stop(reason: string): Promise<void> {
    log.info({ reason }, 'stopping bot');
    this.bot.stop(reason);
  }

  /** Exposed for tests, which drive updates through the middleware chain directly. */
  get instance(): Telegraf {
    return this.bot;
  }
}
