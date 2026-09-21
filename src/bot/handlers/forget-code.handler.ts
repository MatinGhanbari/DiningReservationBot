import type { Context, Telegraf } from 'telegraf';
import { copy } from '../../copy/fa';
import { requireLogin } from '../guards';
import { BTN, backMenu, forgetCodeMenu, receiveSelfPicker, shareConfirm, shareTargetPicker } from '../keyboards';
import { formatJalaliDate } from '../../shared/persian';
import { handler, replyHtml, tryReplyHtml, withTyping } from '../reply';
import type { BotServices } from '../services';

/**
 * The forget-code flow.
 *
 * Two directions, both worth walking through slowly: giving a meal away costs
 * the giver that meal, so it is confirmed before it happens; taking a code is
 * free but only useful if the person actually has a meal today, so the bot says
 * so plainly instead of handing over something unusable.
 */

async function onForgetCodeMenu(ctx: Context, services: BotServices): Promise<void> {
  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  await replyHtml(ctx, copy.forgetCode.intro(), forgetCodeMenu());
}

/**
 * Lists the meals that can be given away.
 *
 * Falls back to next week when the current week has nothing left to share,
 * rather than telling the user to go and look themselves.
 */
async function onShareForgetCode(ctx: Context, services: BotServices): Promise<void> {
  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  await tryReplyHtml(ctx, copy.reserves.loading());

  // The second lookup only happens when the first came back empty, so the
  // indicator has to cover both rather than being set once per request.
  const { week, meals } = await withTyping(ctx, async () => {
    const current = await services.reservations.listReserves(guard.telegramId, 'current');

    if (current.meals.length > 0) {
      return { week: 'current' as const, meals: current.meals };
    }

    const next = await services.reservations.listReserves(guard.telegramId, 'next');
    return { week: 'next' as const, meals: next.meals };
  });

  if (meals.length === 0) {
    await replyHtml(ctx, copy.forgetCode.nothingToShare(), backMenu());
    return;
  }

  await replyHtml(
    ctx,
    copy.forgetCode.chooseShareTarget(week === 'current' ? copy.reserves.weekLabel.current : copy.reserves.weekLabel.next),
    shareTargetPicker(meals),
  );
}

/** Asks for confirmation before a meal is given away. */
export async function handleShareTarget(ctx: Context, services: BotServices, reserveId: number): Promise<void> {
  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  const meal = await withTyping(ctx, () => services.reservations.findReservedMeal(guard.telegramId, reserveId));

  await replyHtml(ctx, copy.forgetCode.shareConfirmation(meal.foodName, meal.weekdayName), shareConfirm(reserveId));
}

/** Prints the code and adds it to the pool. */
export async function handleShareConfirm(ctx: Context, services: BotServices, reserveId: number): Promise<void> {
  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  await tryReplyHtml(ctx, copy.forgetCode.fetching());

  const outcome = await withTyping(ctx, () => services.forgetCodes.share(guard.telegramId, reserveId));

  if (outcome.kind === 'already-shared') {
    await replyHtml(ctx, copy.forgetCode.alreadyShared(outcome.issued.code), backMenu());
    return;
  }

  await replyHtml(
    ctx,
    copy.forgetCode.shareDone({
      code: outcome.issued.code,
      foodName: outcome.issued.foodName,
      selfName: outcome.issued.selfName,
      dateLabel: formatJalaliDate(outcome.issued.mealDate),
    }),
    backMenu(),
  );
}

/** Lists the dining halls the user can take a code for. */
async function onReceiveForgetCode(ctx: Context, services: BotServices): Promise<void> {
  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  await tryReplyHtml(ctx, copy.reservation.loadingSelfs());

  const selfs = await withTyping(ctx, () => services.reservations.listSelfs(guard.telegramId));

  if (selfs.length === 0) {
    await replyHtml(ctx, copy.reservation.noSelfs(), backMenu());
    return;
  }

  await replyHtml(ctx, copy.forgetCode.chooseSelfToReceive(), receiveSelfPicker(selfs));
}

/** Claims a code for today's meal at the chosen hall. */
export async function handleReceiveSelf(ctx: Context, services: BotServices, selfId: number): Promise<void> {
  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  await tryReplyHtml(ctx, copy.forgetCode.fetching());

  // Sequential rather than parallel, exactly as before: the program lookup is
  // only worth doing once the claim has succeeded, and it should not be fired
  // off against a code the user may not have got.
  const { claimed, meal } = await withTyping(ctx, async () => {
    const claimed = await services.forgetCodes.claimTodaysCode(guard.telegramId, selfId);
    const meal = await services.reservations.findTodaysProgram(guard.telegramId, selfId);
    return { claimed, meal };
  });

  await replyHtml(
    ctx,
    copy.forgetCode.receiveDone({
      code: claimed.code,
      foodName: meal?.foodName ?? 'غذا',
      weekday: meal?.weekdayName ?? '',
      dateLabel: meal === null ? '' : formatJalaliDate(meal.servedAt),
    }),
    backMenu(),
  );
}

/** Starts the report flow; the code itself arrives as the next text message. */
async function onReportBadCode(ctx: Context, services: BotServices): Promise<void> {
  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  await services.conversations.set(guard.telegramId, { step: 'awaiting-bad-forget-code' });

  await replyHtml(ctx, copy.forgetCode.reportPrompt(), backMenu());
}

export function registerForgetCodeHandlers(bot: Telegraf, services: BotServices): void {
  bot.hears(
    BTN.forgetCode,
    handler('forget-code-menu', ctx => onForgetCodeMenu(ctx, services)),
  );
  bot.hears(
    BTN.shareForgetCode,
    handler('forget-code-share', ctx => onShareForgetCode(ctx, services)),
  );
  bot.hears(
    BTN.receiveForgetCode,
    handler('forget-code-receive', ctx => onReceiveForgetCode(ctx, services)),
  );
  bot.hears(
    BTN.reportBadCode,
    handler('forget-code-report', ctx => onReportBadCode(ctx, services)),
  );
}
