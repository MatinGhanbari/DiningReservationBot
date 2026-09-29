import { beforeEach, describe, expect, it } from 'vitest';
import { TtlMap } from '../src/cache/ttl-map';
import { FixedClock } from '../src/shared/clock';

const NOW = '2026-09-20T06:00:00Z';

describe('TtlMap', () => {
  let clock: FixedClock;

  beforeEach(() => {
    clock = new FixedClock(new Date(NOW));
  });

  it('stores and returns a value', () => {
    const map = new TtlMap<string>({ maxEntries: 10, clock });
    map.set(1, 'a', 60_000);

    expect(map.get(1)).toBe('a');
  });

  it('returns null for a missing key', () => {
    const map = new TtlMap<string>({ maxEntries: 10, clock });

    expect(map.get(42)).toBeNull();
  });

  it('expires an entry after its lifetime', () => {
    const map = new TtlMap<string>({ maxEntries: 10, clock });
    map.set(1, 'a', 1_000);

    clock.advance(999);
    expect(map.get(1)).toBe('a');

    clock.advance(2);
    expect(map.get(1)).toBeNull();
  });

  it('drops an entry stored with a non-positive lifetime', () => {
    const map = new TtlMap<string>({ maxEntries: 10, clock });
    map.set(1, 'a', 60_000);
    map.set(1, 'a', 0);

    // A session whose token already expired must read as absent, not as stale.
    expect(map.get(1)).toBeNull();
  });

  it('evicts the least recently used entry when full', () => {
    const map = new TtlMap<string>({ maxEntries: 2, clock });

    map.set(1, 'a', 60_000);
    map.set(2, 'b', 60_000);

    // Touching 1 makes 2 the least recently used.
    map.get(1);
    map.set(3, 'c', 60_000);

    expect(map.get(2)).toBeNull();
    expect(map.get(1)).toBe('a');
    expect(map.get(3)).toBe('c');
  });

  it('re-inserting a key keeps its recency current', () => {
    const map = new TtlMap<string>({ maxEntries: 2, clock });

    map.set(1, 'a', 60_000);
    map.set(2, 'b', 60_000);
    map.set(1, 'a2', 60_000);
    map.set(3, 'c', 60_000);

    expect(map.get(2)).toBeNull();
    expect(map.get(1)).toBe('a2');
  });

  it('counts only live entries in its size', () => {
    const map = new TtlMap<string>({ maxEntries: 10, clock });

    map.set(1, 'a', 1_000);
    map.set(2, 'b', 60_000);
    clock.advance(2_000);

    expect(map.size).toBe(1);
  });

  it('sweeps expired entries and reports how many it removed', () => {
    const map = new TtlMap<string>({ maxEntries: 10, clock });

    map.set(1, 'a', 1_000);
    map.set(2, 'b', 1_000);
    map.set(3, 'c', 60_000);
    clock.advance(2_000);

    expect(map.sweep()).toBe(2);
    expect(map.sweep()).toBe(0);
  });

  it('deletes a key explicitly', () => {
    const map = new TtlMap<string>({ maxEntries: 10, clock });
    map.set(1, 'a', 60_000);

    map.delete(1);

    expect(map.get(1)).toBeNull();
  });

  it('reports presence without disturbing recency semantics', () => {
    const map = new TtlMap<string>({ maxEntries: 10, clock });
    map.set(1, 'a', 1_000);

    expect(map.has(1)).toBe(true);

    clock.advance(2_000);
    expect(map.has(1)).toBe(false);
  });
});
