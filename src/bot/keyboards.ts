import { Markup } from 'telegraf';
import type { FeatureKey } from '../domain/features';
import type { MealOption, ReservedMeal, Self } from '../domain/models';
import { WEEKDAY_NAMES } from '../shared/persian';
import { copy, buttonLabel, raw, selfButton, t } from '../copy/fa';
import { encodeCallback } from './callback-data';
import type { WeekSelection } from '../app/reservation.service';

export const BTN = {
  reserveFood: t('buttons.reserveFood'),
  autoReserve: t('buttons.autoReserve'),
  thisWeekReserves: t('buttons.thisWeekReserves'),
  nextWeekReserves: t('buttons.nextWeekReserves'),
  forgetCode: t('buttons.forgetCode'),
  myInfo: t('buttons.myInfo'),
  about: t('buttons.about'),
  support: t('buttons.support'),
  samadSite: t('buttons.samadSite'),
  logout: t('buttons.logout'),
  login: t('buttons.login'),
  back: t('buttons.back'),
  shareForgetCode: t('buttons.shareForgetCode'),
  receiveForgetCode: t('buttons.receiveForgetCode'),
  reportBadCode: t('buttons.reportBadCode'),
  autoReserveDays: t('buttons.autoReserveDays'),
  autoReserveEnable: t('buttons.autoReserveEnable'),
  autoReserveDisable: t('buttons.autoReserveDisable'),
  autoReserveChangeSelf: t('buttons.autoReserveChangeSelf'),
  supportChatbot: t('buttons.supportChatbot'),
  supportHuman: t('buttons.supportHuman'),
  adminPanel: t('buttons.adminPanel'),
  adminStats: t('buttons.adminStats'),
  adminUsers: t('buttons.adminUsers'),
  adminSupport: t('buttons.adminSupport'),
  adminChatbot: t('buttons.adminChatbot'),
  adminBroadcast: t('buttons.adminBroadcast'),
  adminSystem: t('buttons.adminSystem'),
  adminMaintenance: t('buttons.adminMaintenance'),
  adminBackup: t('buttons.adminBackup'),
  adminFeatures: t('buttons.adminFeatures'),
  adminBack: t('buttons.adminBack'),
} as const;

const MENU_LABELS: ReadonlySet<string> = new Set(Object.values(BTN));

export function isMenuButton(text: string): boolean {
  return MENU_LABELS.has(text);
}

export const mainMenu = (admin = false) => {
  const rows = [
    [Markup.button.text(BTN.reserveFood), Markup.button.text(BTN.autoReserve)],
    [Markup.button.text(BTN.thisWeekReserves), Markup.button.text(BTN.nextWeekReserves)],
    [Markup.button.text(BTN.forgetCode), Markup.button.text(BTN.samadSite)],
    [Markup.button.text(BTN.myInfo), Markup.button.text(BTN.about), Markup.button.text(BTN.support)],
  ];

  if (admin) {
    rows.push([Markup.button.text(BTN.adminPanel)]);
  }

  rows.push([Markup.button.text(BTN.logout)]);

  return Markup.keyboard(rows).resize();
};

export const backMenu = () => Markup.keyboard([[Markup.button.text(BTN.back)]]).resize();

export const loginMenu = () => Markup.keyboard([[Markup.button.text(BTN.login)]]).resize();

export const supportMenu = (hasChatbot: boolean) => {
  const rows = hasChatbot
    ? [[Markup.button.text(BTN.supportChatbot)], [Markup.button.text(BTN.supportHuman)]]
    : [[Markup.button.text(BTN.supportHuman)]];

  rows.push([Markup.button.text(BTN.back)]);

  return Markup.keyboard(rows).resize();
};

export const adminMenu = () =>
  Markup.keyboard([
    [Markup.button.text(BTN.adminStats), Markup.button.text(BTN.adminUsers)],
    [Markup.button.text(BTN.adminSupport), Markup.button.text(BTN.adminChatbot)],
    [Markup.button.text(BTN.adminFeatures), Markup.button.text(BTN.adminBroadcast)],
    [Markup.button.text(BTN.adminSystem), Markup.button.text(BTN.adminMaintenance)],
    [Markup.button.text(BTN.adminBackup)],
    [Markup.button.text(BTN.back)],
  ]).resize();

export const adminSubMenu = () => Markup.keyboard([[Markup.button.text(BTN.adminBack)], [Markup.button.text(BTN.back)]]).resize();

export const forgetCodeMenu = () =>
  Markup.keyboard([
    [Markup.button.text(BTN.receiveForgetCode), Markup.button.text(BTN.shareForgetCode)],
    [Markup.button.text(BTN.reportBadCode)],
    [Markup.button.text(BTN.back)],
  ]).resize();

export const autoReserveMenu = (enabled: boolean) =>
  Markup.keyboard([
    [Markup.button.text(BTN.autoReserveDays), Markup.button.text(BTN.autoReserveChangeSelf)],
    [Markup.button.text(enabled ? BTN.autoReserveDisable : BTN.autoReserveEnable)],
    [Markup.button.text(BTN.back)],
  ]).resize();

export const samadOpen = (url: string) => Markup.inlineKeyboard([[Markup.button.webApp(copy.samad.openButton(), url)]]);

