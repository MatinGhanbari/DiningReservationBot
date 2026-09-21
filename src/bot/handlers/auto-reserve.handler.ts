import type { Context, Telegraf } from 'telegraf';
import { copy } from '../../copy/fa';
import { weekdayByIndex } from '../../shared/persian';
import { requireLogin } from '../guards';
import { BTN, autoReserveMenu, autoReserveSelfPicker, backMenu, weekdayPicker } from '../keyboards';
import { handler, replyHtml, tryReplyHtml, withTyping } from '../reply';
import type { BotServices } from '../services';

/**
 * Configuring auto-reserve.
 *
 * The flow is deliberately gated: a dining hall has to be chosen before the
 * feature can be switched on. Guessing a hall would mean reserving and charging
 * meals at several of them on the same day.
 */

/**
 * Resolves the stored dining-hall id to a name for display.
 *
 * Best effort: the status screen is still worth showing when Samad is briefly
 * unreachable, so a failure here falls back to the raw id rather than an error.
 */
async function resolveSelfName(services: BotServices, telegramId: number, selfId: number | null): Promise<string | null> {
  if (selfId === null) {
    return null;
  }

  try {
    const selfs = await services.reservations.listSelfs(telegramId);
    return selfs.find(self => self.id === selfId)?.name ?? `سلف ${selfId}`;
  } catch {
    return `سلف ${selfId}`;
  }
}

async function showStatus(ctx: Context, services: BotServices, telegramId: number): Promise<void> {
  // The settings are local, but resolving the hall's name is a Samad call, and
  // this screen is redrawn after almost every change in this flow.
  const { settings, selfName } = await withTyping(ctx, async () => {
    const settings = await services.autoReserve.getSettings(telegramId);
    const selfName = await resolveSelfName(services, telegramId, settings.selfId);
    return { settings, selfName };
  });

  await replyHtml(
    ctx,
    copy.autoReserve.status({
      enabled: settings.enabled,
      selfName,
      weekdays: settings.weekdays,
    }),
    autoReserveMenu(settings.enabled),
  );
}

async function onAutoReserveMenu(ctx: Context, services: BotServices): Promise<void> {
  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  await tryReplyHtml(ctx, copy.autoReserve.intro());
  await showStatus(ctx, services, guard.telegramId);
}

/** Lists dining halls so one can be chosen, optionally enabling afterwards. */
async function askForSelf(ctx: Context, services: BotServices, telegramId: number): Promise<void> {
  const selfs = await withTyping(ctx, () => services.reservations.listSelfs(telegramId));

  if (selfs.length === 0) {
    await replyHtml(ctx, copy.reservation.noSelfs(), backMenu());
    return;
  }

  await replyHtml(ctx, copy.autoReserve.chooseSelfFirst(), autoReserveSelfPicker(selfs));
}

async function onEnable(ctx: Context, services: BotServices): Promise<void> {
  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  const settings = await services.autoReserve.getSettings(guard.telegramId);

  // The service refuses this too; checking first lets the bot answer with a
  // picker instead of an error.
  if (settings.selfId === null) {
    await askForSelf(ctx, services, guard.telegramId);
    return;
  }

  await services.autoReserve.setEnabled(guard.telegramId, true);
  await replyHtml(ctx, copy.autoReserve.enabled());
  await showStatus(ctx, services, guard.telegramId);
}

async function onDisable(ctx: Context, services: BotServices): Promise<void> {
  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  await services.autoReserve.setEnabled(guard.telegramId, false);
  await replyHtml(ctx, copy.autoReserve.disabled());
  await showStatus(ctx, services, guard.telegramId);
}

async function onChangeDays(ctx: Context, services: BotServices): Promise<void> {
  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  const settings = await services.autoReserve.getSettings(guard.telegramId);

  await replyHtml(ctx, copy.autoReserve.chooseDays(), weekdayPicker(settings.weekdays));
}

/** Flips one weekday and redraws the picker with the new state. */
export async function handleDayToggle(ctx: Context, services: BotServices, weekday: number): Promise<void> {
  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  const isSelected = await services.autoReserve.toggleWeekday(guard.telegramId, weekday);
  const settings = await services.autoReserve.getSettings(guard.telegramId);

  await replyHtml(ctx, copy.autoReserve.dayToggled(weekdayByIndex(weekday), isSelected), weekdayPicker(settings.weekdays));
}

async function onChangeSelf(ctx: Context, services: BotServices): Promise<void> {
  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  await askForSelf(ctx, services, guard.telegramId);
}

/** Stores the chosen hall and turns auto-reserve on in the same step. */
export async function handleSelfChoice(ctx: Context, services: BotServices, selfId: number): Promise<void> {
  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  await services.autoReserve.setSelf(guard.telegramId, selfId);

  const selfs = await withTyping(ctx, () => services.reservations.listSelfs(guard.telegramId));
  const selfName = selfs.find(self => self.id === selfId)?.name ?? `سلف ${selfId}`;

  await replyHtml(ctx, copy.autoReserve.selfChosen(selfName));

  // Choosing a hall is what the user was blocked on, so finish the job rather
  // than dropping them back on a screen that still says "not configured".
  const settings = await services.autoReserve.getSettings(guard.telegramId);

  if (!settings.enabled) {
    if (settings.weekdays.length === 0) {
      await replyHtml(ctx, copy.autoReserve.chooseDays(), weekdayPicker([]));
      return;
    }

    await services.autoReserve.setEnabled(guard.telegramId, true);
    await replyHtml(ctx, copy.autoReserve.enabled());
  }

  await showStatus(ctx, services, guard.telegramId);
}

export function registerAutoReserveHandlers(bot: Telegraf, services: BotServices): void {
  bot.hears(
    BTN.autoReserve,
    handler('auto-reserve-menu', ctx => onAutoReserveMenu(ctx, services)),
  );
  bot.hears(
    BTN.autoReserveEnable,
    handler('auto-reserve-enable', ctx => onEnable(ctx, services)),
  );
  bot.hears(
    BTN.autoReserveDisable,
    handler('auto-reserve-disable', ctx => onDisable(ctx, services)),
  );
  bot.hears(
    BTN.autoReserveDays,
    handler('auto-reserve-days', ctx => onChangeDays(ctx, services)),
  );
  bot.hears(
    BTN.autoReserveChangeSelf,
    handler('auto-reserve-self', ctx => onChangeSelf(ctx, services)),
  );
}
