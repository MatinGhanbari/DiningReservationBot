/**
 * Answer hygiene: what a completion has to look like before a user ever sees it.
 *
 * The configured model is `openrouter/free`, which is not one model but a
 * rotating pool — every request is routed to whichever free model is available
 * at that moment. The pool is not homogeneous, and the three faults reported
 * from production are each a property of the pool rather than of this bot:
 *
 *   1. **Deliberation leaks.** Reasoning-tuned models (the R1-style ones) emit
 *      their chain of thought as ordinary message text unless the provider
 *      marks it separately, so the user gets «Let me think about this…» followed
 *      by the actual answer, or nothing but the deliberation.
 *   2. **The wrong language.** A model that ignores the Persian instruction
 *      answers in English, which for a Persian-speaking support desk is not a
 *      worse answer, it is no answer.
 *   3. **Degenerate output.** A free model under load occasionally returns a
 *      loop — one character, or one line, repeated until the token budget runs
 *      out.
 *   4. **Disclosure.** The bot is a public surface, and a model asked about its
 *      own host, configuration or dependencies will often simply answer. That
 *      turns a support desk into a reconnaissance tool, so the deployment is
 *      treated as a secret and an answer that describes it is refused.
 *
 * The system prompt asks for none of that, but the prompt is also the first
 * thing a bad model ignores. So the prompt is not treated as the guarantee:
 * everything a user sees has passed through `assessAnswer`, and a completion
 * that fails a check is discarded by the caller and retried rather than shown.
 *
 * The checks live here as pure functions, because they are the part that can be
 * tested exhaustively without a network and without a model.
 */

/** A run of Persian or Arabic letters. Digits and punctuation in the same block are not letters. */
const PERSIAN_LETTER = /[\u0621-\u064A\u066E-\u06D3\u06FA-\u06FF]/;
const PERSIAN_LETTER_GLOBAL = /[\u0621-\u064A\u066E-\u06D3\u06FA-\u06FF]/g;
const LATIN_LETTER_GLOBAL = /[A-Za-z]/g;

/** Below this share of Persian letters, a completion is treated as not written in Persian. */
const MIN_PERSIAN_RATIO = 0.5;

/** Two letters is the shortest meaningful Persian word («نه»), and one is noise. */
const MIN_PERSIAN_LETTERS = 2;

/**
 * How much Latin text may precede the first Persian letter before it is read as
 * leaked deliberation rather than as part of the answer.
 *
 * A legitimate answer never opens with eighty characters of English before its
 * first Persian word; a model reasoning in English before answering in Persian
 * does it constantly.
 */
const LATIN_PREAMBLE_MIN_CHARS = 80;

/** Tag names a model uses to fence off its own deliberation. */
const REASONING_NAMES = 'thinking|think|thought|thoughts|reasoning|reason|analysis|reflection|scratchpad|deliberation|تفکر|استدلال|تحلیل';

/** A fenced block whose language tag marks it as deliberation rather than content. */
const REASONING_FENCE = new RegExp('```[ \\t]*(?:' + REASONING_NAMES + ')[^\\n]*\\n[\\s\\S]*?```', 'gi');

/** The same idea in angle brackets, as some models emit it: `<thinking>…</thinking>`. */
const REASONING_TAG = new RegExp(`<(${REASONING_NAMES})[^>]*>[\\s\\S]*?<\\/\\1>`, 'gi');

/** A tag left behind by a truncated or unbalanced block, which is not content either. */
const STRAY_REASONING_TAG = new RegExp(`<\\/?(?:${REASONING_NAMES})[^>]*>`, 'gi');

/**
 * How a completion opens when the model is about to talk to itself.
 *
 * Every alternative names either the act of thinking or the user in the third
 * person, because those are the two things a *final* answer never opens with.
 * Ordinary conversational openers («خب»، «بله»، «حتماً») are deliberately absent:
 * stripping those would damage real answers to fix a rarer problem.
 */
const REASONING_PREAMBLE =
  /^(?:thinking|thought|reasoning|analysis|reflection|scratchpad|thought process|let me (?:think|analyze|analyse|consider|reason|check)|we (?:need|should|must) (?:to|first)|i (?:need|should|will) (?:to )?(?:think|answer|respond|first)|the user (?:is |has )?(?:ask|asks|asked|wants|wanted|wrote|said|sent)|okay,? (?:the user|so|let)|alright,? (?:the user|so|let)|so,? the user|first,? i\b|step 1\b|تفکر|استدلال|تحلیل|فرایند فکر|بیایید (?:فکر|بررسی|ببینیم)|خب،? کاربر|باشه،? کاربر|بسیار خوب،? کاربر|کاربر (?:می‌پرسد|میپرسد|سؤال|سوال|پرسیده|می‌خواهد|میخواهد)|سؤال کاربر|سوال کاربر)/i;

