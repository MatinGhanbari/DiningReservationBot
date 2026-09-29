import type { Context, Telegraf } from 'telegraf';
import { isAdmin } from '../../config/env';
import { samadSettings } from '../../config/appsettings';
import { copy } from '../../copy/fa';
import { requireFeature, telegramIdOf } from '../guards';
import { BTN, backMenu, mainMenu, samadOpen } from '../keyboards';
import { handler, replyHtml, replyUnknownInput } from '../reply';
import type { BotServices } from '../services';

async function onBack(ctx: Context, services: BotServices): Promise<void> {
  const telegramId = telegramIdOf(ctx);

  if (telegramId !== null) {
    await services.conversations.clear(telegramId);
  }

  await replyHtml(ctx, copy.menu.chooseOption(), mainMenu(telegramId !== null && isAdmin(telegramId)));
}

async function onAbout(ctx: Context, services: BotServices): Promise<void> {
  if (!(await requireFeature(ctx, services, 'about', backMenu()))) {
    return;
  }

  await replyHtml(ctx, copy.about(), backMenu());
}

async function onSamadSite(ctx: Context, services: BotServices): Promise<void> {
  if (!(await requireFeature(ctx, services, 'samadSite', backMenu()))) {
    return;
  }

  const url = samadSettings.origins.web.trim();

  if (url.length === 0) {
    await replyHtml(ctx, copy.samad.notConfigured(), backMenu());
    return;
  }

  await replyHtml(ctx, copy.samad.menu(), samadOpen(url));
}

export function registerMenuHandlers(bot: Telegraf, services: BotServices): void {
  bot.hears(
    BTN.back,
    handler('back', ctx => onBack(ctx, services)),
  );
  bot.hears(
    BTN.about,
    handler('about', ctx => onAbout(ctx, services)),
  );
  bot.hears(
    BTN.samadSite,
    handler('samad-site', ctx => onSamadSite(ctx, services)),
  );

  bot.on(
    'message',
    handler('fallback', ctx => replyUnknownInput(ctx)),
  );
}
