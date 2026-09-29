import { escapeHtml, formatNumber, formatToman, toPersianDigits, truncateUtf8, utf8Length, weekdayByIndex } from '../shared/persian';
import { DAY, HOUR, MINUTE } from '../shared/time';
import { hasText, raw, t } from './i18n';

const BUTTON_BYTE_BUDGET = 60;

const buttonLabel = (text: string): string => truncateUtf8(text, BUTTON_BYTE_BUDGET);

const bullet = (items: readonly string[]): string => items.map(item => `• ${item}`).join('\n');

const blocks = (...parts: Array<string | null | undefined>): string =>
  parts
    .map(part => part?.trim())
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join('\n\n');

const FOOTER = t('brand.footer');

export const copy = {
  brand: {
    title: t('brand.title'),
    footer: FOOTER,
  },

  start: {
    returning: (firstName: string): string => blocks(t('start.returningGreeting', { firstName }), t('start.returningBody'), FOOTER),

    chooseUniversity: (): string => t('start.chooseUniversity'),

    askUsername: (universityName: string): string => t('start.askUsername', { universityName }),

    askPassword: (): string => t('start.askPassword'),

    checking: (): string => t('start.checking'),

    welcome: (firstName: string, isNewUser: boolean): string =>
      blocks(
        t('start.welcomeGreeting', { firstName }),
        isNewUser ? t('start.welcomeNew') : t('start.welcomeReturning'),
        t('start.welcomeHint'),
        FOOTER,
      ),

    loggedOut: (): string => t('start.loggedOut'),

    mustLoginFirst: (): string => t('start.mustLoginFirst'),
  },

  menu: {
    chooseOption: (): string => t('menu.chooseOption'),
    useButtons: (): string => t('menu.useButtons'),
  },

  reservation: {
    chooseWeek: (): string => t('reservation.chooseWeek'),

    loadingSelfs: (): string => t('reservation.loadingSelfs'),
    chooseSelf: (weekLabel: string): string => t('reservation.chooseSelf', { weekLabel }),

    loadingMeals: (): string => t('reservation.loadingMeals'),

    mealList: (selfName: string, weekLabel: string, meals: readonly string[]): string =>
      blocks(t('reservation.mealListHeading', { selfName, weekLabel }), meals.join('\n\n'), t('reservation.mealListHint')),

    mealEntry: (input: {
      index: number;
      weekday: string;
      dateLabel: string;
      mealTypeName: string;
      foodName: string;
      priceRial: number;
    }): string =>
      blocks(
        t('reservation.mealEntryTitle', { index: toPersianDigits(input.index), foodName: input.foodName }),
        bullet([
          `${escapeHtml(input.weekday)} ${escapeHtml(input.dateLabel)}`,
          escapeHtml(input.mealTypeName),
          t('reservation.mealEntryPrice', { price: formatToman(input.priceRial) }),
        ]),
      ),

    mealButton: (index: number, foodName: string): string =>
      buttonLabel(t('reservation.mealButton', { index: toPersianDigits(index), foodName: raw(foodName) })),

    noMealsForSelf: (weekLabel: string): string => t('reservation.noMealsForSelf', { weekLabel }),

    noSelfs: (): string => t('reservation.noSelfs'),

    reserved: (message: string): string => blocks(t('reservation.reservedTitle'), escapeHtml(message)),

    reserveFailed: (message: string): string => blocks(t('reservation.reserveFailedTitle'), escapeHtml(message)),

    notEnoughCredit: (): string => t('reservation.notEnoughCredit'),
  },

  reserves: {
    loading: (): string => t('reserves.loading'),

    weekLabel: {
      current: t('reserves.weekLabelCurrent'),
      next: t('reserves.weekLabelNext'),
    },

    list: (weekLabel: string, entries: readonly string[]): string => blocks(t('reserves.listHeading', { weekLabel }), entries.join('\n\n')),

    entry: (input: { weekday: string; dateLabel: string; foodName: string; selfName: string }): string =>
      blocks(
        t('reserves.entryTitle', { foodName: input.foodName }),
        bullet([`${escapeHtml(input.weekday)} ${escapeHtml(input.dateLabel)}`, escapeHtml(input.selfName)]),
      ),

    empty: (weekLabel: string): string => t('reserves.empty', { weekLabel }),
  },

  forgetCode: {
    intro: (): string =>
      blocks(
        t('forgetCode.introTitle'),
        t('forgetCode.introLead'),
        bullet([t('forgetCode.introShareItem'), t('forgetCode.introReceiveItem')]),
        t('forgetCode.introNote'),
      ),

    chooseShareTarget: (weekLabel: string): string => t('forgetCode.chooseShareTarget', { weekLabel }),

    shareConfirmation: (foodName: string, weekday: string): string => t('forgetCode.shareConfirmation', { foodName, weekday }),

    shareDone: (input: { code: string; foodName: string; selfName: string; dateLabel: string }): string =>
      blocks(
        t('forgetCode.shareDoneTitle'),
        t('forgetCode.shareDonePraise'),
        bullet([
          t('forgetCode.codeLine', { code: input.code }),
          escapeHtml(input.foodName),
          `${escapeHtml(input.selfName)} · ${escapeHtml(input.dateLabel)}`,
        ]),
      ),

    alreadyShared: (code: string): string => blocks(t('forgetCode.alreadySharedTitle'), t('forgetCode.codeLine', { code })),

    nothingToShare: (): string => t('forgetCode.nothingToShare'),

    chooseSelfToReceive: (): string => t('forgetCode.chooseSelfToReceive'),

    fetching: (): string => t('forgetCode.fetching'),

    receiveDone: (input: { code: string; foodName: string; weekday: string; dateLabel: string }): string =>
      blocks(
        t('forgetCode.receiveDoneTitle'),
        t('forgetCode.receiveDonePraise'),
        bullet([
          t('forgetCode.codeLine', { code: input.code }),
          escapeHtml(input.foodName),
          `${escapeHtml(input.weekday)} ${escapeHtml(input.dateLabel)}`,
        ]),
        t('forgetCode.receiveDoneNote'),
      ),

    reportPrompt: (): string => t('forgetCode.reportPrompt'),

    reportReceived: (): string => t('forgetCode.reportReceived'),
  },

  autoReserve: {
    intro: (): string => blocks(t('autoReserve.introTitle'), t('autoReserve.introBody'), t('autoReserve.introNote')),

    status: (input: { enabled: boolean; selfName: string | null; weekdays: readonly number[] }): string => {
      const statusLine = input.enabled ? t('autoReserve.statusEnabled') : t('autoReserve.statusDisabled');

      const weekdayLine =
        input.weekdays.length === 0 ? t('autoReserve.noDays') : input.weekdays.map(index => weekdayByIndex(index)).join('، ');

      return blocks(
        t('autoReserve.statusTitle'),
        bullet([
          t('autoReserve.statusLine', { status: raw(statusLine) }),
          t('autoReserve.selfLine', { self: input.selfName === null ? t('autoReserve.noSelf') : input.selfName }),
          t('autoReserve.daysLine', { days: weekdayLine }),
        ]),
        input.enabled && input.weekdays.length === 0 ? t('autoReserve.warnNoDays') : null,
        input.enabled && input.selfName === null ? t('autoReserve.warnNoSelf') : null,
        input.enabled && input.weekdays.length > 0 && input.selfName !== null ? t('autoReserve.statusActive') : null,
      );
    },

    chooseSelfFirst: (): string => t('autoReserve.chooseSelfFirst'),

    selfChosen: (selfName: string): string => t('autoReserve.selfChosen', { selfName }),

    enabled: (): string => t('autoReserve.enabled'),

    disabled: (): string => t('autoReserve.disabled'),

    needsSelf: (): string => t('autoReserve.needsSelf'),

    chooseDays: (): string => t('autoReserve.chooseDays'),

    dayToggled: (weekday: string, isSelected: boolean): string =>
      isSelected ? t('autoReserve.dayAdded', { weekday }) : t('autoReserve.dayRemoved', { weekday }),

    report: (input: { reserved: number; failed: number; weekdayLabel: string; failures: readonly string[] }): string => {
      const headline =
        input.reserved > 0 ? t('autoReserve.reportOkTitle', { weekdayLabel: input.weekdayLabel }) : t('autoReserve.reportFailTitle');

      const summary = bullet(
        [
          input.reserved > 0
            ? t('autoReserve.reportReservedLine', { count: toPersianDigits(input.reserved) })
            : t('autoReserve.reportNoneLine'),
          input.failed > 0 ? t('autoReserve.reportFailedLine', { count: toPersianDigits(input.failed) }) : null,
        ].filter((line): line is string => line !== null),
      );

      const detail =
        input.failures.length === 0
          ? null
          : blocks(t('autoReserve.reportFailuresHeading'), bullet(input.failures.slice(0, 5).map(escapeHtml)));

      const advice = input.failed > 0 ? t('autoReserve.reportAdviceManual') : t('autoReserve.reportAdviceList');

      return blocks(headline, summary, detail, advice);
    },
  },

  profile: {
    loading: (): string => t('profile.loading'),

    view: (input: { fullName: string; universityName: string; samadUsername: string; creditRial: number; telegramId: number }): string =>
      blocks(
        t('profile.title'),
        bullet([
          t('profile.nameLine', { fullName: input.fullName }),
          t('profile.universityLine', { universityName: input.universityName }),
          t('profile.samadUsernameLine', { samadUsername: input.samadUsername }),
          t('profile.creditLine', { credit: formatToman(input.creditRial) }),
          t('profile.telegramIdLine', { telegramId: toPersianDigits(input.telegramId) }),
        ]),
      ),
  },

  about: (): string => blocks(t('about.title'), t('about.body')),

  help: (): string => blocks(t('help.title'), t('help.reserve'), t('help.autoReserve'), t('help.forgetCode'), t('help.support')),

  support: {
    menuIntro: (hasChatbot: boolean): string =>
      blocks(
        t('support.menuTitle'),
        t('support.menuQuestion'),
        hasChatbot ? bullet([t('support.menuChatbotItem'), t('support.menuHumanItem')]) : t('support.menuWithoutChatbot'),
      ),

    chatbotIntro: (remaining: number): string =>
      blocks(t('support.chatbotTitle'), t('support.chatbotBody'), t('support.chatbotQuota', { remaining: toPersianDigits(remaining) })),

    chatbotThinking: (): string => t('support.chatbotThinking'),

    chatbotAnswer: (answer: string, remaining: number): string =>
      blocks(escapeHtml(answer), remaining <= 5 ? t('support.chatbotQuotaLeft', { remaining: toPersianDigits(remaining) }) : null),

    chatbotUnavailable: (): string => t('support.chatbotUnavailable'),

    humanIntro: (): string => t('support.humanIntro'),

    humanSent: (ticketId: number): string =>
      blocks(
        t('support.humanSentTitle'),
        t('support.humanSentTicket', { ticketId: toPersianDigits(ticketId) }),
        t('support.humanSentNote'),
      ),

    adminHeader: (input: {
      ticketId: number;
      displayName: string;
      username: string | null;
      telegramId: number;
      messageCount: number;
      isNew: boolean;
    }): string =>
      blocks(
        t('support.adminHeaderTitle', {
          ticketId: toPersianDigits(input.ticketId),
          badge: input.isNew ? t('support.adminHeaderNewBadge') : '',
        }),
        bullet(
          [
            t('support.adminHeaderFrom', { displayName: input.displayName }),
            input.username === null ? null : t('support.adminHeaderUsername', { username: input.username }),
            t('support.adminHeaderId', { telegramId: toPersianDigits(input.telegramId) }),
            t('support.adminHeaderCount', { messageCount: toPersianDigits(input.messageCount) }),
          ].filter((line): line is string => line !== null),
        ),
        t('support.adminHeaderHint'),
      ),

    adminBody: (content: string): string => blocks(t('support.adminBodyHeading'), escapeHtml(content)),

    adminReply: (text: string): string => blocks(t('support.adminReplyTitle'), escapeHtml(text)),

    adminReplyDelivered: (ticketId: number): string => t('support.adminReplyDelivered', { ticketId: toPersianDigits(ticketId) }),

    adminReplyUnknown: (): string => t('support.adminReplyUnknown'),

    adminReplyFailed: (): string => t('support.adminReplyFailed'),

    ticketClosed: (ticketId: number): string => t('support.ticketClosed', { ticketId: toPersianDigits(ticketId) }),

    ticketAlreadyClosed: (ticketId: number): string => t('support.ticketAlreadyClosed', { ticketId: toPersianDigits(ticketId) }),

    closedNotice: (): string => blocks(t('support.closedNoticeTitle'), t('support.closedNoticeBody')),
  },

  credit: {
    reminder: (input: { creditRial: number; requiredRial: number; shortfallRial: number; meals: readonly string[] }): string =>
      blocks(
        t('credit.reminderTitle'),
        t('credit.reminderBody', { required: formatToman(input.requiredRial), credit: formatToman(input.creditRial) }),
        blocks(t('credit.reminderMealsHeading'), bullet(input.meals)),
        t('credit.reminderShortfall', { shortfall: formatToman(input.shortfallRial) }),
        t('credit.reminderAdvice'),
      ),

    mealLine: (input: { weekday: string; dateLabel: string; foodName: string; priceRial: number }): string =>
      t('credit.mealLine', {
        weekday: input.weekday,
        dateLabel: input.dateLabel,
        foodName: input.foodName,
        price: formatToman(input.priceRial),
      }),

    ok: (): string => t('credit.ok'),
  },

  admin: {
    panelTitle: (): string => t('admin.panelTitle'),

    home: (input: { stats: readonly string[]; alerts: readonly string[] }): string =>
      blocks(
        t('admin.panelTitle'),
        bullet(input.stats),
        input.alerts.length === 0 ? null : blocks(t('admin.homeAlertsHeading'), bullet(input.alerts)),
        t('admin.homeHint'),
      ),

    statsReport: (input: { lines: readonly string[]; updatedAt: string }): string =>
      blocks(t('admin.statsTitle'), bullet(input.lines), t('admin.statsUpdatedAt', { updatedAt: input.updatedAt })),

    usersReport: (input: { total: number; activeToday: number; withAutoReserve: number; rows: readonly string[] }): string =>
      blocks(
        t('admin.usersTitle'),
        bullet([
          t('admin.usersTotalLine', { total: toPersianDigits(input.total) }),
          t('admin.usersTodayLine', { activeToday: toPersianDigits(input.activeToday) }),
          t('admin.usersAutoReserveLine', { withAutoReserve: toPersianDigits(input.withAutoReserve) }),
        ]),
        input.rows.length === 0 ? t('admin.usersEmpty') : blocks(t('admin.usersRecentHeading'), input.rows.join('\n')),
      ),

    userRow: (input: { telegramId: number; displayName: string; universityName: string; autoReserve: boolean }): string =>
      t('admin.userRowTemplate', {
        telegramId: toPersianDigits(input.telegramId),
        displayName: input.displayName,
        universityName: input.universityName,
        marker: input.autoReserve ? t('admin.userRowAutoReserveMarker') : '',
      }),

    userDetail: (input: {
      telegramId: number;
      displayName: string;
      universityName: string;
      samadUsername: string;
      autoReserve: string;
      createdAt: string;
      updatedAt: string;
    }): string =>
      blocks(
        t('admin.userDetailTitle'),
        bullet([
          t('admin.userDetailNameLine', { displayName: input.displayName }),
          t('admin.userDetailTelegramIdLine', { telegramId: toPersianDigits(input.telegramId) }),
          t('admin.userDetailUniversityLine', { universityName: input.universityName }),
          t('admin.userDetailSamadUsernameLine', { samadUsername: input.samadUsername }),
          t('admin.userDetailAutoReserveLine', { autoReserve: input.autoReserve }),
          t('admin.userDetailCreatedAtLine', { createdAt: input.createdAt }),
          t('admin.userDetailUpdatedAtLine', { updatedAt: input.updatedAt }),
        ]),
      ),

    userSearchPrompt: (): string => blocks(t('admin.userSearchTitle'), t('admin.userSearchBody'), t('admin.userSearchCancel')),

    userNotFound: (query: string): string => blocks(t('admin.userNotFoundTitle', { query }), t('admin.userNotFoundBody')),

    logoutConfirm: (displayName: string): string => blocks(t('admin.logoutConfirmTitle', { displayName }), t('admin.logoutConfirmBody')),

    logoutDone: (displayName: string): string => t('admin.logoutDone', { displayName }),

    supportReport: (input: { open: number; closed: number; today: number; rows: readonly string[] }): string =>
      blocks(
        t('admin.supportTitle'),
        bullet([
          t('admin.supportOpenLine', { open: toPersianDigits(input.open) }),
          t('admin.supportClosedLine', { closed: toPersianDigits(input.closed) }),
          t('admin.supportTodayLine', { today: toPersianDigits(input.today) }),
        ]),
        input.rows.length === 0 ? t('admin.supportEmpty') : blocks(t('admin.supportOpenHeading'), input.rows.join('\n\n')),
      ),

    ticketRow: (input: {
      ticketId: number;
      displayName: string;
      telegramId: number;
      messageCount: number;
      lastMessage: string;
      updatedAt: string;
    }): string =>
      blocks(
        t('admin.ticketRowHead', {
          ticketId: toPersianDigits(input.ticketId),
          displayName: input.displayName,
          telegramId: toPersianDigits(input.telegramId),
        }),
        t('admin.ticketRowMeta', { messageCount: toPersianDigits(input.messageCount), updatedAt: input.updatedAt }),
        t('admin.hint', { text: truncateUtf8(input.lastMessage, 120) }),
      ),

    chatbotReport: (input: {
      today: number;
      week: number;
      usersToday: number;
      model: string;
      enabled: boolean;
      questions: readonly string[];
    }): string =>
      blocks(
        t('admin.chatbotTitle'),
        input.enabled ? null : t('admin.chatbotDisabledNotice'),
        bullet([
          t('admin.chatbotTodayLine', { today: toPersianDigits(input.today) }),
          t('admin.chatbotUsersTodayLine', { usersToday: toPersianDigits(input.usersToday) }),
          t('admin.chatbotWeekLine', { week: toPersianDigits(input.week) }),
          t('admin.chatbotModelLine', { model: input.model }),
        ]),
        input.questions.length === 0
          ? t('admin.chatbotNoQuestions')
          : blocks(t('admin.chatbotQuestionsHeading'), input.questions.map(question => `• ${escapeHtml(question)}`).join('\n')),
      ),

    broadcastPrompt: (audience: number): string =>
      blocks(
        t('admin.broadcastTitle'),
        t('admin.broadcastPromptBody', { audience: toPersianDigits(audience) }),
        t('admin.broadcastPromptHint'),
      ),

    broadcastConfirm: (audience: number, preview: string): string =>
      blocks(
        t('admin.broadcastConfirmTitle'),
        t('admin.hint', { text: truncateUtf8(preview, 400) }),
        t('admin.broadcastConfirmBody', { audience: toPersianDigits(audience) }),
      ),

    broadcastRunning: (): string => t('admin.broadcastRunning'),

    broadcastDone: (input: { sent: number; failed: number }): string =>
      blocks(
        t('admin.broadcastDoneTitle'),
        bullet(
          [
            t('admin.broadcastSentLine', { sent: toPersianDigits(input.sent) }),
            input.failed > 0 ? t('admin.broadcastFailedLine', { failed: toPersianDigits(input.failed) }) : null,
          ].filter((line): line is string => line !== null),
        ),
        input.failed > 0 ? t('admin.broadcastFailedNote') : null,
      ),

    systemReport: (input: { lines: readonly string[] }): string => blocks(t('admin.systemTitle'), bullet(input.lines)),

    scheduleReport: (input: { rows: readonly string[]; updatedAt: string; timezone: string }): string =>
      blocks(
        t('admin.scheduleTitle'),
        input.rows.length === 0 ? t('admin.scheduleEmpty') : input.rows.join('\n\n'),
        t('admin.scheduleHint', { tz: input.timezone }),
        t('admin.scheduleUpdatedAt', { updatedAt: input.updatedAt }),
      ),

    scheduleRow: (input: { name: string; expression: string; nextRun: string; countdown: string | null }): string =>
      blocks(
        t('admin.scheduleRowName', { name: input.name }),
        t('admin.scheduleNextLine', { next: input.nextRun }),
        input.countdown === null ? null : t('admin.scheduleInLine', { countdown: input.countdown }),
        t('admin.scheduleExpressionLine', { expression: input.expression }),
      ),

    scheduleJobName: (name: string): string => (hasText(`admin.scheduleJobs.${name}`) ? t(`admin.scheduleJobs.${name}`) : name),

    scheduleUnknown: (): string => t('admin.scheduleUnknown'),

    /**
     * A countdown as a person reads it: days and hours only when they matter,
     * and minutes always, so "2 hours and 15 minutes" never collapses to "2 hours".
     */
    countdown: (ms: number): string => {
      if (ms <= 0) {
        return t('admin.scheduleNow');
      }

      const perHour = HOUR / MINUTE;
      const perDay = DAY / MINUTE;

      const totalMinutes = Math.ceil(ms / MINUTE);
      const days = Math.floor(totalMinutes / perDay);
      const hours = Math.floor((totalMinutes % perDay) / perHour);
      const minutes = totalMinutes % perHour;

      const parts: string[] = [];

      if (days > 0) {
        parts.push(t('admin.scheduleDays', { count: toPersianDigits(days) }));
      }
      if (hours > 0) {
        parts.push(t('admin.scheduleHours', { count: toPersianDigits(hours) }));
      }
      if (minutes > 0 || parts.length === 0) {
        parts.push(t('admin.scheduleMinutes', { count: toPersianDigits(minutes) }));
      }

      return parts.join(' و ');
    },

    maintenanceReport: (input: { lines: readonly string[] }): string => blocks(t('admin.maintenanceTitle'), bullet(input.lines)),

    maintenanceIntro: (): string => blocks(t('admin.maintenanceTitle'), t('admin.maintenanceIntroBody')),

    purgeDone: (codes: number, sessions: number, conversations: number, chatbot: number): string =>
      blocks(
        t('admin.purgeDoneTitle'),
        bullet([
          t('admin.purgeCodesLine', { codes: toPersianDigits(codes) }),
          t('admin.purgeSessionsLine', { sessions: toPersianDigits(sessions) }),
          t('admin.purgeConversationsLine', { conversations: toPersianDigits(conversations) }),
          t('admin.purgeChatbotLine', { chatbot: toPersianDigits(chatbot) }),
        ]),
      ),

    backupIntro: (): string => blocks(t('admin.backupTitle'), t('admin.backupIntroBody'), t('admin.backupIntroNote')),

    backupCaption: (): string => t('admin.backupCaption'),

    backupDone: (sizeLabel: string, users: number): string =>
      blocks(
        t('admin.backupDoneTitle'),
        bullet([t('admin.backupSizeLine', { sizeLabel }), t('admin.backupUsersLine', { users: toPersianDigits(users) })]),
      ),

    backupFailed: (reason: string): string => blocks(t('admin.backupFailedTitle'), escapeHtml(reason)),

    notAuthorized: (): string => t('admin.notAuthorized'),

    hint: (text: string): string => t('admin.hint', { text }),

    featuresTitle: (): string => t('admin.featuresTitle'),

    featuresBody: (): string => t('admin.featuresBody'),

    featuresHint: (): string => t('admin.featuresHint'),

    featuresReport: (rows: readonly string[]): string =>
      blocks(t('admin.featuresTitle'), t('admin.featuresBody'), bullet(rows), t('admin.featuresHint')),

    featureEnabledLabel: (): string => t('admin.featureEnabled'),

    featureDisabledLabel: (): string => t('admin.featureDisabled'),

    featureRow: (name: string, enabled: boolean): string =>
      t('admin.featureRowTemplate', {
        marker: enabled ? t('admin.featureEnabled') : t('admin.featureDisabled'),
        name: raw(name),
      }),

    featureToggleLabel: (enabled: boolean): string => (enabled ? t('admin.featureToggleOff') : t('admin.featureToggleOn')),

    featureNotFound: (): string => t('admin.featureNotFound'),
  },

  features: {
    disabled: (key: string): string =>
      blocks(
        t('features.disabledTitle', { name: raw(t(`features.names.${key}`)) }),
        t('features.disabledBody'),
        t('features.disabledAdvice'),
      ),

    disabledTitle: (name: string): string => t('features.disabledTitle', { name: raw(name) }),

    disabledBody: (): string => t('features.disabledBody'),

    disabledAdvice: (): string => t('features.disabledAdvice'),

    name: (key: string): string => t(`features.names.${key}`),
  },

  samad: {
    menu: (): string => blocks(t('samad.menuTitle'), t('samad.menuBody'), t('samad.menuHint')),

    menuTitle: (): string => t('samad.menuTitle'),

    menuBody: (): string => t('samad.menuBody'),

    menuHint: (): string => t('samad.menuHint'),

    openButton: (): string => t('samad.openButton'),

    notConfigured: (): string => t('samad.notConfigured'),
  },

  errors: {
    generic: (): string => t('errors.generic'),

    wrongCredentials: (): string => t('errors.wrongCredentials'),

    sessionExpired: (): string => t('errors.sessionExpired'),

    upstreamUnavailable: (): string => t('errors.upstreamUnavailable'),

    unknownUniversity: (): string => t('errors.unknownUniversity'),

    textOnly: (): string => t('errors.textOnly'),

    emptyQuestion: (): string => t('errors.emptyQuestion'),

    chatbotBusy: (): string => t('errors.chatbotBusy'),

    invalidUniversitySelection: (): string => t('errors.invalidUniversitySelection'),

    appGeneric: (): string => t('errors.appGeneric'),

    sessionExpiredShort: (): string => t('errors.sessionExpiredShort'),

    invalidCredentialsShort: (): string => t('errors.invalidCredentialsShort'),

    upstreamUnavailableShort: (): string => t('errors.upstreamUnavailableShort'),

    chatbotUnusable: (): string => t('errors.chatbotUnusable'),
  },
} as const;

export const formatPrice = (priceRial: number): string => formatToman(priceRial);

export const formatCount = (value: number): string => formatNumber(value);

export const selfButton = (name: string): string => buttonLabel(name);

export type Copy = typeof copy;

export { utf8Length, buttonLabel };
export { catalogSource, activeCatalogPath, locale, raw, t } from './i18n';
