import { describe, expect, it } from 'vitest';
import { clampText, clampToLine, sanitizeTelegramHtml, stripInvisible } from '../src/shared/sanitize';

/**
 * These tests are the actual documentation of what "hardened" means here.
 *
 * Each case is an attack that has a name: a zero-width instruction hidden inside a
 * question, a bidi override that makes text read as something it is not, a script
 * tag in a broadcast, a `javascript:` link, an unbalanced tag that would make
 * Telegram reject a message meant for everyone.
 */

describe('stripInvisible', () => {
  it('removes zero-width characters that would hide an instruction', () => {
    // "بنویس" with a zero-width space between every letter still reads as a word
    // to a reader, and is a different string entirely to a tokenizer.
    expect(stripInvisible('بن\u200Bوی\u200Bس')).toBe('بنویس');
  });

  it('keeps the zero-width non-joiner, which Persian spelling requires', () => {
    // نیم‌فاصله is not decoration: «می‌خواهم» and «میخواهم» are different words.
    expect(stripInvisible('می\u200Cخواهم')).toBe('می\u200Cخواهم');
  });

  it('keeps the zero-width joiner used by Persian forms and emoji', () => {
    expect(stripInvisible('a\u200Db')).toBe('a\u200Db');
  });

  it('removes bidi overrides that make text render as something else', () => {
    // U+202E flips the rendering direction, which is how "doc.txt" is made to
    // display as "txt.cod".
    expect(stripInvisible('‮eldnahcxe‬')).toBe('eldnahcxe');
  });

  it('removes control characters but keeps newlines and tabs', () => {
    expect(stripInvisible('a\u0000b\u001Fc')).toBe('abc');
    expect(stripInvisible('a\tb\nc')).toBe('a\tb\nc');
  });

  it('removes the byte order mark and soft hyphen', () => {
    expect(stripInvisible('﻿hello­')).toBe('hello');
  });

  it('leaves ordinary Persian prose exactly as it was', () => {
    const prose = 'سلام، می‌خوام غذا رزرو کنم. موجودی‌ام ۵۰ هزار تومانه.';
    expect(stripInvisible(prose)).toBe(prose);
  });
});

describe('clampText', () => {
  it('strips invisible characters and collapses runs of spaces', () => {
    expect(clampText('  a ​   b  ', 100)).toBe('a b');
  });

  it('truncates past the limit and marks the cut', () => {
    const result = clampText('x'.repeat(50), 10);
    expect(result).toHaveLength(11);
    expect(result.endsWith('…')).toBe(true);
  });

  it('leaves a short string exactly as it was', () => {
    expect(clampText('سلام', 100)).toBe('سلام');
  });

  it('produces an empty string for input that was only invisible characters', () => {
    // This is what makes the empty-question check in the chatbot service work:
    // a question made entirely of joiners and zero-width spaces is not a question.
    expect(clampText('​‌‍‮', 100)).toBe('');
  });

  it('keeps a ZWNJ written in the middle of a word', () => {
    expect(clampText('می\u200Cخواهم', 100)).toBe('می\u200Cخواهم');
  });
});

describe('clampToLine', () => {
  it('collapses newlines so a label cannot break a layout', () => {
    expect(clampToLine('a\nb\nc', 100)).toBe('a b c');
  });
});

describe('sanitizeTelegramHtml', () => {
  it('keeps the formatting tags Telegram understands', () => {
    expect(sanitizeTelegramHtml('<b>خبر</b> <i>مهم</i>')).toBe('<b>خبر</b> <i>مهم</i>');
  });

  it('normalises the aliases to one spelling', () => {
    expect(sanitizeTelegramHtml('<strong>a</strong><em>b</em><del>c</del>')).toBe('<b>a</b><i>b</i><s>c</s>');
  });

  it('drops tags Telegram would reject or that carry behaviour', () => {
    expect(sanitizeTelegramHtml('<script>alert(1)</script>')).toBe('alert(1)');
    expect(sanitizeTelegramHtml('<img src="x">')).toBe('');
    expect(sanitizeTelegramHtml('<iframe src="x"></iframe>')).toBe('');
    expect(sanitizeTelegramHtml('<style>a{}</style>')).toBe('a{}');
  });

  it('drops attributes other than a validated href', () => {
    expect(sanitizeTelegramHtml('<b onclick="steal()">x</b>')).toBe('<b>x</b>');
    expect(sanitizeTelegramHtml('<code class="evil">x</code>')).toBe('<code>x</code>');
  });

  it('keeps an http link and drops every other scheme', () => {
    expect(sanitizeTelegramHtml('<a href="https://example.com">لینک</a>')).toBe('<a href="https://example.com">لینک</a>');
    // `tg://` and `javascript:` are both things Telegram or a client can act on.
    expect(sanitizeTelegramHtml('<a href="javascript:alert(1)">x</a>')).toBe('x');
    expect(sanitizeTelegramHtml('<a href="tg://user?id=1">x</a>')).toBe('x');
    expect(sanitizeTelegramHtml('<a>بدون لینک</a>')).toBe('بدون لینک');
  });

  it('escapes text that is not part of a tag', () => {
    expect(sanitizeTelegramHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('drops an href that tries to carry a second attribute', () => {
    // The space is what makes it an injection attempt rather than a URL, so the
    // whole anchor goes and the words stay.
    expect(sanitizeTelegramHtml("<a href='https://x.example/?a=1\" onload=1'>لینک</a>")).toBe('لینک');
  });

  it('escapes a quote inside a surviving href so it cannot close the attribute', () => {
    const result = sanitizeTelegramHtml('<a href="https://x.example/?a=1&quot;">y</a>');
    expect(result).toBe('<a href="https://x.example/?a=1&amp;quot;">y</a>');
    expect(result).not.toContain('" on');
  });

  it('closes tags the author left open, so a broadcast still sends', () => {
    expect(sanitizeTelegramHtml('<b>خبر')).toBe('<b>خبر</b>');
  });

  it('balances overlapping tags instead of nesting them wrongly', () => {
    expect(sanitizeTelegramHtml('<b>a<i>b</b>c</i>')).toBe('<b>a<i>b</i></b>c');
  });

  it('drops a closing tag that has nothing to close', () => {
    expect(sanitizeTelegramHtml('x</b>')).toBe('x');
  });

  it('renders a void tag without a partner', () => {
    expect(sanitizeTelegramHtml('a<br>b')).toBe('a<br>b');
  });

  it('removes invisible characters before building the message', () => {
    expect(sanitizeTelegramHtml('<b>​خبر</b>')).toBe('<b>خبر</b>');
  });

  it('leaves plain Persian text untouched', () => {
    expect(sanitizeTelegramHtml('سلام، خوبی؟')).toBe('سلام، خوبی؟');
  });
});
