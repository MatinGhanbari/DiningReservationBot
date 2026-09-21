import type { Context, Telegraf } from 'telegraf';
import type { WeekSelection } from '../../app/reservation.service';
import { copy } from '../../copy/fa';
import { requireLogin } from '../guards';
import { BTN, backMenu, mealPicker, selfPicker, weekPicker } from '../keyboards';
import { formatMealList, formatReserves, weekLabel } from '../formatters';
import { handler, replyHtml, tryReplyHtml } from '../reply';
import type { BotServices } from '../services';

/**
 * Browsing menus and booking meals.
 *
 * Every step answers the question "what now?" — the original bot ended several
 * flows by simply going quiet, which left people tapping a dead button.
 */

async function onChooseWeekForReservation(ctx: Context, services: BotServices): Promise<void> {
  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  await replyHtml(ctx, copy.reservation.chooseWeek(), weekPicker());
}

/** Shows the dining halls for a week, then the menu of the one that was picked. */
export async function handleSelfSelection(ctx: Context, services: BotServices, week: WeekSelection, selfId: number): Promise<void> {
  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  await tryReplyHtml(ctx, copy.reservation.loadingMeals());

  const [selfs, meals] = await Promise.all([
    services.reservations.listSelfs(guard.telegramId),
    services.reservations.listMealOptions(guard.telegramId, selfId, week),
  ]);

  const selfName = selfs.find(self => self.id === selfId)?.name ?? 'سلف';

  if (meals.length === 0) {
    await replyHtml(ctx, copy.reservation.noMealsForSelf(weekLabel(week)), backMenu());
    return;
  }

  await replyHtml(ctx, formatMealList({ selfName, weekLabel: weekLabel(week), meals }), mealPicker(meals));
}

/** Books one meal and reports exactly what Samad said. */
export async function handleReserveMeal(
  ctx: Context,
  services: BotServices,
  programId: number,
  foodTypeId: number,
  mealTypeId: number,
): Promise<void> {
  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  const outcome = await services.reservations.reserve(guard.telegramId, programId, foodTypeId, mealTypeId);

  // Samad's own explanation is shown rather than a generic message: it already
  // says whether the problem is credit, capacity, or timing.
  await replyHtml(
    ctx,
    outcome.succeeded ? copy.reservation.reserved(outcome.message) : copy.reservation.reserveFailed(outcome.message),
    backMenu(),
  );
}

/** Shows the reservations already made for a week. */
export async function handleShowReserves(ctx: Context, services: BotServices, week: WeekSelection): Promise<void> {
  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  await tryReplyHtml(ctx, copy.reserves.loading());

  const reserves = await services.reservations.listReserves(guard.telegramId, week);
  const label = weekLabel(week);

  if (reserves.meals.length === 0) {
    await replyHtml(ctx, copy.reserves.empty(label), backMenu());
    return;
  }

  await replyHtml(ctx, formatReserves({ weekLabel: label, reserves }), backMenu());
}

async function onShowSelfsForReservation(ctx: Context, services: BotServices, week: WeekSelection): Promise<void> {
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

  await replyHtml(ctx, copy.reservation.chooseSelf(weekLabel(week)), selfPicker(week, selfs));
}

export function registerReservationHandlers(bot: Telegraf, services: BotServices): void {
  bot.hears(
    BTN.reserveFood,
    handler('reserve-food', ctx => onChooseWeekForReservation(ctx, services)),
  );
  bot.hears(
    BTN.thisWeekReserves,
    handler('this-week-reserves', ctx => handleShowReserves(ctx, services, 'current')),
  );
  bot.hears(
    BTN.nextWeekReserves,
    handler('next-week-reserves', ctx => handleShowReserves(ctx, services, 'next')),
  );
}

/** Routes a week chosen from the inline picker to the dining-hall list. */
export async function handleWeekSelection(ctx: Context, services: BotServices, week: WeekSelection): Promise<void> {
  await onShowSelfsForReservation(ctx, services, week);
}
