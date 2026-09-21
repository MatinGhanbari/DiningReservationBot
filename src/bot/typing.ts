import type { Context } from 'telegraf';
import { scopedLogger } from '../shared/logger';

const log = scopedLogger('typing');

/**
 * How often the indicator is refreshed while a slow operation runs.
 *
 * Telegram clears «typing…» roughly five seconds after it is set, so a single
 * call before a twenty-second upstream request leaves the user watching a chat
 * that looks dead again. Four seconds keeps it continuously on without sending
 * a request more often than the state can expire.
 */
const REFRESH_INTERVAL_MS = 4_000;

/**
 * The shortest gap between two indicators in the same chat.
 *
 * Several handlers reply twice in a row — a «در حال دریافت…» notice and then the
 * result — and without this each would cost its own API call for a state that
 * was already showing. Telegram counts a chat action against the same per-chat
 * rate limit as a message, so suppressing the redundant ones is not just tidier,
 * it keeps a chatty flow from looking like a flood.
 */
const MIN_INTERVAL_MS = 3_000;

/** Upper bound on tracked chats, so a long-running process cannot grow this forever. */
const MAX_TRACKED_CHATS = 5_000;

/**
 * The «typing…» indicator, with the bookkeeping Telegram does not do for us.
 *
 * Kept as a class rather than as loose functions so the throttle window and the
 * clock are injectable, which is what makes it testable without waiting four
 * real seconds.
 */
export class TypingIndicator {
  private readonly lastShownAt = new Map<number, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly minIntervalMs: number = MIN_INTERVAL_MS,
  ) {}

  /**
   * Shows the indicator in one chat, unless it was already shown a moment ago.
   *
   * `force` is for the keep-alive timer, which exists precisely to re-send the
   * state before it expires and must not be suppressed by its own throttle.
   *
   * The send is passed in rather than performed here so the class stays free of
   * Telegraf: the caller decides what "show the indicator" means.
   */
  async show(chatId: number, send: () => Promise<unknown>, options: { force?: boolean } = {}): Promise<void> {
    const at = this.now();
    const previous = this.lastShownAt.get(chatId);

    if (options.force !== true && previous !== undefined && at - previous < this.minIntervalMs) {
      return;
    }

    this.lastShownAt.set(chatId, at);
    this.prune(at);

    try {
      await send();
    } catch (error) {
      // A chat action is decoration: it carries no information the user needs
      // and failing to set it must never fail the reply it was decorating.
      log.debug({ err: error, chatId }, 'could not show the typing indicator');
    }
  }

  /** Forgets a chat, so the next indicator in it is sent immediately. */
  forget(chatId: number): void {
    this.lastShownAt.delete(chatId);
  }

  private prune(at: number): void {
    if (this.lastShownAt.size <= MAX_TRACKED_CHATS) {
      return;
    }

    for (const [chatId, seenAt] of this.lastShownAt) {
      if (at - seenAt > this.minIntervalMs * 10) {
        this.lastShownAt.delete(chatId);
      }
    }
  }
}

/**
 * The instance behind the free functions.
 *
 * Module-level on purpose: the throttle is a property of the transport, not of
 * the domain, and threading an indicator through every handler would be a lot of
 * plumbing for a piece of UI state that has no meaning outside Telegram. It
 * holds nothing but the last time each chat was told «typing», so nothing here
 * can drift from the database or from a service's own state.
 */
const shared = new TypingIndicator();

/** Shows «typing…» in the chat an update came from. Best effort, never throws. */
export async function sendTyping(ctx: Context, options: { force?: boolean } = {}): Promise<void> {
  const chatId = ctx.chat?.id;

  if (chatId === undefined) {
    return;
  }

  await shared.show(chatId, () => ctx.telegram.sendChatAction(chatId, 'typing'), options);
}

/**
 * Runs a slow operation with the indicator held on for its whole duration.
 *
 * This is the difference the user actually sees: `sendTyping` alone says «typing…»
 * once and Telegram forgets it five seconds later, which is exactly when a Samad
 * request or a language model call is still in flight.
 */
export async function withTyping<T>(ctx: Context, work: () => Promise<T>): Promise<T> {
  const chatId = ctx.chat?.id;

  if (chatId === undefined) {
    return work();
  }

  await sendTyping(ctx, { force: true });

  const timer = setInterval(() => {
    void sendTyping(ctx, { force: true });
  }, REFRESH_INTERVAL_MS);

  // A stray timer would hold the process open on shutdown; the operation it
  // belongs to is always shorter than the process's own lifetime anyway.
  timer.unref();

  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}
