import type { Context, MiddlewareFn, Telegraf } from 'telegraf';
import { isAdmin } from '../../config/env';
import { copy } from '../../copy/fa';
import { isMenuButton, BTN, backMenu, supportMenu } from '../keyboards';
import { messageTextOf, telegramIdOf } from '../guards';
import { handler, replyHtml, tryReplyHtml, withTyping } from '../reply';
import { clampToLine, clampText } from '../../shared/sanitize';
import type { BotServices } from '../services';

/** A support message is stored and forwarded; it is not an essay. */
export const MAX_SUPPORT_MESSAGE_CHARS = 2_000;

/**
 * Support: the chatbot and the line to a human.
 *
 * Both paths are entered from the same submenu, and both end by clearing the
 * conversation state, so a message is never left half-claimed by a flow the user
 * has moved on from.
 */

async function onSupportMenu(ctx: Context, services: BotServices): Promise<void> {
  await replyHtml(ctx, copy.support.menuIntro(services.chatbot.available), supportMenu(services.chatbot.available));
}

async function onChatbot(ctx: Context, services: BotServices): Promise<void> {
  const telegramId = telegramIdOf(ctx);

  if (telegramId === null) {
    return;
  }

  if (!services.chatbot.available) {
    await replyHtml(ctx, copy.support.chatbotUnavailable(), supportMenu(false));
    return;
  }

  const remaining = await services.chatbot.remainingToday(telegramId);

  await services.conversations.set(telegramId, { step: 'awaiting-chatbot-question' });
  await replyHtml(ctx, copy.support.chatbotIntro(remaining), backMenu());
}

async function onHumanSupport(ctx: Context, services: BotServices): Promise<void> {
  const telegramId = telegramIdOf(ctx);

  if (telegramId === null) {
    return;
  }

  await services.conversations.set(telegramId, { step: 'awaiting-support-message' });
  await replyHtml(ctx, copy.support.humanIntro(), backMenu());
}

async function askChatbot(ctx: Context, services: BotServices, telegramId: number, question: string): Promise<void> {
  await services.conversations.clear(telegramId);
  await tryReplyHtml(ctx, copy.support.chatbotThinking());

  // The language model is the slowest thing this bot talks to, and the one place
  // where a single chat action is guaranteed to expire before the answer lands:
  // a free model that has to be retried once can take the better part of a
  // minute. `withTyping` holds the indicator on for the whole call.
  const answer = await withTyping(ctx, () => services.chatbot.ask(telegramId, question));

  await replyHtml(ctx, copy.support.chatbotAnswer(answer.answer, answer.limit - answer.used), supportMenu(services.chatbot.available));
}

/**
 * Relays one message to the admins.
 *
 * A linked account is not required: someone who cannot log in is exactly the
 * person most likely to need support, so the envelope carries whatever identity
 * Telegram gave us and the bot fills in the rest.
 */
async function relayToAdmins(ctx: Context, services: BotServices, telegramId: number): Promise<void> {
  await services.conversations.clear(telegramId);

  const extracted = extractMessage(ctx);

  if (extracted === null) {
    await replyHtml(ctx, copy.errors.generic(), backMenu());
    return;
  }

  const user = await services.auth.findUser(telegramId);

  const displayName = user === null ? 'کاربر بدون حساب' : clampToLine([user.firstName, user.lastName].filter(Boolean).join(' '), 64);

  const ticket = await services.support.deliver({
    telegramId,
    displayName: displayName.length === 0 ? 'کاربر بدون نام' : displayName,
    username: ctx.from?.username ?? null,
    messageId: extracted.messageId,
    content: extracted.content,
  });

  await replyHtml(ctx, copy.support.humanSent(ticket.id), backMenu());
}

interface ExtractedMessage {
  messageId: number;
  content: string;
}

/**
 * The text of a message, or a marker for the media kinds we forward but cannot
 * read.
 *
 * The marker is what the admin sees in the stored transcript when forwarding
 * fails, so it has to say something useful rather than being empty.
 */
function extractMessage(ctx: Context): ExtractedMessage | null {
  const message = ctx.message;

  if (message === undefined) {
    return null;
  }

  const messageId = message.message_id;

  // Text is clamped and stripped of invisible characters on the way in: it is
  // stored, shown to an admin and forwarded, and a name or caption from outside
  // is not something to reproduce verbatim.
  if ('text' in message && typeof message.text === 'string') {
    return { messageId, content: clampText(message.text, MAX_SUPPORT_MESSAGE_CHARS) };
  }

  if ('caption' in message && typeof message.caption === 'string') {
    return { messageId, content: clampText(message.caption, MAX_SUPPORT_MESSAGE_CHARS) };
  }

  if ('photo' in message) {
    return { messageId, content: '[عکس]' };
  }

  if ('voice' in message) {
    return { messageId, content: '[پیام صوتی]' };
  }

  if ('video' in message) {
    return { messageId, content: '[ویدیو]' };
  }

  if ('document' in message) {
    const name = message.document.file_name ?? 'بدون نام';
    return { messageId, content: `[فایل: ${name}]` };
  }

  if ('audio' in message) {
    return { messageId, content: '[فایل صوتی]' };
  }

  if ('sticker' in message) {
    return { messageId, content: '[استیکر]' };
  }

  return { messageId, content: '[پیام بدون متن]' };
}

/**
 * Turns an admin's reply into a message to the user.
 *
 * Registered before the wizard so a reply is never mistaken for an answer to a
 * half-finished flow. It only claims the update when the replied-to message is
 * one the bot itself placed in that admin's chat, and it steps aside entirely
 * while the admin has a flow of their own in progress.
 */
export function createAdminReplyInterceptor(services: BotServices): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const telegramId = telegramIdOf(ctx);
    const text = messageTextOf(ctx);

    if (telegramId === null || text === null || !isAdmin(telegramId)) {
      await next();
      return;
    }

    const message = ctx.message;

    // `reply_to_message` only exists on the message kinds that carry content, so
    // this narrows the union before the property is read.
    if (message === undefined || !('reply_to_message' in message) || isMenuButton(text)) {
      await next();
      return;
    }

    const repliedTo = message.reply_to_message;

    if (repliedTo === undefined || repliedTo.message_id === undefined) {
      await next();
      return;
    }

    if ((await services.conversations.get(telegramId)) !== null) {
      await next();
      return;
    }

    const { outcome, ticket } = await services.support.handleAdminReply({
      adminTelegramId: telegramId,
      replyToMessageId: repliedTo.message_id,
      text,
    });

    if (outcome === 'unknown-ticket') {
      // Replying to something the bot did not place in this chat. Saying so is
      // the only way the admin learns that nothing was sent.
      await replyHtml(ctx, copy.support.adminReplyUnknown());
      return;
    }

    if (ticket === null) {
      await next();
      return;
    }

    await replyHtml(ctx, outcome === 'delivered' ? copy.support.adminReplyDelivered(ticket.id) : copy.support.adminReplyFailed());
  };
}

export function registerSupportHandlers(bot: Telegraf, services: BotServices): void {
  bot.hears(
    BTN.support,
    handler('support-menu', ctx => onSupportMenu(ctx, services)),
  );
  bot.hears(
    BTN.supportChatbot,
    handler('support-chatbot', ctx => onChatbot(ctx, services)),
  );
  bot.hears(
    BTN.supportHuman,
    handler('support-human', ctx => onHumanSupport(ctx, services)),
  );

  bot.command(
    'support',
    handler('support-command', ctx => onSupportMenu(ctx, services)),
  );
}

export { askChatbot, relayToAdmins };
