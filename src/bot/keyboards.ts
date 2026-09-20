import { Markup } from 'telegraf';
import type { MealOption, ReservedMeal, Self } from '../domain/models';
import { WEEKDAY_NAMES } from '../shared/persian';
import { copy, selfButton } from '../copy/fa';
import { encodeCallback } from './callback-data';
import type { WeekSelection } from '../app/reservation.service';

/**
 * Button labels live next to the keyboards rather than in the copy module.
 *
 * Reply-keyboard buttons are matched by their exact text in `bot.hears()`, so the
 * label and the matcher have to be the same string. Putting them together makes
 * that impossible to get wrong — a drifted label is a button that silently stops
 * working, which is exactly what happened to the original `MESSAGES` constants.
 */
export const BTN = {
  reserveFood: '🍽️ رزرو غذا',
  autoReserve: '⚙️ رزرو خودکار',
  thisWeekReserves: '📋 رزروهای این هفته',
  nextWeekReserves: '📋 رزروهای هفتهٔ بعد',
  forgetCode: '🎫 کد فراموشی',
  myInfo: '👤 اطلاعات من',
  about: '💡 دربارهٔ ربات',
  support: '📮 پشتیبانی',
  logout: '🚪 خروج',
  login: '🔑 ورود به حساب کاربری',
  back: '‹ برگشت به منوی اصلی',
  // Forget-code submenu
  shareForgetCode: '🤝 ارسال کد فراموشی',
  receiveForgetCode: '🙋 دریافت کد فراموشی',
  reportBadCode: '⚠️ گزارش کد خراب',
  // Auto-reserve submenu
  autoReserveDays: '📅 تغییر روزها',
  autoReserveEnable: '✅ فعال کردن',
  autoReserveDisable: '⛔️ غیرفعال کردن',
  autoReserveChangeSelf: '🍽️ تغییر سلف',
} as const;

/**
 * Every reply-keyboard label, as a set.
 *
 * The login wizard uses this to decide whether an incoming message is an answer
 * to its question or the user changing their mind. Without it, someone who taps
 * «خروج» halfway through typing a password would have «خروج» submitted as their
 * password.
 */
const MENU_LABELS: ReadonlySet<string> = new Set(Object.values(BTN));

export function isMenuButton(text: string): boolean {
  return MENU_LABELS.has(text);
}

export const mainMenu = () =>
  Markup.keyboard([
    [Markup.button.text(BTN.reserveFood), Markup.button.text(BTN.autoReserve)],
    [Markup.button.text(BTN.thisWeekReserves), Markup.button.text(BTN.nextWeekReserves)],
    [Markup.button.text(BTN.forgetCode)],
    [Markup.button.text(BTN.myInfo), Markup.button.text(BTN.about), Markup.button.text(BTN.support)],
    [Markup.button.text(BTN.logout)],
  ]).resize();

export const backMenu = () => Markup.keyboard([[Markup.button.text(BTN.back)]]).resize();

export const loginMenu = () => Markup.keyboard([[Markup.button.text(BTN.login)]]).resize();

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

/** Inline picker for the university, so the choice is validated by id rather than by typed text. */
export const universityPicker = (universities: readonly { id: number; name: string; shortName: string }[]) =>
  Markup.inlineKeyboard(
    universities.map(university => [
      Markup.button.callback(university.shortName, encodeCallback({ kind: 'select-university', universityId: university.id })),
    ]),
  );

export const selfPicker = (week: WeekSelection, selfs: readonly Self[]) =>
  Markup.inlineKeyboard(
    selfs.map(self => [
      Markup.button.callback(selfButton(self.name), encodeCallback({ kind: 'select-self', week, selfId: self.id })),
    ]),
  );

/**
 * One button per meal, labelled with the index the message body uses.
 *
 * Labels are truncated by byte count inside `copy`, because Telegram's 64-byte
 * limit on callback text counts UTF-8 bytes and Persian costs two per character.
 */
export const mealPicker = (meals: readonly MealOption[]) =>
  Markup.inlineKeyboard(
    meals.map((meal, index) => [
      Markup.button.callback(
        copy.reservation.mealButton(index + 1, meal.foodName),
        encodeCallback({ kind: 'reserve-meal', programId: meal.programId, foodTypeId: meal.foodTypeId }),
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

/** Weekday toggles, checked marks showing what is already selected. */
export const weekdayPicker = (selected: readonly number[]) => {
  const selectedSet = new Set(selected);

  const buttons = WEEKDAY_NAMES.map((name, index) =>
    Markup.button.callback(
      `${selectedSet.has(index) ? '✅' : '▫️'} ${name}`,
      encodeCallback({ kind: 'auto-reserve-day', weekday: index }),
    ),
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

/**
 * Confirmation before giving a meal away.
 *
 * Sharing a code costs the user that meal, so it never happens on a single tap.
 */
export const shareConfirm = (reserveId: number) =>
  Markup.inlineKeyboard([
    [Markup.button.callback('✅ آره، قسمت کن', encodeCallback({ kind: 'forget-code-share-confirm', reserveId }))],
    [Markup.button.callback('‹ نه، بی‌خیال', encodeCallback({ kind: 'show-reserves', week: 'current' }))],
  ]);

export const receiveSelfPicker = (selfs: readonly Self[]) =>
  Markup.inlineKeyboard(
    selfs.map(self => [
      Markup.button.callback(selfButton(self.name), encodeCallback({ kind: 'forget-code-receive-self', selfId: self.id })),
    ]),
  );

export const autoReserveSelfPicker = (selfs: readonly Self[]) =>
  Markup.inlineKeyboard(
    selfs.map(self => [
      Markup.button.callback(selfButton(self.name), encodeCallback({ kind: 'auto-reserve-self', selfId: self.id })),
    ]),
  );
