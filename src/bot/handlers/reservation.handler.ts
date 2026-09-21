import type { Context, Telegraf } from 'telegraf';
import type { WeekSelection } from '../../app/reservation.service';
import { copy } from '../../copy/fa';
import { requireFeature, requireLogin } from '../guards';
import { BTN, backMenu, mealPicker, selfPicker, weekPicker } from '../keyboards';
import { formatMealList, formatReserves, weekLabel } from '../formatters';
import { handler, replyHtml, tryReplyHtml, withTyping } from '../reply';
import type { BotServices } from '../services';

async function onChooseWeekForReservation(ctx: Context, services: BotServices): Promise<void> {
  if (!(await requireFeature(ctx, services, 'reserve', backMenu()))) {
    return;
  }

  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  await replyHtml(ctx, copy.reservation.chooseWeek(), weekPicker());
}

export async function handleSelfSelection(ctx: Context, services: BotServices, week: WeekSelection, selfId: number): Promise<void> {
  if (!(await requireFeature(ctx, services, 'reserve', backMenu()))) {
    return;
  }

  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  await tryReplyHtml(ctx, copy.reservation.loadingMeals());

  const [selfs, meals] = await withTyping(ctx, () =>
    Promise.all([services.reservations.listSelfs(guard.telegramId), services.reservations.listMealOptions(guard.telegramId, selfId, week)]),
  );

  const selfName = selfs.find(self => self.id === selfId)?.name ?? 'سلف';

  if (meals.length === 0) {
    await replyHtml(ctx, copy.reservation.noMealsForSelf(weekLabel(week)), backMenu());
    return;
  }

  await replyHtml(ctx, formatMealList({ selfName, weekLabel: weekLabel(week), meals }), mealPicker(meals));
}

export async function handleReserveMeal(
  ctx: Context,
  services: BotServices,
  programId: number,
  foodTypeId: number,
  mealTypeId: number,
): Promise<void> {
  if (!(await requireFeature(ctx, services, 'reserve', backMenu()))) {
    return;
  }

  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  const outcome = await withTyping(ctx, () => services.reservations.reserve(guard.telegramId, programId, foodTypeId, mealTypeId));

  await replyHtml(
    ctx,
    outcome.succeeded ? copy.reservation.reserved(outcome.message) : copy.reservation.reserveFailed(outcome.message),
    backMenu(),
  );
}

export async function handleShowReserves(ctx: Context, services: BotServices, week: WeekSelection): Promise<void> {
  if (!(await requireFeature(ctx, services, 'reserves', backMenu()))) {
    return;
  }

  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  await tryReplyHtml(ctx, copy.reserves.loading());

  const reserves = await withTyping(ctx, () => services.reservations.listReserves(guard.telegramId, week));
  const label = weekLabel(week);

  if (reserves.meals.length === 0) {
    await replyHtml(ctx, copy.reserves.empty(label), backMenu());
    return;
  }

  await replyHtml(ctx, formatReserves({ weekLabel: label, reserves }), backMenu());
}

async function onShowSelfsForReservation(ctx: Context, services: BotServices, week: WeekSelection): Promise<void> {
  if (!(await requireFeature(ctx, services, 'reserve', backMenu()))) {
    return;
  }

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

export async function handleWeekSelection(ctx: Context, services: BotServices, week: WeekSelection): Promise<void> {
  await onShowSelfsForReservation(ctx, services, week);
}
