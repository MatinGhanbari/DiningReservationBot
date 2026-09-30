import { isFeatureKey, type FeatureKey } from '../domain/features';
import type { ScheduleField } from '../scheduler/scheduler';
import type { WeekSelection } from '../app/reservation.service';

/**
 * Every inline button carries one of these.
 *
 * The original code matched callback data with ad-hoc regular expressions spread
 * across twenty `bot.action(...)` registrations — `/(\d)-day/`, `/^self-(\w+)/`,
 * `/^lostCode-(\d+)-(\d+)-(\d+)/`. Two problems with that: a malformed or
 * unexpected payload silently matched nothing and the button just stopped
 * responding, and the meaning of a payload could only be understood by reading
 * every regex at once.
 *
 * Here a payload is serialised and parsed in one place, and the parser returns
 * `null` for anything it does not recognise so the caller can answer the button
 * instead of leaving it spinning.
 *
 * Telegram caps callback data at 64 bytes, which every encoding below respects
 * comfortably.
 */
export type CallbackAction =
  | { kind: 'select-university'; universityId: number }
  | { kind: 'choose-self'; week: WeekSelection }
  | { kind: 'select-self'; week: WeekSelection; selfId: number }
  | { kind: 'show-reserves'; week: WeekSelection }
  | { kind: 'reserve-meal'; programId: number; foodTypeId: number; mealTypeId: number }
  | { kind: 'auto-reserve-self'; selfId: number }
  | { kind: 'auto-reserve-day'; weekday: number }
  | { kind: 'forget-code-share'; reserveId: number }
  | { kind: 'forget-code-share-confirm'; reserveId: number }
  | { kind: 'forget-code-receive-self'; selfId: number }
  | { kind: 'admin-user'; telegramId: number }
  | { kind: 'admin-logout-prompt'; telegramId: number }
  | { kind: 'admin-logout-confirm'; telegramId: number }
  | { kind: 'admin-close-ticket'; ticketId: number }
  | { kind: 'admin-broadcast-send' }
  | { kind: 'admin-broadcast-cancel' }
  | { kind: 'admin-toggle-feature'; feature: FeatureKey }
  | { kind: 'admin-schedule-list' }
  | { kind: 'admin-schedule-edit'; job: string }
  | { kind: 'admin-schedule-step'; job: string; field: ScheduleField; delta: number }
  | { kind: 'admin-schedule-reset'; job: string }
  | { kind: 'admin-purge' };

const WEEK_CODES: Record<WeekSelection, string> = { current: 'c', next: 'n' };

const FIELD_CODES: Record<ScheduleField, string> = { hour: 'h', minute: 'm' };

function parseField(code: string | undefined): ScheduleField | null {
  if (code === 'h') {
    return 'hour';
  }
  if (code === 'm') {
    return 'minute';
  }
  return null;
}

/** A scheduled job's name, which is a short lowercase slug. */
function parseJobName(value: string | undefined): string | null {
  return value !== undefined && /^[a-z0-9-]{1,32}$/.test(value) ? value : null;
}

