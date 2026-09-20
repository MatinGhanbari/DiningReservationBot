import { escapeHtml, formatNumber, formatToman, toPersianDigits, truncateUtf8, utf8Length, weekdayByIndex } from '../shared/persian';

/**
 * Every word the user reads.
 *
 * Two conventions hold this file together:
 *
 *   1. **This is the only place that builds user-facing markup.** Functions take
 *      raw values and escape them here, so a food name from Samad containing `&`
 *      or `<` cannot break a message. Callers pass raw strings and never call
 *      `escapeHtml` themselves.
 *   2. **Register is colloquial written Persian.** The bot talks to students the
 *      way a helpful classmate would: «می‌تونی»، «بزن»، «برو». Not the stiff
 *      administrative register, and not slang either. Consistent throughout —
 *      switching registers mid-conversation is the fastest way to sound machine-made.
 *
 * Telegram measures button labels in UTF-8 bytes, and Persian costs two bytes per
 * character, so labels are budgeted in bytes rather than characters.
 */

/** Telegram's hard limit on an inline button label. */
const BUTTON_BYTE_BUDGET = 60;

/**
 * Kept as a standalone constant rather than read from the `copy` object.
 * A function inside the object referring back to `copy` would make the object's
 * type depend on itself, which TypeScript refuses to infer.
 */
const FOOTER = '🍟 URB · @University_Reservation_Bot';

const buttonLabel = (text: string): string => truncateUtf8(text, BUTTON_BYTE_BUDGET);

const bullet = (items: readonly string[]): string => items.map(item => `• ${item}`).join('\n');

/** Joins blocks with a blank line, dropping anything empty. */
const blocks = (...parts: Array<string | null | undefined>): string =>
  parts
    .map(part => part?.trim())
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join('\n\n');

