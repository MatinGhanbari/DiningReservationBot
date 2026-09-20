import type { Context, MiddlewareFn } from 'telegraf';
import type { ExtraReplyMessage } from 'telegraf/typings/telegram-types';
import { copy } from '../copy/fa';
import { isAppError, toAppError } from '../shared/errors';
import { scopedLogger } from '../shared/logger';

const log = scopedLogger('bot');

/**
 * Sends a message using Telegram's HTML parse mode.
 *
 * HTML rather than MarkdownV2 on purpose. MarkdownV2 requires escaping eighteen
 * characters, and every food name, dining-hall name and error string that comes
 * from Samad would have to be escaped correctly or Telegram rejects the entire
 * message. HTML needs four characters, and the copy module escapes them at the
 * point where the values are interpolated.
 */
export async function replyHtml(ctx: Context, html: string, extra?: ExtraReplyMessage): Promise<void> {
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

    // `next` is accepted for signature compatibility with Telegraf middleware.
    void next;
  };
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