export const universityPicker = (universities: readonly { id: number; name: string; shortName: string }[]) =>
  Markup.inlineKeyboard(
    universities.map(university => [
      Markup.button.callback(university.shortName, encodeCallback({ kind: 'select-university', universityId: university.id })),
    ]),
  );

export const selfPicker = (week: WeekSelection, selfs: readonly Self[]) =>
  Markup.inlineKeyboard(
    selfs.map(self => [Markup.button.callback(selfButton(self.name), encodeCallback({ kind: 'select-self', week, selfId: self.id }))]),
  );

export const mealPicker = (meals: readonly MealOption[]) =>
  Markup.inlineKeyboard(
    meals.map((meal, index) => [
      Markup.button.callback(
        copy.reservation.mealButton(index + 1, meal.foodName),
        encodeCallback({
          kind: 'reserve-meal',
          programId: meal.programId,
          foodTypeId: meal.foodTypeId,
          mealTypeId: meal.mealTypeId,
        }),
      ),
    ]),
  );

export const weekPicker = () =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback(copy.reserves.weekLabel.current, encodeCallback({ kind: 'choose-self', week: 'current' })),
      Markup.button.callback(copy.reserves.weekLabel.next, encodeCallback({ kind: 'choose-self', week: 'next' })),
    ],
  ]);

export const weekdayPicker = (selected: readonly number[]) => {
  const selectedSet = new Set(selected);

  const buttons = WEEKDAY_NAMES.map((name, index) =>
    Markup.button.callback(`${selectedSet.has(index) ? '✅' : '▫️'} ${name}`, encodeCallback({ kind: 'auto-reserve-day', weekday: index })),
  );

  return Markup.inlineKeyboard([buttons.slice(0, 2), buttons.slice(2, 4), buttons.slice(4, 6), buttons.slice(6)]);
};

export const shareTargetPicker = (meals: readonly ReservedMeal[]) =>
  Markup.inlineKeyboard(
    meals.map((meal, index) => [
      Markup.button.callback(
        copy.reservation.mealButton(index + 1, meal.foodName),
        encodeCallback({ kind: 'forget-code-share', reserveId: meal.reserveId }),
      ),
    ]),
  );

export const shareConfirm = (reserveId: number) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(t('buttons.shareConfirmYes'), encodeCallback({ kind: 'forget-code-share-confirm', reserveId }))],
    [Markup.button.callback(t('buttons.shareConfirmNo'), encodeCallback({ kind: 'show-reserves', week: 'current' }))],
  ]);

export const receiveSelfPicker = (selfs: readonly Self[]) =>
  Markup.inlineKeyboard(
    selfs.map(self => [
      Markup.button.callback(selfButton(self.name), encodeCallback({ kind: 'forget-code-receive-self', selfId: self.id })),
    ]),
  );

export const autoReserveSelfPicker = (selfs: readonly Self[]) =>
  Markup.inlineKeyboard(
    selfs.map(self => [Markup.button.callback(selfButton(self.name), encodeCallback({ kind: 'auto-reserve-self', selfId: self.id }))]),
  );

export const adminUserPicker = (users: readonly { telegramId: number; displayName: string }[]) =>
  Markup.inlineKeyboard(
    users.map(user => [
      Markup.button.callback(buttonLabel(user.displayName), encodeCallback({ kind: 'admin-user', telegramId: user.telegramId })),
    ]),
  );

export const userActions = (telegramId: number) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(t('buttons.logoutAccount'), encodeCallback({ kind: 'admin-logout-prompt', telegramId }))],
  ]);

export const logoutConfirm = (telegramId: number) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(t('buttons.logoutConfirmYes'), encodeCallback({ kind: 'admin-logout-confirm', telegramId }))],
    [Markup.button.callback(t('buttons.logoutConfirmNo'), encodeCallback({ kind: 'admin-user', telegramId }))],
  ]);

export const ticketList = (tickets: readonly { id: number; displayName: string }[]) =>
  Markup.inlineKeyboard(
    tickets.map(ticket => [
      Markup.button.callback(
        buttonLabel(t('buttons.ticketCloseTemplate', { ticketId: ticket.id, displayName: ticket.displayName })),
        encodeCallback({ kind: 'admin-close-ticket', ticketId: ticket.id }),
      ),
    ]),
  );

export const broadcastConfirm = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback(t('buttons.broadcastSend'), encodeCallback({ kind: 'admin-broadcast-send' }))],
    [Markup.button.callback(t('buttons.broadcastCancel'), encodeCallback({ kind: 'admin-broadcast-cancel' }))],
  ]);

export const purgeConfirm = () =>
  Markup.inlineKeyboard([[Markup.button.callback(t('buttons.purgeConfirm'), encodeCallback({ kind: 'admin-purge' }))]]);

export const featureToggles = (features: readonly { key: FeatureKey; name: string; enabled: boolean }[]) =>
  Markup.inlineKeyboard(
    features.map(feature => [
      Markup.button.callback(
        buttonLabel(t('admin.featureRowTemplate', { marker: feature.enabled ? '✅' : '⛔️', name: raw(feature.name) })),
        encodeCallback({ kind: 'admin-toggle-feature', feature: feature.key }),
      ),
    ]),
  );
