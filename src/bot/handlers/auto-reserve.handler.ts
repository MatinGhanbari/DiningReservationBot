import type { Context, Telegraf } from 'telegraf';
import { copy } from '../../copy/fa';
import { weekdayByIndex } from '../../shared/persian';
import { requireFeature, requireLogin } from '../guards';
import { BTN, autoReserveMenu, autoReserveSelfPicker, backMenu, weekdayPicker } from '../keyboards';
import { handler, replyHtml, tryReplyHtml, withTyping } from '../reply';
import type { BotServices } from '../services';

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
  if (!(await requireFeature(ctx, services, 'autoReserve', backMenu()))) {
    return;
  }

  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  await tryReplyHtml(ctx, copy.autoReserve.intro());
  await showStatus(ctx, services, guard.telegramId);
}

async function askForSelf(ctx: Context, services: BotServices, telegramId: number): Promise<void> {
  const selfs = await withTyping(ctx, () => services.reservations.listSelfs(telegramId));

  if (selfs.length === 0) {
    await replyHtml(ctx, copy.reservation.noSelfs(), backMenu());
    return;
  }

  await replyHtml(ctx, copy.autoReserve.chooseSelfFirst(), autoReserveSelfPicker(selfs));
}

async function onEnable(ctx: Context, services: BotServices): Promise<void> {
  if (!(await requireFeature(ctx, services, 'autoReserve', autoReserveMenu(false)))) {
    return;
  }

  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  const settings = await services.autoReserve.getSettings(guard.telegramId);

  if (settings.selfId === null) {
    await askForSelf(ctx, services, guard.telegramId);
    return;
  }

  await services.autoReserve.setEnabled(guard.telegramId, true);
  await replyHtml(ctx, copy.autoReserve.enabled());
  await showStatus(ctx, services, guard.telegramId);
}

async function onDisable(ctx: Context, services: BotServices): Promise<void> {
  if (!(await requireFeature(ctx, services, 'autoReserve', autoReserveMenu(true)))) {
    return;
  }

  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  await services.autoReserve.setEnabled(guard.telegramId, false);
  await replyHtml(ctx, copy.autoReserve.disabled());
  await showStatus(ctx, services, guard.telegramId);
}

async function onChangeDays(ctx: Context, services: BotServices): Promise<void> {
  if (!(await requireFeature(ctx, services, 'autoReserve', backMenu()))) {
    return;
  }

  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  const settings = await services.autoReserve.getSettings(guard.telegramId);

  await replyHtml(ctx, copy.autoReserve.chooseDays(), weekdayPicker(settings.weekdays));
}

export async function handleDayToggle(ctx: Context, services: BotServices, weekday: number): Promise<void> {
  if (!(await requireFeature(ctx, services, 'autoReserve', backMenu()))) {
    return;
  }

  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  const isSelected = await services.autoReserve.toggleWeekday(guard.telegramId, weekday);
  const settings = await services.autoReserve.getSettings(guard.telegramId);

  await replyHtml(ctx, copy.autoReserve.dayToggled(weekdayByIndex(weekday), isSelected), weekdayPicker(settings.weekdays));
}

async function onChangeSelf(ctx: Context, services: BotServices): Promise<void> {
  if (!(await requireFeature(ctx, services, 'autoReserve', backMenu()))) {
    return;
  }

  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  await askForSelf(ctx, services, guard.telegramId);
}

export async function handleSelfChoice(ctx: Context, services: BotServices, selfId: number): Promise<void> {
  if (!(await requireFeature(ctx, services, 'autoReserve', backMenu()))) {
    return;
  }

  const guard = await requireLogin(ctx, services);

  if (guard === null) {
    return;
  }

  await services.autoReserve.setSelf(guard.telegramId, selfId);

  const selfs = await withTyping(ctx, () => services.reservations.listSelfs(guard.telegramId));
  const selfName = selfs.find(self => self.id === selfId)?.name ?? `سلف ${selfId}`;

  await replyHtml(ctx, copy.autoReserve.selfChosen(selfName));

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
