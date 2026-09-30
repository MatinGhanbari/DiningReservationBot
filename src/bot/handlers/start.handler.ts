import type { Context, MiddlewareFn, Telegraf } from 'telegraf';
import { isAdmin } from '../../config/env';
import { copy } from '../../copy/fa';
import { UNIVERSITIES, findUniversityById } from '../../domain/universities';
import { scopedLogger } from '../../shared/logger';
import { messageTextOf, requireFeature, requireLogin, telegramIdOf } from '../guards';
import { BTN, backMenu, isMenuButton, loginMenu, mainMenu, universityPicker } from '../keyboards';
import { handler, replyHtml, replyPhotoHtml, tryReplyHtml, withTyping } from '../reply';
import type { BotServices } from '../services';
import type { ConversationState } from '../state';
import { handleAdminUserQuery, handleBroadcastText } from './admin.handler';
import { askChatbot, relayToAdmins } from './support.handler';

const log = scopedLogger('bot');

/**
 * Starting the bot, the login wizard, and the profile screen.
 *
 * The wizard is a three-step conversation: choose a university, type a username,
 * type a password. Each step stores exactly what the next one needs, so nothing
 * has to be re-derived from a previous message.
 *
 * It also owns the one-shot flows that are just "wait for the next message":
 * a support message, a chatbot question, an admin user lookup and a broadcast
 * draft. They share this listener because at most one of them can be active for
 * a given person, and a second listener inspecting the same state would only
 * create a race.
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
    await replyHtml(ctx, copy.start.returning(user.firstName), mainMenu(isAdmin(telegramId)));
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

/**
 * The user's current Telegram profile photo, largest size, or null when there
 * is none.
 *
 * Someone who never set a photo — or who hides it in their privacy settings —
 * gets an empty list rather than an error, so the caller has to handle the
 * missing case either way. A failed lookup is reported the same way, because
 * losing the picture is not worth losing the screen over.
 */
async function profilePhotoFileId(ctx: Context, telegramId: number): Promise<string | null> {
  try {
    const { photos } = await ctx.telegram.getUserProfilePhotos(telegramId, 0, 1);
    const sizes = photos[0];

    // Telegram orders the sizes smallest first, so the last one is the largest.
    return sizes?.[sizes.length - 1]?.file_id ?? null;
  } catch (error) {
    log.debug({ err: error, telegramId }, 'could not read the profile photo');
    return null;
  }
}

async function onMyInfo(ctx: Context, services: BotServices): Promise<void> {
  if (!(await requireFeature(ctx, services, 'profile', backMenu()))) {
    return;
  }

  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  await tryReplyHtml(ctx, copy.profile.loading());

  // Reading the profile is a round trip to Samad, which is the slowest part of
  // this screen and the part the user is waiting on.
  const profile = await withTyping(ctx, () => services.reservations.getProfile(guard.telegramId));
  const universityName = findUniversityById(profile.universityId)?.name ?? 'نامشخص';

  const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(' ');

  const html = copy.profile.view({
    fullName,
    universityName,
    samadUsername: profile.samadUsername,
    creditRial: profile.creditRial,
    telegramId: guard.telegramId,
  });

  const photoFileId = await profilePhotoFileId(ctx, guard.telegramId);

  if (photoFileId === null) {
    await replyHtml(ctx, html, backMenu());
    return;
  }

  await replyPhotoHtml(ctx, photoFileId, html, backMenu());
}

/** Handles the university button and moves the wizard to the username step. */
export async function handleUniversitySelection(ctx: Context, services: BotServices, universityId: number): Promise<void> {
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
 * The wizard's message listener.
 *
 * Registered before the menu buttons so that an active flow claims the message.
 * Without that ordering, someone typing their password as «خروج» (logout)
 * themselves out instead. When no flow is active it passes the update straight
 * through, so the menu keeps working.
 */
export function createTextWizard(services: BotServices): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const telegramId = telegramIdOf(ctx);

    if (telegramId === null || ctx.message === undefined) {
      await next();
      return;
    }

    const state = await services.conversations.get(telegramId);

    if (state === null) {
      await next();
      return;
    }

    const text = messageTextOf(ctx);

    // Tapping a menu button is an escape hatch: abandon the flow and let the
    // button's own handler run. Otherwise «خروج» (logout) typed mid-login would
    // be submitted as a password.
    if (text !== null && isMenuButton(text)) {
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
  text: string | null,
): Promise<void> {
  // A support message may be a photo or a file, so it is the one step that does
  // not require text.
  if (state.step === 'awaiting-support-message') {
    await relayToAdmins(ctx, services, telegramId);
    return;
  }

  if (text === null) {
    await replyHtml(ctx, copy.errors.textOnly());
    return;
  }

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

      // Captured before the closure on purpose: `state` and `text` are function
      // parameters, and TypeScript does not carry a narrowed parameter into a
      // callback. The object literal is evaluated while the narrowing is still
      // in scope, so the call inside `withTyping` sees plain strings.
      const credentials = { universityId: state.universityId, samadUsername: state.samadUsername, password: text };

      // Logging in is a Samad round trip that has to finish before the welcome
      // screen can be drawn, so the indicator is held for its duration.
      const { user, isNewUser } = await withTyping(ctx, () =>
        services.auth.login(telegramId, credentials.universityId, credentials.samadUsername, credentials.password),
      );

      // Best effort: clearing the message that held the password keeps it out of
      // the chat history on both sides.
      try {
        await ctx.deleteMessage();
      } catch {
        // Deleting is a courtesy, not a requirement.
      }

      await services.conversations.clear(telegramId);
      await replyHtml(ctx, copy.start.welcome(user.firstName, isNewUser), mainMenu(isAdmin(telegramId)));
      return;
    }

    case 'awaiting-chatbot-question': {
      await askChatbot(ctx, services, telegramId, text);
      return;
    }

    case 'awaiting-bad-forget-code': {
      await services.conversations.clear(telegramId);
      await services.forgetCodes.reportBadCode(telegramId, text);
      await replyHtml(ctx, copy.forgetCode.reportReceived(), backMenu());
      return;
    }

    case 'awaiting-admin-user-query': {
      await handleAdminUserQuery(ctx, services, telegramId, text);
      return;
    }

    case 'awaiting-broadcast-text': {
      await handleBroadcastText(ctx, services, telegramId, text);
      return;
    }

    case 'awaiting-broadcast-confirm': {
      // Typing again replaces the draft rather than being ignored, which is what
      // someone who spotted a typo in the preview expects to happen.
      await handleBroadcastText(ctx, services, telegramId, text);
      return;
    }
  }
}

export function registerStartHandlers(bot: Telegraf, services: BotServices): void {
  bot.start(handler('start', ctx => onStart(ctx, services)));

  bot.command(
    'help',
    handler('help', ctx => replyHtml(ctx, copy.help(), backMenu())),
  );
  bot.command(
    'about',
    handler('about', async ctx => {
      if (!(await requireFeature(ctx, services, 'about', backMenu()))) {
        return;
      }

      await replyHtml(ctx, copy.about(), backMenu());
    }),
  );
  bot.command(
    'logout',
    handler('logout-command', ctx => onLogout(ctx, services)),
  );

  bot.hears(
    BTN.login,
    handler('login-button', ctx => onLogin(ctx, services)),
  );
  bot.hears(
    BTN.logout,
    handler('logout-button', ctx => onLogout(ctx, services)),
  );
  bot.hears(
    BTN.myInfo,
    handler('my-info', ctx => onMyInfo(ctx, services)),
  );
}
