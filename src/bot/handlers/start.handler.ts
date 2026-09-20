import type { Context, MiddlewareFn, Telegraf } from 'telegraf';
import { config } from '../../config/env';
import { copy } from '../../copy/fa';
import { UNIVERSITIES, findUniversityById } from '../../domain/universities';
import { messageTextOf, requireLogin, telegramIdOf } from '../guards';
import { BTN, backMenu, isMenuButton, loginMenu, mainMenu, universityPicker } from '../keyboards';
import { handler, replyHtml, tryReplyHtml } from '../reply';
import type { BotServices } from '../services';
import type { ConversationState } from '../state';
import { scopedLogger } from '../../shared/logger';

const log = scopedLogger('bot:start');

/**
 * Starting the bot, the login wizard, and the profile screen.
 *
 * The wizard is a three-step conversation: choose a university, type a username,
 * type a password. Each step stores exactly what the next one needs, so nothing
 * has to be re-derived from a previous message.
 */

async function onStart(ctx: Context, services: BotServices): Promise<void> {
  const telegramId = telegramIdOf(ctx);

  if (telegramId === null) {
    return;
  }

  // A fresh /start always abandons whatever flow was in progress.
  await services.conversations.clear(telegramId);

  const user = await services.auth.findUser(telegramId);

  if (user !== null) {
    await replyHtml(ctx, copy.start.returning(user.firstName), mainMenu());
    return;
  }

  await replyHtml(ctx, copy.start.chooseUniversity(), universityPicker(UNIVERSITIES));
}

async function onLogin(ctx: Context, services: BotServices): Promise<void> {
  const telegramId = telegramIdOf(ctx);

  if (telegramId === null) {
    return;
  }

  await services.conversations.clear(telegramId);
  await replyHtml(ctx, copy.start.chooseUniversity(), universityPicker(UNIVERSITIES));
}

async function onLogout(ctx: Context, services: BotServices): Promise<void> {
  const telegramId = telegramIdOf(ctx);

  if (telegramId === null) {
    return;
  }

  await services.auth.logout(telegramId);
  await services.conversations.clear(telegramId);

  await replyHtml(ctx, copy.start.loggedOut(), loginMenu());
}

async function onMyInfo(ctx: Context, services: BotServices): Promise<void> {
  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  await tryReplyHtml(ctx, copy.profile.loading());

  const profile = await services.reservations.getProfile(guard.telegramId);
  const universityName = findUniversityById(profile.universityId)?.name ?? 'نامشخص';

  const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(' ');

  await replyHtml(
    ctx,
    copy.profile.view({
      fullName,
      universityName,
      samadUsername: profile.samadUsername,
      creditRial: profile.creditRial,
      telegramId: guard.telegramId,
    }),
    backMenu(),
  );
}

/** Handles the university button and moves the wizard to the username step. */
export async function handleUniversitySelection(
  ctx: Context,
  services: BotServices,
  universityId: number,
): Promise<void> {
  const telegramId = telegramIdOf(ctx);
  const university = findUniversityById(universityId);

  if (telegramId === null) {
    return;
  }

  if (university === undefined) {
    await replyHtml(ctx, copy.errors.unknownUniversity());
    return;
  }

  await services.conversations.set(telegramId, { step: 'awaiting-username', universityId });

  await replyHtml(ctx, copy.start.askUsername(university.name));
}

/**
 * The wizard's text listener.
 *
 * Registered before the menu buttons so that an active flow claims the message.
 * Without that ordering, someone typing their password as «خروج» would log
 * themselves out instead. When no flow is active it passes the update straight
 * through, so the menu keeps working.
 */
export function createTextWizard(services: BotServices): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const telegramId = telegramIdOf(ctx);
    const text = messageTextOf(ctx);

    if (telegramId === null || text === null) {
      await next();
      return;
    }

    const state = await services.conversations.get(telegramId);

    if (state === null) {
      await next();
      return;
    }

    // Tapping a menu button is an escape hatch: abandon the flow and let the
    // button's own handler run. Otherwise «خروج» typed mid-login would be
    // submitted as a password.
    if (isMenuButton(text)) {
      await services.conversations.clear(telegramId);
      await next();
      return;
    }

    try {
      await advance(ctx, services, telegramId, state, text);
    } catch (error) {
      await services.conversations.clear(telegramId);
      throw error;
    }
  };
}

async function advance(
  ctx: Context,
  services: BotServices,
  telegramId: number,
  state: ConversationState,
  text: string,
): Promise<void> {
  switch (state.step) {
    case 'awaiting-username': {
      await services.conversations.set(telegramId, {
        step: 'awaiting-password',
        universityId: state.universityId,
        samadUsername: text,
      });
      await replyHtml(ctx, copy.start.askPassword());
      return;
    }

    case 'awaiting-password': {
      await replyHtml(ctx, copy.start.checking());

      const { user, isNewUser } = await services.auth.login(
        telegramId,
        state.universityId,
        state.samadUsername,
        text,
      );

      // Best effort: clearing the message that held the password keeps it out of
      // the chat history on both sides.
      try {
        await ctx.deleteMessage();
      } catch {
        // Deleting is a courtesy, not a requirement.
      }

      await services.conversations.clear(telegramId);
      await replyHtml(ctx, copy.start.welcome(user.firstName, isNewUser), mainMenu());
      return;
    }

    case 'awaiting-support-message': {
      await services.conversations.clear(telegramId);
      await forwardToAdmins(ctx);
      await replyHtml(ctx, copy.support.sent(), backMenu());
      return;
    }

    case 'awaiting-bad-forget-code': {
      await services.conversations.clear(telegramId);
      await services.forgetCodes.reportBadCode(telegramId, text);
      await replyHtml(ctx, copy.forgetCode.reportReceived(), backMenu());
      return;
    }
  }
}

/** Relays a support message to every configured admin. */
async function forwardToAdmins(ctx: Context): Promise<void> {
  if (ctx.telegram === undefined) {
    return;
  }

  // `allSettled` rather than `all`: one admin having blocked the bot must not
  // stop the others from receiving the message.
  const results = await Promise.allSettled(config.ADMINS.map(adminId => ctx.forwardMessage(adminId)));

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      log.warn({ err: result.reason, adminIndex: index }, 'could not forward support message to an admin');
    }
  });
}

export function registerStartHandlers(bot: Telegraf, services: BotServices): void {
  bot.start(handler('start', ctx => onStart(ctx, services)));

  bot.command('help', handler('help', ctx => replyHtml(ctx, copy.help(), backMenu())));
  bot.command('about', handler('about', ctx => replyHtml(ctx, copy.about(), backMenu())));
  bot.command('logout', handler('logout-command', ctx => onLogout(ctx, services)));

  bot.hears(BTN.login, handler('login-button', ctx => onLogin(ctx, services)));
  bot.hears(BTN.logout, handler('logout-button', ctx => onLogout(ctx, services)));
  bot.hears(BTN.myInfo, handler('my-info', ctx => onMyInfo(ctx, services)));
}