function parseWeek(code: string | undefined): WeekSelection | null {
  if (code === 'c') {
    return 'current';
  }
  if (code === 'n') {
    return 'next';
  }
  return null;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseWeekday(value: string | undefined): number | null {
  if (value === undefined || !/^[0-6]$/.test(value)) {
    return null;
  }
  return Number(value);
}

export function encodeCallback(action: CallbackAction): string {
  switch (action.kind) {
    case 'select-university':
      return `u:${action.universityId}`;
    case 'choose-self':
      return `r:${WEEK_CODES[action.week]}`;
    case 'select-self':
      return `s:${WEEK_CODES[action.week]}:${action.selfId}`;
    case 'show-reserves':
      return `w:${WEEK_CODES[action.week]}`;
    case 'reserve-meal':
      return `m:${action.programId}:${action.foodTypeId}:${action.mealTypeId}`;
    case 'auto-reserve-self':
      return `a:s:${action.selfId}`;
    case 'auto-reserve-day':
      return `a:d:${action.weekday}`;
    case 'forget-code-share':
      return `f:s:${action.reserveId}`;
    case 'forget-code-share-confirm':
      return `f:c:${action.reserveId}`;
    case 'forget-code-receive-self':
      return `f:g:${action.selfId}`;
    case 'admin-user':
      return `x:u:${action.telegramId}`;
    case 'admin-logout-prompt':
      return `x:q:${action.telegramId}`;
    case 'admin-logout-confirm':
      return `x:l:${action.telegramId}`;
    case 'admin-close-ticket':
      return `x:t:${action.ticketId}`;
    case 'admin-broadcast-send':
      return 'x:b:y';
    case 'admin-broadcast-cancel':
      return 'x:b:n';
    case 'admin-toggle-feature':
      return `x:f:${action.feature}`;
    case 'admin-schedule-list':
      return 'x:s:l';
    case 'admin-schedule-edit':
      return `x:s:e:${action.job}`;
    case 'admin-schedule-step':
      return `x:s:${FIELD_CODES[action.field]}:${action.delta > 0 ? 'u' : 'd'}:${action.job}`;
    case 'admin-schedule-reset':
      return `x:s:r:${action.job}`;
    case 'admin-purge':
      return 'x:p:y';
  }
}

/**
 * Parses callback data, returning null for anything unrecognised.
 *
 * Returning null rather than throwing is deliberate: this runs on data that
 * arrived over the network and may be from an older version of the keyboard
 * still sitting in someone's chat history.
 */
export function decodeCallback(data: string): CallbackAction | null {
  const parts = data.split(':');
  const [prefix, first, second, third, fourth] = parts;

  switch (prefix) {
    case 'u': {
      const universityId = parsePositiveInt(first);
      return universityId === null ? null : { kind: 'select-university', universityId };
    }

    case 'r': {
      const week = parseWeek(first);
      return week === null ? null : { kind: 'choose-self', week };
    }

    case 's': {
      const week = parseWeek(first);
      const selfId = parsePositiveInt(second);
      return week === null || selfId === null ? null : { kind: 'select-self', week, selfId };
    }

    case 'w': {
      const week = parseWeek(first);
      return week === null ? null : { kind: 'show-reserves', week };
    }

    case 'm': {
      const programId = parsePositiveInt(first);
      const foodTypeId = parsePositiveInt(second);
      const mealTypeId = parsePositiveInt(third);
      return programId === null || foodTypeId === null || mealTypeId === null
        ? null
        : { kind: 'reserve-meal', programId, foodTypeId, mealTypeId };
    }

    case 'a': {
      if (first === 's') {
        const selfId = parsePositiveInt(second);
        return selfId === null ? null : { kind: 'auto-reserve-self', selfId };
      }
      if (first === 'd') {
        const weekday = parseWeekday(second);
        return weekday === null ? null : { kind: 'auto-reserve-day', weekday };
      }
      return null;
    }

    case 'f': {
      if (first === 's') {
        const reserveId = parsePositiveInt(second);
        return reserveId === null ? null : { kind: 'forget-code-share', reserveId };
      }
      if (first === 'c') {
        const reserveId = parsePositiveInt(second);
        return reserveId === null ? null : { kind: 'forget-code-share-confirm', reserveId };
      }
      if (first === 'g') {
        const selfId = parsePositiveInt(second);
        return selfId === null ? null : { kind: 'forget-code-receive-self', selfId };
      }
      return null;
    }

    case 'x': {
      if (first === 'u') {
        const telegramId = parsePositiveInt(second);
        return telegramId === null ? null : { kind: 'admin-user', telegramId };
      }
      if (first === 'q') {
        const telegramId = parsePositiveInt(second);
        return telegramId === null ? null : { kind: 'admin-logout-prompt', telegramId };
      }
      if (first === 'l') {
        const telegramId = parsePositiveInt(second);
        return telegramId === null ? null : { kind: 'admin-logout-confirm', telegramId };
      }
      if (first === 't') {
        const ticketId = parsePositiveInt(second);
        return ticketId === null ? null : { kind: 'admin-close-ticket', ticketId };
      }
      if (first === 'b') {
        if (second === 'y') {
          return { kind: 'admin-broadcast-send' };
        }
        if (second === 'n') {
          return { kind: 'admin-broadcast-cancel' };
        }
        return null;
      }
      if (first === 'p') {
        return second === 'y' ? { kind: 'admin-purge' } : null;
      }
      if (first === 'f') {
        return second !== undefined && isFeatureKey(second) ? { kind: 'admin-toggle-feature', feature: second } : null;
      }
      if (first === 's') {
        if (second === 'l') {
          return { kind: 'admin-schedule-list' };
        }

        if (second === 'e') {
          const job = parseJobName(third);
          return job === null ? null : { kind: 'admin-schedule-edit', job };
        }

        if (second === 'r') {
          const job = parseJobName(third);
          return job === null ? null : { kind: 'admin-schedule-reset', job };
        }

        // A step carries four tokens: field, direction, then the job name.
        const field = parseField(second);
        const job = parseJobName(fourth);

        if (field === null || job === null || (third !== 'u' && third !== 'd')) {
          return null;
        }

        return { kind: 'admin-schedule-step', job, field, delta: third === 'u' ? 1 : -1 };
      }
      return null;
    }

    default:
      return null;
  }
}
