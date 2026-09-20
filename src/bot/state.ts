import type { Clock } from '../domain/ports';
import { config } from '../config/env';
import { TtlMap } from '../cache/ttl-map';
import { MINUTE } from '../shared/time';

/**
 * What the bot is waiting for from a particular person.
 *
 * The original code kept this in a plain `Map` keyed by the Telegram id and
 * stored a bare string per user. Two consequences: a half-finished login was
 * indistinguishable from a deliberate one, and the whole record was overwritten
 * on every transition, so the university chosen in step one was lost by step two
 * and had to be re-read from stale variables.
 *
 * A tagged union fixes both — each step carries exactly the context the next
 * step needs, and TypeScript refuses to read a field that the current step does
 * not have.
 */
export type ConversationState =
  | { step: 'awaiting-username'; universityId: number }
  | { step: 'awaiting-password'; universityId: number; samadUsername: string }
  | { step: 'awaiting-support-message' }
  | { step: 'awaiting-bad-forget-code' };

export interface ConversationStore {
  get(telegramId: number): Promise<ConversationState | null>;
  set(telegramId: number, state: ConversationState): Promise<void>;
  clear(telegramId: number): Promise<void>;
  size(): number;
}

/**
 * How long a half-finished flow stays alive.
 *
 * Long enough to look up a password, short enough that an abandoned login does
 * not silently capture an unrelated message an hour later and try to use it as
 * a password.
 */
const STATE_TTL_MS = 15 * MINUTE;

/**
 * Per-process conversation state.
 *
 * This is deliberately in memory rather than in the database: it is ephemeral,
 * worthless after a restart, and writing it to disk would mean a `fsync` per
 * message for data nobody would miss.
 */
export class MemoryConversationStore implements ConversationStore {
  private readonly states: TtlMap<ConversationState>;

  constructor(clock: Clock, maxEntries: number = config.SESSION_MAX_ENTRIES) {
    this.states = new TtlMap<ConversationState>({ maxEntries, clock });
  }

  async get(telegramId: number): Promise<ConversationState | null> {
    return this.states.get(telegramId);
  }

  async set(telegramId: number, state: ConversationState): Promise<void> {
    this.states.set(telegramId, state, STATE_TTL_MS);
  }

  async clear(telegramId: number): Promise<void> {
    this.states.delete(telegramId);
  }

  size(): number {
    return this.states.size;
  }

  /** Drops expired flows; called by the periodic maintenance timer. */
  sweep(): number {
    return this.states.sweep();
  }
}
