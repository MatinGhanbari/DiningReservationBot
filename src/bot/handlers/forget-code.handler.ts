import type { Context, Telegraf } from 'telegraf';
import type { ReservedMeal } from '../../domain/models';
import { copy } from '../../copy/fa';
import { requireLogin } from '../guards';
import { BTN, backMenu, forgetCodeMenu, receiveSelfPicker, shareConfirm, shareTargetPicker } from '../keyboards';
import { formatJalaliDate } from '../../shared/persian';
import { handler, replyHtml, tryReplyHtml } from '../reply';
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

  const current = await services.reservations.listReserves(guard.telegramId, 'current');

  let week: 'current' | 'next' = 'current';
  let meals: readonly ReservedMeal[] = current.meals;

  if (meals.length === 0) {
    const next = await services.reservations.listReserves(guard.telegramId, 'next');
    week = 'next';
    meals = next.meals;
  }

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

  const meal = await services.reservations.findReservedMeal(guard.telegramId, reserveId);

  await replyHtml(
    ctx,
    copy.forgetCode.shareConfirmation(meal.foodName, meal.weekdayName),
    shareConfirm(reserveId),
  );
}

/** Prints the code and adds it to the pool. */
export async function handleShareConfirm(ctx: Context, services: BotServices, reserveId: number): Promise<void> {
  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  await tryReplyHtml(ctx, copy.forgetCode.fetching());

  const outcome = await services.forgetCodes.share(guard.telegramId, reserveId);

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

  const selfs = await services.reservations.listSelfs(guard.telegramId);

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

  const claimed = await services.forgetCodes.claimTodaysCode(guard.telegramId, selfId);

  const meal = await services.reservations.findTodaysProgram(guard.telegramId, selfId);

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
  bot.hears(BTN.forgetCode, handler('forget-code-menu', ctx => onForgetCodeMenu(ctx, services)));
  bot.hears(BTN.shareForgetCode, handler('forget-code-share', ctx => onShareForgetCode(ctx, services)));
  bot.hears(BTN.receiveForgetCode, handler('forget-code-receive', ctx => onReceiveForgetCode(ctx, services)));
  bot.hears(BTN.reportBadCode, handler('forget-code-report', ctx => onReportBadCode(ctx, services)));
}
