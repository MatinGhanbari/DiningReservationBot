import { describe, expect, it } from 'vitest';
import { decodeCallback, encodeCallback, type CallbackAction } from '../src/bot/callback-data';

const actions: CallbackAction[] = [
  { kind: 'select-university', universityId: 8 },
  { kind: 'choose-self', week: 'current' },
  { kind: 'choose-self', week: 'next' },
  { kind: 'select-self', week: 'next', selfId: 12 },
  { kind: 'show-reserves', week: 'current' },
  { kind: 'reserve-meal', programId: 987, foodTypeId: 42, mealTypeId: 2 },
  { kind: 'auto-reserve-self', selfId: 5 },
  { kind: 'auto-reserve-day', weekday: 0 },
  { kind: 'auto-reserve-day', weekday: 6 },
  { kind: 'forget-code-share', reserveId: 101 },
  { kind: 'forget-code-share-confirm', reserveId: 101 },
  { kind: 'forget-code-receive-self', selfId: 3 },
];

describe('callback data', () => {
  it.each(actions)('round-trips $kind', action => {
    expect(decodeCallback(encodeCallback(action))).toEqual(action);
  });

  it('keeps every payload inside Telegram 64-byte limit', () => {
    for (const action of actions) {
      expect(Buffer.byteLength(encodeCallback(action), 'utf8')).toBeLessThanOrEqual(64);
    }
  });

  it('returns null for data it does not recognise', () => {
    // Old buttons from a previous deployment are still sitting in chat histories,
    // so this must not throw.
    for (const data of ['', 'unknown', 'u:', 'u:abc', 'u:-1', 's:x:1', 's:c:', 'a:z:1', 'a:d:9', 'f:q:1', 'm:1']) {
      expect(decodeCallback(data)).toBeNull();
    }
  });

  it('rejects a weekday outside the Persian week', () => {
    expect(decodeCallback('a:d:7')).toBeNull();
    expect(decodeCallback('a:d:6')).toEqual({ kind: 'auto-reserve-day', weekday: 6 });
  });

  it('rejects non-numeric ids rather than coercing them', () => {
    expect(decodeCallback('m:abc:5')).toBeNull();
    expect(decodeCallback('m:1:2.5')).toBeNull();
  });
});