export const copy = {
  brand: {
    title: 'ربات رزرو غذای سلف',
    /** Appended only to main screens, not to every single reply. */
    footer: FOOTER,
  },

  // ── شروع و ورود ────────────────────────────────────────────────────────────

  start: {
    returning: (firstName: string): string =>
      blocks(
        `👋 سلام <b>${escapeHtml(firstName)}</b>، خوش برگشتی.`,
        'از منوی پایین می‌تونی غذا رزرو کنی، رزروهای هفتهٔ جاری و هفتهٔ بعد رو ببینی، یا کد فراموشی بگیری.',
        FOOTER,
      ),

    chooseUniversity: (): string =>
      blocks('برای شروع، دانشگاهت رو از منوی پایین انتخاب کن.', 'با این کار به سامانهٔ سماد همون دانشگاه وصل می‌شی.'),

    askUsername: (universityName: string): string =>
      blocks(
        `دانشگاه <b>${escapeHtml(universityName)}</b> انتخاب شد.`,
        'حالا <b>نام کاربری سماد</b>ت رو بفرست.',
      ),

    askPassword: (): string =>
      blocks(
        'و حالا <b>رمز عبورت</b> رو بفرست.',
        '📌 معمولاً رمز سماد همون کد ملیه.',
        '🔒 رمزت رمزنگاری‌شده ذخیره می‌شه تا هر بار مجبور نباشی از اول وارد بشی.',
      ),

    checking: (): string => '🔎 دارم با سماد چک می‌کنم…',

    welcome: (firstName: string, isNewUser: boolean): string =>
      blocks(
        `🎉 <b>${escapeHtml(firstName)}</b> جان، خوش اومدی!`,
        isNewUser
          ? 'حسابت وصل شد. از این به بعد رزرو غذا فقط چند تا کلیک فاصله داره.'
          : 'حسابت دوباره وصل شد.',
        'از منوی پایین یکی از گزینه‌ها رو انتخاب کن.',
        FOOTER,
      ),

    loggedOut: (): string => blocks('👋 خارج شدی.', 'هر وقت خواستی برگردی، دکمهٔ «ورود به حساب کاربری» رو بزن.'),

    mustLoginFirst: (): string => 'برای این کار باید اول وارد حساب سمادت بشی.',
  },

  // ── منوی اصلی ─────────────────────────────────────────────────────────────

  menu: {
    chooseOption: (): string => 'یکی از گزینه‌های زیر رو انتخاب کن.',
    useButtons: (): string =>
      'متوجه منظورت نشدم. لطفاً از دکمه‌های خود ربات استفاده کن تا گم نشیم.',
  },

  // ── رزرو غذا ──────────────────────────────────────────────────────────────

  reservation: {
    chooseWeek: (): string => blocks('می‌خوای کدوم هفته رو ببینی؟'),

    loadingSelfs: (): string => '🔎 دارم لیست سلف‌ها رو می‌گیرم…',
    chooseSelf: (weekLabel: string): string =>
      blocks(`سلف موردنظرت رو برای <b>${escapeHtml(weekLabel)}</b> انتخاب کن.`),

    loadingMeals: (): string => '🔎 دارم منوی این سلف رو می‌گیرم…',

    mealList: (selfName: string, weekLabel: string, meals: readonly string[]): string =>
      blocks(
        `🍽️ <b>${escapeHtml(selfName)}</b> · ${escapeHtml(weekLabel)}`,
        meals.join('\n\n'),
        'روی دکمهٔ هر غذا بزن تا همون لحظه رزرو بشه.',
      ),

    /** One meal, as it appears in the list before it is booked. */
    mealEntry: (input: {
      index: number;
      weekday: string;
      dateLabel: string;
      mealTypeName: string;
      foodName: string;
      priceRial: number;
    }): string =>
      blocks(
        `<b>${toPersianDigits(input.index)}. ${escapeHtml(input.foodName)}</b>`,
        bullet([
          `${escapeHtml(input.weekday)} ${escapeHtml(input.dateLabel)}`,
          escapeHtml(input.mealTypeName),
          `💳 ${formatToman(input.priceRial)}`,
        ]),
      ),

    mealButton: (index: number, foodName: string): string => buttonLabel(`${toPersianDigits(index)}. ${foodName}`),

    noMealsForSelf: (weekLabel: string): string =>
      blocks(
        `برای <b>${escapeHtml(weekLabel)}</b> توی این سلف غذایی برای رزرو پیدا نکردم.`,
        'یا همه رو قبلاً رزرو کردی، یا هنوز منو منتشر نشده.',
        'می‌تونی هفتهٔ دیگه‌ای رو امتحان کنی.',
      ),

    noSelfs: (): string =>
      blocks(
        'سماد برای حساب تو هیچ سلفی برنگرداند.',
        'یعنی هنوز به هیچ سلفی تخصیص داده نشدی. با امور دانشجویی دانشکده‌ت صحبت کن.',
      ),

    reserved: (message: string): string => blocks(`✅ <b>رزرو شد!</b>`, escapeHtml(message)),

    reserveFailed: (message: string): string => blocks(`⚠️ <b>رزرو انجام نشد</b>`, escapeHtml(message)),

    notEnoughCredit: (): string =>
      'موجودی حسابت کافی نبود. می‌تونی از بخش «اطلاعات من» موجودی‌ات رو ببینی و بعد دوباره امتحان کنی.',
  },

  // ── لیست رزروها ───────────────────────────────────────────────────────────

  reserves: {
    loading: (): string => '🔎 دارم رزروهایت رو می‌گیرم…',

    weekLabel: {
      current: 'رزروهای این هفته',
      next: 'رزروهای هفتهٔ بعد',
    },

    list: (weekLabel: string, entries: readonly string[]): string =>
      blocks(`🍟 <b>${escapeHtml(weekLabel)}</b>`, entries.join('\n\n')),

    entry: (input: { weekday: string; dateLabel: string; foodName: string; selfName: string }): string =>
      blocks(
        `<b>${escapeHtml(input.foodName)}</b>`,
        bullet([
          `${escapeHtml(input.weekday)} ${escapeHtml(input.dateLabel)}`,
          escapeHtml(input.selfName),
        ]),
      ),

    empty: (weekLabel: string): string =>
      blocks(
        `برای <b>${escapeHtml(weekLabel)}</b> رزروی نداری.`,
        'می‌تونی از بخش «رزرو غذا» غذای هفتهٔ بعدت رو از حالا بگیری.',
      ),
  },

  // ── کد فراموشی ────────────────────────────────────────────────────────────

  forgetCode: {
    intro: (): string =>
      blocks(
        'کارتت رو جا گذاشتی یا گم شده؟ 🎫',
        'این بخش دو کار می‌کنه:',
        bullet([
          '<b>ارسال کد:</b> یکی از غذاهای رزروشده‌ت رو به بقیه می‌دی تا کسی که کارتش رو نداره بتونه غذا بخوره.',
          '<b>دریافت کد:</b> اگه امروز غذا داری ولی کارتت نیست، یه کد از مخزن برمی‌داری.',
        ]),
        'هر کد فقط یک‌بار قابل استفاده‌ست، پس با خیال راحت به هم‌دانشگاهی‌هات کمک کن.',
      ),

    chooseShareTarget: (weekLabel: string): string =>
      blocks(`کدوم رزروت رو می‌خوای به اشتراک بذاری؟ <i>${escapeHtml(weekLabel)}</i>`),

    shareConfirmation: (foodName: string, weekday: string): string =>
      blocks(
        `مطمئنی می‌خوای کد <b>${escapeHtml(foodName)}</b> (${escapeHtml(weekday)}) رو با بقیه قسمت کنی؟`,
        'با این کار خودت اون وعده رو از دست می‌دی و یکی دیگه ازش استفاده می‌کنه.',
      ),

    shareDone: (input: { code: string; foodName: string; selfName: string; dateLabel: string }): string =>
      blocks(
        '✅ <b>کد به مخزن اضافه شد.</b>',
        'دمت گرم که به فکر بقیه‌ای. 🙌',
        bullet([
          `کد: <code>${escapeHtml(input.code)}</code>`,
          escapeHtml(input.foodName),
          `${escapeHtml(input.selfName)} · ${escapeHtml(input.dateLabel)}`,
        ]),
      ),

    alreadyShared: (code: string): string =>
      blocks(
        'این کد قبلاً توی مخزن بود، پس دوباره اضافه‌اش نکردم.',
        `کد: <code>${escapeHtml(code)}</code>`,
      ),

    nothingToShare: (): string =>
      blocks(
        'برای این هفته غذایی نداری که بشه کدش رو به اشتراک گذاشت.',
        'می‌تونی هفتهٔ بعد رو چک کنی.',
      ),

    chooseSelfToReceive: (): string => 'از کدوم سلف می‌خوای غذا بخوری؟',

    fetching: (): string => '🔎 دارم دنبال کد می‌گردم…',

    receiveDone: (input: { code: string; foodName: string; weekday: string; dateLabel: string }): string =>
      blocks(
        '✅ <b>کد پیدا شد!</b>',
        'دم بچه‌های دانشکده‌ت گرم که به فکر همدیگه‌ان. 🧡',
        bullet([
          `کد: <code>${escapeHtml(input.code)}</code>`,
          escapeHtml(input.foodName),
          `${escapeHtml(input.weekday)} ${escapeHtml(input.dateLabel)}`,
        ]),
        'یادت باشه بعداً تو هم برای بقیه کد بذاری.',
      ),

    reportPrompt: (): string =>
      blocks(
        'کدی که کار نکرد رو بفرست تا بررسی کنم.',
        'اگه ممکنه، متن خطایی که سماد داد رو هم همراهش بنویس.',
      ),

    reportReceived: (): string =>
      blocks('🙏 ممنون، ثبت شد.', 'در اولین فرصت بررسی می‌کنم و اگه لازم باشه باهات تماس می‌گیرم.'),
  },

  // ── رزرو خودکار ───────────────────────────────────────────────────────────

  autoReserve: {
    intro: (): string =>
      blocks(
        '⚙️ <b>رزرو خودکار</b>',
        'یه‌بار روزهایی که غذا می‌خوری رو انتخاب کن. ربات خودش هر روز چک می‌کنه و به‌محض اینکه رزرو ممکن شد، برات رزرو می‌کنه.',
        'این‌طوری دیگه لازم نیست نگران پر شدن ظرفیت باشی.',
      ),

    status: (input: { enabled: boolean; selfName: string | null; weekdays: readonly number[] }): string => {
      const statusLine = input.enabled ? '✅ <b>فعال</b>' : '⛔️ <b>غیرفعال</b>';

      const weekdayLine =
        input.weekdays.length === 0
          ? 'هیچ روزی انتخاب نشده'
          : input.weekdays.map(index => weekdayByIndex(index)).join('، ');

      return blocks(
        '⚙️ <b>رزرو خودکار</b>',
        bullet([
          `وضعیت: ${statusLine}`,
          `سلف: ${input.selfName === null ? 'انتخاب نشده' : escapeHtml(input.selfName)}`,
          `روزها: ${escapeHtml(weekdayLine)}`,
        ]),
        input.enabled && input.weekdays.length === 0
          ? '⚠️ رزرو خودکار فعاله ولی هیچ روزی انتخاب نشده، پس کاری انجام نمی‌شه. از «تغییر روزها» استفاده کن.'
          : null,
        input.enabled && input.selfName === null
          ? '⚠️ هنوز سلفی انتخاب نکردی، پس رزرو خودکار کاری انجام نمی‌ده.'
          : null,
        input.enabled && input.weekdays.length > 0 && input.selfName !== null
          ? 'هر روز صبح چک می‌کنم و به‌محض اینکه رزرو ممکن شد، خودم انجامش می‌دم و بهت خبر می‌دم.'
          : null,
      );
    },

    chooseSelfFirst: (): string =>
      blocks(
        'قبل از فعال‌سازی، باید بگی توی کدوم سلف برات رزرو کنم.',
        'این کار جلوی رزرو تکراری و هزینهٔ اضافه رو می‌گیره.',
      ),

    selfChosen: (selfName: string): string => `سلف <b>${escapeHtml(selfName)}</b> ثبت شد.`,

    enabled: (): string =>
      blocks(
        '✅ رزرو خودکار فعال شد.',
        'از این به بعد هر روز صبح چک می‌کنم و اگه چیزی برای رزرو باشه، خودم انجامش می‌دم و بهت خبر می‌دم.',
      ),

    disabled: (): string => blocks('⛔️ رزرو خودکار غیرفعال شد.', 'هر وقت خواستی از همین‌جا دوباره روشنش کن.'),

    needsSelf: (): string => 'برای فعال کردن رزرو خودکار، اول باید سلف رو انتخاب کنی.',

    chooseDays: (): string =>
      blocks(
        'روزهایی که می‌خوای برات غذا رزرو بشه رو انتخاب کن.',
        'هر روز رو که بزنی، وضعیتش عوض می‌شه. چند تا روز هم‌زمان هم می‌شه انتخاب کرد.',
      ),

    dayToggled: (weekday: string, isSelected: boolean): string =>
      isSelected ? `✅ <b>${escapeHtml(weekday)}</b> اضافه شد.` : `⛔️ <b>${escapeHtml(weekday)}</b> برداشته شد.`,

    report: (input: {
      reserved: number;
      failed: number;
      weekdayLabel: string;
      failures: readonly string[];
    }): string => {
      const headline =
        input.reserved > 0
          ? `✅ <b>رزرو خودکار انجام شد</b> (${escapeHtml(input.weekdayLabel)})`
          : '⚠️ <b>رزرو خودکار به مشکل خورد</b>';

      const summary = bullet([
        input.reserved > 0 ? `${toPersianDigits(input.reserved)} وعده رزرو شد` : 'هیچ وعده‌ای رزرو نشد',
        input.failed > 0 ? `${toPersianDigits(input.failed)} مورد ناموفق` : null,
      ].filter((line): line is string => line !== null));

      const detail =
        input.failures.length === 0
          ? null
          : blocks('<b>جزئیات ناموفق‌ها:</b>', bullet(input.failures.slice(0, 5).map(escapeHtml)));

      const advice =
        input.failed > 0
          ? 'می‌تونی از بخش «رزرو غذا» خودت دستی امتحان کنی تا ببینی مشکل چیه.'
          : 'می‌تونی از بخش «لیست رزروهای این هفته» ببینیشون.';

      return blocks(headline, summary, detail, advice);
    },
  },

  // ── اطلاعات من ────────────────────────────────────────────────────────────

  profile: {
    loading: (): string => '🔎 دارم اطلاعاتت رو می‌گیرم…',

    view: (input: {
      fullName: string;
      universityName: string;
      samadUsername: string;
      creditRial: number;
      telegramId: number;
    }): string =>
      blocks(
        '🍔 <b>اطلاعات من</b>',
        bullet([
          `نام: <b>${escapeHtml(input.fullName)}</b>`,
          `دانشگاه: ${escapeHtml(input.universityName)}`,
          `نام کاربری سماد: <code>${escapeHtml(input.samadUsername)}</code>`,
          `موجودی: <b>${formatToman(input.creditRial)}</b>`,
          `شناسهٔ تلگرام: <code>${toPersianDigits(input.telegramId)}</code>`,
        ]),
      ),
  },

  // ── درباره و پشتیبانی ─────────────────────────────────────────────────────

  about: (): string =>
    blocks(
      '💡 <b>دربارهٔ ربات</b>',
      'این ربات رو دانشجوهای دانشگاه خواجه نصیرالدین طوسی نوشتن تا کار با سامانهٔ سماد ساده‌تر بشه. هیچ ارتباط رسمی‌ای با دانشگاه یا سماد نداره.',
      '<b>ارتباط با ما</b>\n• @Ghanbari_Matin\n• @Malekeym',
      'اگه ربات به کارت اومد، توی گیت‌هاب بهمون ستاره بده:\nhttps://github.com/malekeym/DiningReservation',
    ),

  help: (): string =>
    blocks(
      '🍟 <b>راهنمای ربات</b>',
      '<b>رزرو غذا</b>\nاز «رزرو غذا» هفتهٔ جاری یا هفتهٔ بعد رو انتخاب کن، سلف رو بزن و روی دکمهٔ غذایی که می‌خوای کلیک کن. رزرو همون لحظه انجام می‌شه.',
      '<b>رزرو خودکار</b>\nروزهای هفته رو یه‌بار انتخاب کن تا ربات هر روز خودش برات رزرو کنه.',
      '<b>کد فراموشی</b>\nکارتت رو نداری؟ از مخزن کد بگیر. غذات رو هم نمی‌خوری؟ کدش رو به بقیه بده.',
      '<b>مشکلی دیدی؟</b>\nاز منوی «پشتیبانی» پیامت رو بفرست تا ببینم.',
    ),

  support: {
    prompt: (): string =>
      blocks(
        '📮 پیامت رو بنویس و بفرست.',
        'مستقیم می‌رسه دست ما و در اولین فرصت جواب می‌دیم.',
      ),

    sent: (): string => blocks('✅ پیامت رسید.', 'ممنون که وقت گذاشتی. زودی بررسی می‌کنم.'),
  },

  // ── خطاها ─────────────────────────────────────────────────────────────────

  errors: {
    generic: (): string =>
      blocks('⚠️ یه مشکلی پیش آمد.', 'لطفاً یک‌بار دیگر امتحان کن. اگه باز هم تکرار شد، از منوی «پشتیبانی» بهم خبر بده.'),

    wrongCredentials: (): string =>
      blocks(
        '❌ <b>نام کاربری یا رمز درست نبود.</b>',
        'دوباره امتحان کن. اگه مطمئنی درسته، از سایت سماد چک کن که حسابت قفل نشده باشه.',
      ),

    sessionExpired: (): string =>
      blocks('🔐 <b>نشستت منقضی شد.</b>', 'برای امنیت حساب، باید یک‌بار دیگر وارد بشی.'),

    upstreamUnavailable: (): string =>
      blocks(
        '🌐 <b>به سماد وصل نشدم.</b>',
        'مشکل از طرف سماده، نه از حساب تو. چند دقیقه بعد یک‌بار دیگر امتحان کن.',
      ),

    notAuthorized: (): string => 'این بخش فقط برای مدیران ربات در دسترسه.',

    unknownUniversity: (): string => 'این دانشگاه پشتیبانی نمی‌شه. یکی از گزینه‌های منو رو انتخاب کن.',

    invalidUniversitySelection: (): string => 'از دکمه‌های خود منو انتخاب کن تا دانشگاهت رو درست تشخیص بدم.',
  },
} as const;

/** Formats a Rial amount for inline use, kept here so every screen agrees. */
export const formatPrice = (priceRial: number): string => formatToman(priceRial);

/** Persian numeral for a plain count, for use inside sentences. */
export const formatCount = (value: number): string => formatNumber(value);

/**
 * A dining-hall name, trimmed to fit a Telegram button.
 *
 * Exposed as a copy function so every button that shows a hall name goes through
 * the same byte budget instead of each call site truncating differently.
 */
export const selfButton = (name: string): string => buttonLabel(name);

export type Copy = typeof copy;

/** Re-exported so callers building custom text use the same byte budget. */
export { utf8Length, buttonLabel };
