import type { SamadSession } from '../domain/models';
import type { Clock, SessionStore } from '../domain/ports';
import { config } from '../config/env';
import { TtlMap } from './ttl-map';

/**
 * Samad access tokens, held in process memory.
 *
 * This replaces the Redis instance the original code required. For a single
 * container serving this traffic volume, a remote store bought nothing except an
 * extra dependency, an extra failure mode, and a network round trip on the hot
 * path of every message. The trade is explicit: the cache is per-process, so
 * running more than one replica would need a shared store again.
 */
export class MemorySessionStore implements SessionStore {
  private readonly sessions: TtlMap<SamadSession>;

  constructor(clock: Clock, maxEntries: number = config.SESSION_MAX_ENTRIES) {
    this.sessions = new TtlMap<SamadSession>({ maxEntries, clock });
  }

  async get(telegramId: number): Promise<SamadSession | null> {
    return this.sessions.get(telegramId);
  }

  async set(telegramId: number, session: SamadSession, ttlMs: number): Promise<void> {
    this.sessions.set(telegramId, session, ttlMs);
  }

  async delete(telegramId: number): Promise<void> {
    this.sessions.delete(telegramId);
  }

  size(): number {
    return this.sessions.size;
  }

  /** Drops expired sessions; called by the periodic maintenance timer. */
  sweep(): number {
    return this.sessions.sweep();
  }
}
