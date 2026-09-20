import { describe, expect, it } from 'vitest';
import {
  ZWNJ,
  escapeHtml,
  formatToman,
  normalizePersianText,
  persianWeekday,
  toLatinDigits,
  toPersianDigits,
  truncateUtf8,
  utf8Length,
} from '../src/shared/persian';
import { toMealDateKey, weekdayIndexOf } from '../src/shared/dates';

describe('digits', () => {
  it('renders Latin digits as Persian ones', () => {
    expect(toPersianDigits(1404)).toBe('۱۴۰۴');
    expect(toPersianDigits('12:30')).toBe('۱۲:۳۰');
  });

  it('leaves non-digits untouched', () => {
    expect(toPersianDigits('سلف ۵ مرکزی')).toBe('سلف ۵ مرکزی');
  });

  it('converts Persian and Arabic-Indic digits back to Latin for upstream calls', () => {
    expect(toLatinDigits('۱۴۰۴')).toBe('1404');
    expect(toLatinDigits('٤٥٦')).toBe('456');
  });
});

describe('normalizePersianText', () => {
  it('replaces the Arabic letter forms Persian never uses', () => {
    // ي (U+064A) and ك (U+0643) arrive from Samad and look wrong to a Persian reader.
    expect(normalizePersianText('كتابي')).toBe('کتابی');
  });

  it('replaces Arabic-Indic digits with Persian ones', () => {
    expect(normalizePersianText('ساعت ١٢')).toBe('ساعت ۱۲');
  });

  it('joins the می prefix with a ZWNJ instead of a space', () => {
    expect(normalizePersianText('می روم')).toBe(`می${ZWNJ}روم`);
    expect(normalizePersianText('نمی دانم')).toBe(`نمی${ZWNJ}دانم`);
  });

  it('removes the space that upstream payloads leave before punctuation', () => {
    expect(normalizePersianText('سلام ، خوبی ؟')).toBe('سلام، خوبی؟');
  });

  it('collapses runs of spaces but keeps paragraph breaks', () => {
    expect(normalizePersianText('یک    دو\n\n\n\nسه')).toBe('یک دو\n\nسه');
  });
});

describe('escapeHtml', () => {
  it('escapes the four characters Telegram HTML cares about', () => {
    expect(escapeHtml('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot;');
  });

  it('makes a food name from Samad safe to interpolate', () => {
    // A bare & would make Telegram reject the entire message.
    expect(escapeHtml('مرغ & برنج')).toBe('مرغ &amp; برنج');
  });
});

describe('truncateUtf8', () => {
  it('measures Persian in bytes, not characters', () => {
    // Telegram caps button labels at 64 bytes and Persian costs two per character.
    expect(utf8Length('سلف')).toBe(6);
  });

  it('leaves text that already fits alone', () => {
    expect(truncateUtf8('سلف مرکزی', 64)).toBe('سلف مرکزی');
  });

  it('truncates without exceeding the byte budget', () => {
    const long = 'سلف مرکزی دانشگاه صنعتی خواجه نصیرالدین طوسی';
    const result = truncateUtf8(long, 20);

    expect(utf8Length(result)).toBeLessThanOrEqual(20);
    expect(result.endsWith('…')).toBe(true);
  });

  it('stops at a word boundary when one is close to the cut', () => {
    // The byte budget allows part of the second word, but the space is late
    // enough in the string that cutting back to it reads better.
    expect(truncateUtf8('چلوکباب خوشمزه', 20)).toBe('چلوکباب…');
  });
});

describe('money', () => {
  it('shows Rial as Toman, because that is how people read prices', () => {
    // Samad reports 120000 Rial, which is 12000 Toman.
    expect(formatToman(120_000)).toContain('۱۲٬۰۰۰');
    expect(formatToman(120_000)).toContain('تومان');
  });
});

describe('dates', () => {
  it('keys a meal by calendar day in the configured timezone', () => {
    // Tehran is UTC+3:30, so 21:00 UTC is already the next calendar day there.
    expect(toMealDateKey(new Date('2026-09-20T21:00:00Z'))).toBe('2026-09-21');
    expect(toMealDateKey(new Date('2026-09-20T20:00:00Z'))).toBe('2026-09-20');
  });

  it('counts weekdays from Saturday, the way an Iranian calendar does', () => {
    // 2026-09-19 is a Saturday.
    expect(weekdayIndexOf(new Date('2026-09-19T09:00:00Z'))).toBe(0);
    expect(weekdayIndexOf(new Date('2026-09-20T09:00:00Z'))).toBe(1);
    expect(weekdayIndexOf(new Date('2026-09-25T09:00:00Z'))).toBe(6);
  });

  it('names the weekday in Persian', () => {
    expect(persianWeekday(new Date('2026-09-19T09:00:00Z'))).toBe('شنبه');
  });
});
