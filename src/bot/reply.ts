import type { Context, MiddlewareFn } from 'telegraf';
import type { ExtraReplyMessage } from 'telegraf/typings/telegram-types';
import { copy } from '../copy/fa';
import { isAppError, toAppError } from '../shared/errors';
import { scopedLogger } from '../shared/logger';
import { sendTyping } from './typing';

const log = scopedLogger('bot');

/**
 * How long a middleware may run before it is worth a warning.
 *
 * The slowest legitimate path in the bot is a chatbot answer that had to be
 * retried: two 30-second model calls. Anything past this is either an upstream
 * failing slowly or a bug, and both are worth a line naming the middleware
 * before Telegraf's 90-second deadline turns them into a mystery.
 */
const SLOW_MIDDLEWARE_MS = 30_000;

/**
 * Sends a message using Telegram's HTML parse mode.
 *
 * HTML rather than MarkdownV2 on purpose. MarkdownV2 requires escaping eighteen
 * characters, and every food name, dining-hall name and error string that comes
 * from Samad would have to be escaped correctly or Telegram rejects the entire
 * message. HTML needs four characters, and the copy module escapes them at the
 * point where the values are interpolated.
 *
 * The «typing…» indicator is set here rather than at each call site so that no
 * reply can be the one that forgot. It is throttled per chat in `./typing`, so a
 * handler that answers twice in a row pays for one chat action, not two.
 */
export async function replyHtml(ctx: Context, html: string, extra?: ExtraReplyMessage): Promise<void> {
  await sendTyping(ctx);
  await ctx.reply(html, { parse_mode: 'HTML', ...extra });
}

/** Sends a message and swallows transport failures, for best-effort notices. */
export async function tryReplyHtml(ctx: Context, html: string, extra?: ExtraReplyMessage): Promise<void> {
  try {
    await replyHtml(ctx, html, extra);
  } catch (error) {
    log.warn({ err: error }, 'could not deliver message');
  }
}

/**
 * Stops the loading spinner on an inline button.
 *
 * Telegram keeps a tapped button spinning until the callback query is answered.
 * The original code called `answerCbQuery()` in some handlers and not others, so
 * a failure in the middle of a handler left the button spinning forever. Doing it
 * centrally means no handler can forget.
 */
async function answerCallback(ctx: Context): Promise<void> {
  if (ctx.callbackQuery === undefined) {
    return;
  }

  try {
    await ctx.answerCbQuery();
  } catch (error) {
    // Queries expire after a few minutes; an old button in a long chat history
    // is expected to fail here and is not worth reporting.
    log.debug({ err: error }, 'could not answer callback query');
  }
}

/**
 * Wraps a handler with logging, error translation and callback acknowledgement.
 *
 * Every failure reaches the user as a Persian sentence rather than as silence.
 * That was the single biggest usability problem in the original bot: a thrown
 * error inside a handler produced no reply at all, so from the user's side the
 * bot had simply stopped answering.
 */
export function handler(name: string, fn: (ctx: Context) => Promise<void>): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const startedAt = Date.now();

    try {
      await fn(ctx);
    } catch (error) {
      const appError = toAppError(error);

      const context = {
        handler: name,
        code: appError.code,
        telegramId: ctx.from?.id,
        err: error,
        ...appError.context,
      };

      // Expected outcomes — a wrong password, an empty pool — are not incidents.
      if (isAppError(error) && error.code !== 'INTERNAL') {
        log.info({ ...context, err: undefined }, 'handler reported a handled failure');
      } else {
        log.error(context, 'handler failed');
      }

      await tryReplyHtml(ctx, appError.userMessage);
    } finally {
      await answerCallback(ctx);
    }

    reportSlow(name, startedAt, ctx);

    // `next` is accepted for signature compatibility with Telegraf middleware.
    void next;
  };
}

/**
 * Times a pass-through middleware and reports it when it is slow.
 *
 * The two middlewares that run before any handler — the admin reply interceptor
 * and the message wizard — call `next()` instead of ending the chain, so they
 * cannot go through `handler()`. They are the ones that hold a Samad call and a
 * notifier round-trip respectively, which makes them exactly the ones worth
 * naming when an update takes too long.
 */
export function timed(name: string, middleware: MiddlewareFn<Context>): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const startedAt = Date.now();

    try {
      await middleware(ctx, next);
    } finally {
      reportSlow(name, startedAt, ctx);
    }
  };
}

/**
 * Names a middleware that ran for too long.
 *
 * Telegraf raises its handler timeout from outside the middleware chain, so the
 * chain never learns that it was killed: the update carries on running, and by
 * the time this line is written the user has already been sent the generic
 * failure. It is still the only line that says *which* middleware was behind it,
 * and it arrives for the very updates that were killed.
 */
function reportSlow(name: string, startedAt: number, ctx: Context): void {
  const durationMs = Date.now() - startedAt;

  if (durationMs < SLOW_MIDDLEWARE_MS) {
    return;
  }

  log.warn(
    {
      middleware: name,
      durationMs,
      telegramId: ctx.from?.id,
      updateId: ctx.update.update_id,
      updateType: ctx.updateType,
    },
    'middleware is slower than expected',
  );
}

/**
 * Runs a handler that must not interrupt the middleware chain.
 *
 * Used for the catch-all message listener: it inspects every update, and a
 * failure inside it must never stop other handlers from running.
 */
export function nonBlocking(name: string, fn: (ctx: Context) => Promise<void>): MiddlewareFn<Context> {
  return async (ctx, next) => {
    try {
      await fn(ctx);
    } catch (error) {
      log.error({ err: error, handler: name, telegramId: ctx.from?.id }, 'non-blocking handler failed');
    }

    await next();
  };
}

/** The standard "I did not understand that" reply. */
export async function replyUnknownInput(ctx: Context): Promise<void> {
  await tryReplyHtml(ctx, copy.menu.useButtons());
}

/**
 * Re-exported so a handler has one import for everything it sends.
 *
 * `withTyping` is the piece handlers actually need: `replyHtml` sets the
 * indicator on its way out, but only wrapping the slow call keeps it on while
 * that call is still running.
 */
export { sendTyping, withTyping } from './typing';