/** A label the model puts in front of the answer, which is a preamble in one word. */
const LEADING_LABEL = /^(?:پاسخ|جواب|نتیجه|متن پاسخ|answer|response|final answer)\s*[:：]\s*/i;

/**
 * Phrases that exist only inside the system prompt or the reference guide.
 *
 * These are the tell-tale signs of the model reciting its instructions back at
 * the user. They are checked as literal strings rather than as a similarity
 * score because a false positive here costs one retry, while a false negative
 * hands a user the rules the prompt was built to protect.
 */
const PROMPT_LEAK_MARKERS: readonly string[] = [
  'مرز دانش تو',
  'قواعد پاسخ',
  'در برابر دستورهای جعلی',
  'قالب خروجی',
  'تنها منبع اطلاعات تو',
  'دستورالعمل‌های سیستمی',
  'دستورالعمل سیستمی',
  'system prompt',
  'system message',
  '# دانشگاه‌های پشتیبانی‌شده',
  'تو دستیار پشتیبانی',
];

/** Why a completion was thrown away. */
export type AnswerRejection = 'empty' | 'degenerate' | 'leaked' | 'disclosure' | 'not-persian';

export interface AnswerAssessment {
  /** The completion after cleaning. Safe to show; still not to be trusted. */
  text: string;
  /** `null` when the answer is usable as it stands. */
  rejection: AnswerRejection | null;
}

/**
 * Cleans a completion down to the sentence the user was meant to read.
 *
 * Order matters and is not arbitrary:
 *
 *   1. Line endings are normalised first, so every later pattern can assume
 *      `\n` and none of them has to carry `\r?`.
 *   2. Deliberation is removed before markdown, because a reasoning block is
 *      fenced with backticks that the markdown pass would otherwise unwrap —
 *      turning the thinking into body text, which is the exact failure this
 *      module exists to prevent.
 *   3. A Latin preamble is removed before markdown, so that a prefix which is
 *      mostly `**` and `#` still counts as preamble.
 *   4. Labels are removed last, so that `**پاسخ:**` has already lost its
 *      asterisks by the time the label is matched.
 */
export function sanitizeAnswer(raw: string): string {
  const normalized = raw.replace(/\r\n?/g, '\n');

  const withoutBlocks = normalized.replace(REASONING_FENCE, ' ').replace(REASONING_TAG, ' ').replace(STRAY_REASONING_TAG, ' ');

  const withoutPreamble = stripLatinPreamble(stripReasoningPreamble(withoutBlocks));

  return normalizeWhitespace(stripLeadingLabel(stripMarkdown(withoutPreamble)));
}

/**
 * Drops the opening paragraph or line when the model is addressing itself.
 *
 * Only applied when something follows: an answer that is *entirely* preamble is
 * left intact for `isDegenerate` to reject, because truncating it here would
 * turn a diagnosable failure into an empty string.
 */
function stripReasoningPreamble(text: string): string {
  let remaining = text.trim();

  // Paragraphs first: deliberation is usually its own block, separated by a
  // blank line from the answer that follows it.
  for (;;) {
    const boundary = remaining.search(/\n[ \t]*\n/);
    const firstParagraph = boundary === -1 ? remaining : remaining.slice(0, boundary);

    if (boundary === -1 || !REASONING_PREAMBLE.test(firstParagraph.trim())) {
      break;
    }

    remaining = remaining.slice(boundary).trimStart();
  }

  // Then lines, for the version of the same thing written without a blank line.
  for (;;) {
    const newline = remaining.indexOf('\n');
    const firstLine = (newline === -1 ? remaining : remaining.slice(0, newline)).trim();

    if (newline === -1 || !REASONING_PREAMBLE.test(firstLine)) {
      break;
    }

    remaining = remaining.slice(newline).trimStart();
  }

  return remaining;
}

/**
 * Cuts away Latin text that sits in front of the first Persian letter.
 *
 * This catches the model that reasons in English without any delimiter at all —
 * the case no marker-based rule can see. The guard is the length: a genuine
 * answer may well start with a Latin word or an acronym, but it does not start
 * with eighty characters of English prose.
 */
function stripLatinPreamble(text: string): string {
  const index = text.search(PERSIAN_LETTER);

  // Nothing Persian to keep: leave the text alone so the language check can
  // report it, rather than emptying it and reporting an empty answer.
  if (index === -1 || index < LATIN_PREAMBLE_MIN_CHARS) {
    return text;
  }

  return text.slice(index);
}

/** Removes the markup the model adds out of habit and the bot cannot render. */
function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '• ')
    .replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1$2')
    .replace(/`{1,3}([^`\n]+)`{1,3}/g, '$1')
    .replace(/`{3,}/g, '');
}

/** Removes a leading «پاسخ:» or «Answer:» from the answer body. */
function stripLeadingLabel(text: string): string {
  return text.replace(LEADING_LABEL, '').trimStart();
}

