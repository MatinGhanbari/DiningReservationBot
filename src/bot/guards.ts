import type { Context } from 'telegraf';
import type { User } from '../domain/models';
import { isAdmin } from '../config/env';
import { copy } from '../copy/fa';
import { loginMenu } from './keyboards';
import { replyHtml } from './reply';
import type { BotServices } from './services';

/**
 * The Telegram id behind an update, or null when there is none.
 *
 * Updates from channels and anonymous group admins have no `from`, and reading
 * `ctx.from.id` on those throws. Every entry point goes through here instead.
 */
export function telegramIdOf(ctx: Context): number | null {
  return ctx.from?.id ?? null;
}

/** The text of a message update, or null when the update carries none. */
export function messageTextOf(ctx: Context): string | null {
  const message = ctx.message;
  if (message === undefined || !('text' in message) || typeof message.text !== 'string') {
    return null;
  }

  const trimmed = message.text.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Requires a linked Samad account, replying with the login prompt when there is none.
 *
 * Returning `null` instead of throwing keeps the guard readable at the call site
 * and means an unauthenticated tap never reaches a service that would fail with
 * a confusing upstream error.
 */
export async function requireLogin(ctx: Context, services: BotServices): Promise<{ telegramId: number; user: User } | null> {
  const telegramId = telegramIdOf(ctx);

  if (telegramId === null) {
    return null;
  }

  const user = await services.auth.findUser(telegramId);

  if (user === null) {
    await replyHtml(ctx, copy.start.mustLoginFirst(), loginMenu());
    return null;
  }

  return { telegramId, user };
}

/**
 * Requires the sender to be a configured admin.
 *
 * The admin check is also the authorisation check for every panel action, so it
 * is repeated at each entry point rather than trusted from the menu the admin was
 * shown — an old keyboard in a chat history is enough to reach a handler.
 */
export async function requireAdmin(ctx: Context): Promise<number | null> {
  const telegramId = telegramIdOf(ctx);

  if (telegramId === null) {
    return null;
  }

  if (!isAdmin(telegramId)) {
    await replyHtml(ctx, copy.admin.notAuthorized());
    return null;
  }

  return telegramId;
}
