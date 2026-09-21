import { Markup } from 'telegraf';
import type { MealOption, ReservedMeal, Self } from '../domain/models';
import { WEEKDAY_NAMES } from '../shared/persian';
import { copy, buttonLabel, selfButton } from '../copy/fa';
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
  // Support submenu
  supportChatbot: '🤖 پرسیدن از دستیار',
  supportHuman: '✍️ پیام به پشتیبانی',
  // Admin panel
  adminPanel: '🛠️ پنل مدیریت',
  adminStats: '📊 آمار کلی',
  adminUsers: '👥 کاربران',
  adminSupport: '📮 تیکت‌های پشتیبانی',
  adminChatbot: '🤖 گزارش چت‌بات',
  adminBroadcast: '📣 پیام همگانی',
  adminSystem: '🖥️ وضعیت سیستم',
  adminMaintenance: '🧹 نگهداری',
  adminBackup: '💾 پشتیبان‌گیری',
  adminBack: '‹ برگشت به پنل',
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

/**
 * The main menu.
 *
 * The admin row is appended rather than shown to everyone, so the panel is
 * discoverable without advertising itself to users who cannot open it.
 */
export const mainMenu = (admin = false) => {
  const rows = [
    [Markup.button.text(BTN.reserveFood), Markup.button.text(BTN.autoReserve)],
    [Markup.button.text(BTN.thisWeekReserves), Markup.button.text(BTN.nextWeekReserves)],
    [Markup.button.text(BTN.forgetCode)],
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

/** The support submenu. The chatbot row disappears when no model is configured. */
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
    [Markup.button.text(BTN.adminBroadcast), Markup.button.text(BTN.adminSystem)],
    [Markup.button.text(BTN.adminMaintenance), Markup.button.text(BTN.adminBackup)],
    [Markup.button.text(BTN.back)],
  ]).resize();

/** Keyboard for an admin sub-screen, where "back" means the panel, not the main menu. */
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

/** Inline picker for the university, so the choice is validated by id rather than by typed text. */
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

/** Weekday toggles, checked marks showing what is already selected. */
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
    selfs.map(self => [Markup.button.callback(selfButton(self.name), encodeCallback({ kind: 'auto-reserve-self', selfId: self.id }))]),
  );

// ── Admin panel ─────────────────────────────────────────────────────────────

/** Inline shortcuts to the most recent users, so the admin rarely has to type an id. */
export const adminUserPicker = (users: readonly { telegramId: number; displayName: string }[]) =>
  Markup.inlineKeyboard(
    users.map(user => [
      Markup.button.callback(buttonLabel(user.displayName), encodeCallback({ kind: 'admin-user', telegramId: user.telegramId })),
    ]),
  );

/** Opening a user, with the one destructive action behind a confirmation step. */
export const userActions = (telegramId: number) =>
  Markup.inlineKeyboard([[Markup.button.callback('🚪 جدا کردن حساب', encodeCallback({ kind: 'admin-logout-prompt', telegramId }))]]);

export const logoutConfirm = (telegramId: number) =>
  Markup.inlineKeyboard([
    [Markup.button.callback('✅ آره، جدا کن', encodeCallback({ kind: 'admin-logout-confirm', telegramId }))],
    [Markup.button.callback('‹ نه، بی‌خیال', encodeCallback({ kind: 'admin-user', telegramId }))],
  ]);

/** One close button per open ticket, labelled with the ticket and its owner. */
export const ticketList = (tickets: readonly { id: number; displayName: string }[]) =>
  Markup.inlineKeyboard(
    tickets.map(ticket => [
      Markup.button.callback(
        buttonLabel(`🔒 #${ticket.id} · ${ticket.displayName}`),
        encodeCallback({ kind: 'admin-close-ticket', ticketId: ticket.id }),
      ),
    ]),
  );

export const broadcastConfirm = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📣 آره، بفرست', encodeCallback({ kind: 'admin-broadcast-send' }))],
    [Markup.button.callback('‹ نه، بی‌خیال', encodeCallback({ kind: 'admin-broadcast-cancel' }))],
  ]);

export const purgeConfirm = () =>
  Markup.inlineKeyboard([[Markup.button.callback('🧹 پاک‌سازی کن', encodeCallback({ kind: 'admin-purge' }))]]);
