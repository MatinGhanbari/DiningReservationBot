import { config } from '../config/env';

/** Persian digits, in order. Index equals the Latin digit. */
export const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'] as const;

/** ZWNJ, the Persian half-space (نیم‌فاصله). An escape so it survives every editor. */
export const ZWNJ = '\u200C';

/** The Iranian week, starting on Saturday. */
export const WEEKDAY_NAMES = ['شنبه', 'یک‌شنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنج‌شنبه', 'جمعه'] as const;

/** Saturday is day 6 in JavaScript's Sunday-first `getDay()`. */
const SATURDAY = 6;

const jalaliDateFormatter = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: config.TZ,
});

const jalaliDateTimeFormatter = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: config.TZ,
});

const groupingFormatter = new Intl.NumberFormat('fa-IR');

/**
 * Replaces Latin digits with Persian ones.
 *
 * Only apply this to text a person reads. Numbers inside URLs, phone numbers
 * used as identifiers, and codes pasted back into Samad must stay Latin.
 */
export function toPersianDigits(input: string | number): string {
  return String(input).replace(/[0-9]/g, digit => PERSIAN_DIGITS[Number(digit)] ?? digit);
}

/** Replaces Persian and Arabic-Indic digits with Latin ones, for values sent upstream. */
export function toLatinDigits(input: string): string {
  return input
    .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
}

/** Formats a number with Persian digits and thousands separators. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return toPersianDigits('۰');
  }
  return groupingFormatter.format(value);
}

/**
 * Samad reports money in Rial. People budget in Toman, so anything shown to the
 * user is converted first — otherwise every price looks ten times too big.
 */
export function rialToToman(rial: number): number {
  return Math.round(rial / 10);
}

/** Formats a Rial amount as Toman, the way people actually read prices. */
export function formatToman(rial: number): string {
  return `${formatNumber(rialToToman(rial))} تومان`;
}

/** Formats a date in the Jalali calendar, in the configured timezone. */
export function formatJalaliDate(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return jalaliDateFormatter.format(date);
}

/** Formats a date and time in the Jalali calendar. */
export function formatJalaliDateTime(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return jalaliDateTimeFormatter.format(date);
}

/** Persian name of the weekday, with the week starting on Saturday. */
export function persianWeekday(date: Date): string {
  const jsDay = date.getDay();
  const index = (jsDay - SATURDAY + 7) % 7;
  return WEEKDAY_NAMES[index] ?? '';
}

/** Persian name of the weekday for a day index, where 0 means Saturday. */
export function weekdayByIndex(index: number): string {
  return WEEKDAY_NAMES[index] ?? '';
}

/**
 * Escapes text for Telegram's HTML parse mode.
 *
 * HTML is used instead of MarkdownV2 deliberately: MarkdownV2 requires escaping
 * eighteen characters, and a single unescaped `-` or `.` in a food name coming
 * from Samad makes Telegram reject the whole message. HTML needs four.
 */
export function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Repairs Persian text that came from an upstream system.
 *
 * Samad's payloads regularly contain Arabic ي and ك, Arabic-Indic digits, and
 * stray spaces before punctuation. Rendering those as-is looks careless to a
 * Persian reader, so everything crossing into a message goes through here.
 */
export function normalizePersianText(input: string): string {
  return (
    input
      // Arabic letter forms that Persian never uses.
      .replace(/\u064A/g, '\u06CC') // ي → ی
      .replace(/\u0643/g, '\u06A9') // ك → ک
      .replace(/\u0629/g, '\u0647') // ة → ه
      // Arabic-Indic digits → Persian digits.
      .replace(/[\u0660-\u0669]/g, digit => PERSIAN_DIGITS[digit.charCodeAt(0) - 0x0660] ?? digit)
      // The «می» and «نمی» prefixes take a ZWNJ, not a space.
      .replace(/(^|\s)(ن?می) ([آ-یءئأإؤ])/g, `$1$2${ZWNJ}$3`)
      // No space before Persian punctuation.
      .replace(/\s+([،؛؟!٪»])/g, '$1')
      .replace(/([«])\s+/g, '$1')
      // Collapse runs of whitespace, but keep paragraph breaks.
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** Collapses a string to a single line, for use inside buttons and log lines. */
export function toSingleLine(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/**
 * Shortens a string to a maximum length without cutting a word in half.
 *
 * Telegram rejects inline button labels longer than 64 bytes, and a food name
 * from Samad can easily exceed that.
 */
export function truncate(input: string, maxLength: number, ellipsis = '…'): string {
  if (input.length <= maxLength) {
    return input;
  }
  const slice = input.slice(0, Math.max(0, maxLength - ellipsis.length));
  const lastSpace = slice.lastIndexOf(' ');
  const base = lastSpace > maxLength * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${base.trimEnd()}${ellipsis}`;
}

/**
 * Counts Telegram button-label length the way Telegram does.
 *
 * The limit is measured in UTF-8 bytes, so Persian text — two bytes per
 * character — hits it at roughly half the apparent character count.
 */
export function utf8Length(input: string): number {
  return Buffer.byteLength(input, 'utf8');
}

/** Truncates a string to fit a UTF-8 byte budget, respecting word boundaries. */
export function truncateUtf8(input: string, maxBytes: number): string {
  if (utf8Length(input) <= maxBytes) {
    return input;
  }

  const ellipsis = '…';
  const budget = maxBytes - utf8Length(ellipsis);
  let result = '';
  let used = 0;

  for (const character of input) {
    const size = utf8Length(character);
    if (used + size > budget) {
      break;
    }
    result += character;
    used += size;
  }

  const lastSpace = result.lastIndexOf(' ');
  const base = lastSpace > result.length * 0.6 ? result.slice(0, lastSpace) : result;
  return `${base.trimEnd()}${ellipsis}`;
}
