/**
 * Input hardening.
 *
 * Three problems are handled here, and all three are the same shape: text that
 * arrives from outside and is then acted on as if it were trustworthy.
 *
 *   1. **Invisible characters.** Zero-width joiners and bidi overrides make a
 *      string render as something it is not. They are how a " harmless" question
 *      hides an instruction from a language model, and how a name from Samad can
 *      be made to display as a different name.
 *   2. **Unbounded length.** Anything a user types is a request for work. A
 *      question of a hundred thousand characters is a bill and a context
 *      overflow, not a question.
 *   3. **Markup in a broadcast.** An admin writes HTML that goes to every user.
 *      A tag outside the allowlist — a script, an iframe, an image beacon, a
 *      `tg://` scheme — turns an announcement into an attack, so only the tags
 *      Telegram actually understands survive.
 */

/**
 * Control, formatting and bidi characters that never belong in user content.
 *
 * What is deliberately *not* in this list matters as much as what is:
 *
 *   - **U+200C, the zero-width non-joiner** — Persian orthography requires it.
 *     The Persian word «می‌خواهم» ("I want") without it is «میخواهم», which is
 *     simply wrong, and stripping it would mangle every correctly written
 *     message the bot ever sends.
 *   - **U+200D, the zero-width joiner** — needed for the few Persian forms and
 *     emoji sequences that join across it.
 *
 * The characters below are the ones whose only use is to make text render as
 * something it is not: a zero-width space that hides a word boundary, a bidi
 * override that reverses what a reader sees.
 */
const INVISIBLE_PATTERN = new RegExp(
  [
    '[\\u0000-\\u0008]', // NUL and the C0 controls, except tab
    '[\\u000B-\\u001F]', // the rest of the C0 controls, except newline
    '[\\u007F-\\u009F]', // DEL and the C1 controls
    '[\\u00AD]', // soft hyphen
    '[\\u200B]', // zero-width space
    '[\\u200E-\\u200F]', // left-to-right and right-to-left marks
    '[\\u202A-\\u202E]', // bidi embedding and override
    '[\\u2060-\\u206F]', // word joiner and the bidi isolates
    '[\\uFEFF]', // byte order mark
  ].join('|'),
  'gu',
);

/** The two joiners that stay, but that are not content when they stand alone. */
const EDGE_JOINER_PATTERN = /^[‌‍]+|[‌‍]+$/gu;

/**
 * Removes characters that change how a string renders without changing what it
 * says.
 *
 * Tab, newline and carriage return are kept: they are visible to a reader and are
 * part of ordinary multi-line input.
 */
export function stripInvisible(input: string): string {
  return input.replace(INVISIBLE_PATTERN, '');
}

/**
 * Trims a string to a maximum length and removes the invisible characters.
 *
 * Applied on the way in rather than at the point of use, so every downstream
 * consumer — the database, the language model, the log line — sees the same
 * bounded, honest text.
 *
 * Joiners hanging off either end are dropped as well, so a string made of nothing
 * but joiners is empty rather than "technically has characters".
 */
export function clampText(input: string, maxLength: number): string {
  const cleaned = stripInvisible(input)
    .replace(EDGE_JOINER_PATTERN, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength).trimEnd()}…`;
}

/**
 * Collapses a string to a single line and clamps it, for button labels and log
 * fields where a newline would corrupt the format.
 */
export function clampToLine(input: string, maxLength: number): string {
  return clampText(input.replace(/\s+/g, ' '), maxLength);
}

/** The formatting tags Telegram's HTML parse mode understands. */
const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ins',
  's',
  'strike',
  'del',
  'code',
  'pre',
  'blockquote',
  'tg-spoiler',
  'a',
  'br',
]);

/** Aliases Telegram accepts but that we normalise, so the output is predictable. */
const TAG_ALIASES: Record<string, string> = { strong: 'b', em: 'i', ins: 'u', strike: 's', del: 's' };

/** Tags that never take a closing partner. */
const VOID_TAGS: ReadonlySet<string> = new Set(['br']);

const TAG_PATTERN = /<\/?[a-zA-Z][a-zA-Z0-9-]*\b[^>]*>/g;
const HREF_PATTERN = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

interface SanitizedTag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
}

function parseTag(token: string): SanitizedTag | null {
  const match = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(token);

  if (match === null) {
    return null;
  }

  const rawName = (match[1] ?? '').toLowerCase();

  if (!ALLOWED_TAGS.has(rawName)) {
    return null;
  }

  return {
    name: TAG_ALIASES[rawName] ?? rawName,
    closing: token.startsWith('</'),
    selfClosing: /\/\s*>$/.test(token),
  };
}

/**
 * Rewrites one `<a>` tag, keeping only an `http(s)` target.
 *
 * Telegram also understands `tg://`, and a broadcast is the one place where a
 * link is clicked by everyone at once — so anything that is not a plain web
 * address is dropped rather than passed through.
 */
function renderAnchor(token: string): string {
  const href = HREF_PATTERN.exec(token);
  const target = (href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim();

  if (!/^https?:\/\/[^\s]+$/i.test(target)) {
    return '';
  }

  return `<a href="${escapeAttribute(target)}">`;
}

/** Escapes the four characters Telegram's HTML mode cares about. */
function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Escapes a value used inside a double-quoted attribute. */
function escapeAttribute(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Reduces admin-authored HTML to the tags Telegram understands.
 *
 * Disallowed tags are removed rather than escaped: an admin writing `<script>`
 * almost certainly meant to write literal text, and the safest reading of the
 * intent is to drop the markup and keep the words.
 *
 * Tags are rebalanced on the way out. Telegram rejects a message whose tags do
 * not nest correctly, and a broadcast that fails to send reaches nobody — so a
 * missing closing tag is closed here instead of becoming an outage.
 */
export function sanitizeTelegramHtml(input: string): string {
  const cleaned = stripInvisible(input);
  const parts = cleaned.split(TAG_PATTERN);
  const tags = cleaned.match(TAG_PATTERN) ?? [];

  const open: string[] = [];
  const output: string[] = [];

  const closeThrough = (name: string): void => {
    const depth = open.lastIndexOf(name);

    if (depth === -1) {
      return;
    }

    while (open.length > depth) {
      output.push(`</${open.pop() as string}>`);
    }
  };

  for (let index = 0; index < parts.length; index += 1) {
    output.push(escapeHtml(parts[index] ?? ''));

    // `split` drops the separators and `match` keeps them, so the tag at index
    // `i` is the one that appeared between segment `i` and segment `i + 1`.
    const token = tags[index];

    if (token === undefined) {
      continue;
    }

    const tag = parseTag(token);

    if (tag === null) {
      continue;
    }

    if (tag.closing) {
      closeThrough(tag.name);
      continue;
    }

    if (tag.name === 'a') {
      const rendered = renderAnchor(token);

      if (rendered.length === 0) {
        continue;
      }

      open.push('a');
      output.push(rendered);
      continue;
    }

    if (VOID_TAGS.has(tag.name) || tag.selfClosing) {
      output.push(`<${tag.name}>`);
      continue;
    }

    open.push(tag.name);
    output.push(`<${tag.name}>`);
  }

  while (open.length > 0) {
    output.push(`</${open.pop() as string}>`);
  }

  return output.join('');
}