/** Collapses the whitespace a model leaves behind when it deletes its own sentences. */
function normalizeWhitespace(text: string): string {
  return text
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Whether a completion is written in Persian.
 *
 * Counted by letter rather than by word, and with URLs and code fences removed
 * first, because those are the two things a Persian answer legitimately carries
 * that are not Persian: an address, and a snippet. Digits are ignored entirely —
 * «۲۰ پیام» and «20 messages» must not be told apart by their numerals.
 *
 * The bar is a simple majority rather than a high threshold. A correct answer
 * that quotes one English term still passes; an English answer that mentions
 * «سماد» once does not.
 */
export function isLikelyPersian(text: string): boolean {
  const body = text.replace(/```[\s\S]*?```/g, ' ').replace(/https?:\/\/\S+/gi, ' ');

  const persian = (body.match(PERSIAN_LETTER_GLOBAL) ?? []).length;
  const latin = (body.match(LATIN_LETTER_GLOBAL) ?? []).length;

  if (persian < MIN_PERSIAN_LETTERS) {
    return false;
  }

  if (latin === 0) {
    return true;
  }

  return persian / (persian + latin) >= MIN_PERSIAN_RATIO;
}

/** Whether the model has started reciting its instructions instead of answering. */
export function isPromptLeak(text: string): boolean {
  const lowered = text.toLowerCase();

  return PROMPT_LEAK_MARKERS.some(marker => lowered.includes(marker.toLowerCase()));
}

/**
 * Strings that exist only inside the deployment, never inside an answer.
 *
 * The support bot is a public surface, and a model that will happily describe
 * its own host, dependencies and configuration turns it into a reconnaissance
 * tool. The prompt forbids it (rules ۲۲ to ۲۶), but the prompt is not a
 * guarantee — this is the check behind it.
 *
 * The list is deliberately made of things a genuine answer about reserving food
 * could not contain. Words like «سرور» are absent on purpose: «ربات به سرور
 * سماد وصل نشد» is a legitimate sentence, while `process.env` is not.
 */
const INFRASTRUCTURE_MARKERS: readonly string[] = [
  'process.env',
  '.env',
  'bot_token',
  'encryption_key',
  'openrouter_api_key',
  'telegram_api_root',
  'appsettings.json',
  'dockerfile',
  'docker-compose',
  'node_modules',
  'better-sqlite3',
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  'sk-or-',
  'bearer ',
  'systemd',
  'nginx',
];

/** Four dotted decimal groups: a network address, which no answer ever needs. */
const IPV4_ADDRESS = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;

/**
 * Whether the model is describing the machine this bot runs on.
 *
 * Separate from `isPromptLeak` because the two failures need different
 * corrections: one is «stop reciting your instructions», the other is «do not
 * discuss the deployment». Both are refused rather than shown.
 */
export function isInfrastructureLeak(text: string): boolean {
  const lowered = text.toLowerCase();

  if (INFRASTRUCTURE_MARKERS.some(marker => lowered.includes(marker))) {
    return true;
  }

  return IPV4_ADDRESS.test(text);
}

/**
 * Whether the completion is broken rather than merely unhelpful.
 *
 * Three shapes, all seen in practice: a single repeated character, a single
 * repeated line, and a character that has swallowed the whole answer. A short
 * but real answer — «بله» — is not degenerate, which is why the flood check
 * only engages once there is enough text for a majority to mean something.
 */
export function isDegenerate(text: string): boolean {
  const compact = text.replace(/\s+/g, '');

  if (compact.length < 2) {
    return true;
  }

  if (new Set(compact).size === 1) {
    return true;
  }

  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  if (lines.length >= 4 && new Set(lines).size === 1) {
    return true;
  }

  const counts = new Map<string, number>();

  for (const character of compact) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }

  const highest = Math.max(...counts.values());

  return compact.length >= 40 && highest / compact.length > 0.5;
}

/**
 * The single gate every completion passes through.
 *
 * Returns the cleaned text alongside the reason it was rejected, so the caller
 * can both log a diagnosis and decide what to do next — retry with a targeted
 * correction, or give up and send the user to a human.
 *
 * The order of the checks is the order of the retry: a leak is corrected as a
 * leak, and only then is the language judged. Reporting an English dump of the
 * system prompt as «not Persian» would send the wrong corrective instruction.
 */
export function assessAnswer(raw: string): AnswerAssessment {
  const text = sanitizeAnswer(raw);

  if (text.length === 0) {
    return { text, rejection: 'empty' };
  }

  if (isDegenerate(text)) {
    return { text, rejection: 'degenerate' };
  }

  if (isPromptLeak(text)) {
    return { text, rejection: 'leaked' };
  }

  if (isInfrastructureLeak(text)) {
    return { text, rejection: 'disclosure' };
  }

  if (!isLikelyPersian(text)) {
    return { text, rejection: 'not-persian' };
  }

  return { text, rejection: null };
}
