import type { Context, Telegraf } from 'telegraf';
import { isAdmin } from '../../config/env';
import { copy } from '../../copy/fa';
import { telegramIdOf } from '../guards';
import { BTN, backMenu, mainMenu } from '../keyboards';
import { handler, replyHtml, replyUnknownInput } from '../reply';
import type { BotServices } from '../services';

/**
 * The screens that are just a message: the main menu, about and help.
 *
 * Also owns the fallback. The original bot answered every unrecognised message
 * with «متوجه منظورت نشدم»، including messages it had actually just asked for.
 * Here the fallback is only reached when nothing else claimed the update, so an
 * unexpected message gets guidance instead of a complaint.
 */

async function onBack(ctx: Context, services: BotServices): Promise<void> {
  const telegramId = telegramIdOf(ctx);

  if (telegramId !== null) {
    await services.conversations.clear(telegramId);
  }

  await replyHtml(ctx, copy.menu.chooseOption(), mainMenu(telegramId !== null && isAdmin(telegramId)));
}

export function registerMenuHandlers(bot: Telegraf, services: BotServices): void {
  bot.hears(
    BTN.back,
    handler('back', ctx => onBack(ctx, services)),
  );
  bot.hears(
    BTN.about,
    handler('about', ctx => replyHtml(ctx, copy.about(), backMenu())),
  );

  // Registered last, so it only runs when nothing above matched.
  bot.on(
    'message',
    handler('fallback', ctx => replyUnknownInput(ctx)),
  );
}
