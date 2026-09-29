import type { Clock } from '../domain/ports';

interface Entry<Value> {
  value: Value;
  expiresAt: number;
}

export interface TtlMapOptions {
  /** Upper bound on live entries; the least recently used one is evicted first. */
  maxEntries: number;
  clock: Clock;
}

/**
 * A bounded map whose entries expire and which evicts least-recently-used first.
 *
 * Two failure modes are handled here because both of them are silent otherwise:
 *
 *   - Unbounded growth. Every user who ever talks to the bot would keep an entry
 *     forever, and a long-running container would slowly leak memory. `maxEntries`
 *     plus LRU eviction caps it.
 *   - Expired-but-present entries. A session past its token lifetime must read as
 *     absent, not as a stale token that Samad will reject with a confusing error.
 *
 * Map iteration order is insertion order, and `get` re-inserts on hit, so the
 * first key is always the least recently used.
 */
export class TtlMap<Value> {
  private readonly entries = new Map<number, Entry<Value>>();

  private readonly maxEntries: number;

  private readonly clock: Clock;

  constructor(options: TtlMapOptions) {
    this.maxEntries = Math.max(1, options.maxEntries);
    this.clock = options.clock;
  }

  get(key: number): Value | null {
    const entry = this.entries.get(key);

    if (entry === undefined) {
      return null;
    }

    if (entry.expiresAt <= this.clock.now().getTime()) {
      this.entries.delete(key);
      return null;
    }

    // Refresh recency by re-inserting at the end.
    this.entries.delete(key);
    this.entries.set(key, entry);

    return entry.value;
  }

  set(key: number, value: Value, ttlMs: number): void {
    if (ttlMs <= 0) {
      this.entries.delete(key);
      return;
    }

    // Re-inserting keeps the key's position current even when it already existed.
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.clock.now().getTime() + ttlMs });

    this.evictOverflow();
  }

  delete(key: number): void {
    this.entries.delete(key);
  }

  has(key: number): boolean {
    return this.get(key) !== null;
  }

  /** Number of live entries, expired ones excluded. */
  get size(): number {
    this.sweep();
    return this.entries.size;
  }

  /** Drops every expired entry. Safe to call from a periodic timer. */
  sweep(): number {
    const now = this.clock.now().getTime();
    let removed = 0;

    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        removed += 1;
      }
    }

    return removed;
  }

  clear(): void {
    this.entries.clear();
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next();
      if (oldestKey.done === true) {
        return;
      }
      this.entries.delete(oldestKey.value);
    }
  }
}
