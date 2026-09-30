import type { Context, MiddlewareFn, Telegraf } from 'telegraf';
import { scopedLogger } from '../shared/logger';

const log = scopedLogger('telegram');

type TelegramClient = Telegraf['telegram'];

/**
 * The wrapped call, typed loosely on purpose: the real method is generic over the
 * method name — `callApi('sendMessage', …)` returns a `Message` and
 * `callApi('answerCbQuery', …)` returns `true` — and a wrapper that inspects the
 * call without caring about the result cannot keep that generic.
 */
type LooseCallApi = (method: string, payload: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<unknown>;

/** Marks a client class whose `callApi` is already traced, so a second bot cannot double-log. */
const TRACED = Symbol('traced telegram client');

/** The slice of the client class this module patches. */
interface TraceablePrototype {
  callApi: LooseCallApi;
  [TRACED]?: boolean;
}

/**
 * Logs every Telegram API call, and what came back.
 *
 * Patches the **prototype**, not the instance it is handed, and that distinction
 * is the whole point. `Telegraf.handleUpdate` builds a fresh client for every
 * update — `const tg = new Telegram(this.token, this.telegram.options, …)` — and
 * gives *that* to the `Context`, so `ctx.telegram !== bot.telegram`. Wrapping the
 * instance logs only what the bot sends outside a handler (`getMe`, the webhook
 * calls, a notifier's messages) and silently drops every `sendMessage`,
 * `sendChatAction` and `answerCbQuery` a handler makes. The log then reads
 * "update received" followed by nothing, which is indistinguishable from a
 * handler that hung — the worst possible failure for a tracing feature.
 *
 * `getUpdates` is the exception: it is the long-poll heartbeat, one call per
 * second for the life of the process, and a line per call would bury the traffic
 * that matters. Its failures are still logged — only the success line is skipped.
 */
export function logApiCalls(telegram: TelegramClient): void {
  const prototype = Object.getPrototypeOf(telegram) as TraceablePrototype;

  if (prototype[TRACED] === true) {
    return;
  }

  const original = prototype.callApi;
  prototype[TRACED] = true;

  prototype.callApi = async function tracedCallApi(
    this: unknown,
    method: string,
    payload: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<unknown> {
    const startedAt = Date.now();

    try {
      const result = await original.call(this, method, payload, options);

      if (method !== 'getUpdates') {
        log.debug({ method, ...chatOf(payload), durationMs: Date.now() - startedAt, result: summarize(result) }, 'telegram call');
      }

      return result;
    } catch (error) {
      log.warn({ err: error, method, ...chatOf(payload), durationMs: Date.now() - startedAt }, 'telegram call failed');
      throw error;
    }
  };
}

/**
 * The first middleware in the chain, so every update is on the record before
 * anything claims it.
 *
 * What is logged is the update's identity, never its content. The login wizard
 * takes the user's Samad password as an ordinary message, so an update logged
 * verbatim would write passwords into the log file. `callbackData` is the
 * exception, and it is safe: it is this bot's own encoding of an action, and it
 * is the one field that says which button was pressed.
 */
export const logUpdate: MiddlewareFn<Context> = async (ctx, next) => {
  log.debug(
    {
      updateId: ctx.update.update_id,
      updateType: ctx.updateType,
      chatId: ctx.chat?.id,
      fromId: ctx.from?.id,
      messageId: ctx.message?.message_id,
      callbackData: ctx.callbackQuery !== undefined && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined,
    },
    'update received',
  );

  await next();
};

/** The chat an outgoing call is aimed at. `chat_id` may also be an `@channel` name, so both shapes are kept. */
function chatOf(payload: Record<string, unknown>): { chatId?: number | string } {
  const chatId = payload.chat_id;

  return typeof chatId === 'number' || typeof chatId === 'string' ? { chatId } : {};
}

/**
 * A response, reduced to what is safe to write down.
 *
 * The verbatim result cannot be logged. `getUpdates` returns the pending updates
 * — every message typed since the last poll — and a `Message` echoes the text
 * that was just sent, so the raw object is exactly the thing that would put user
 * content, passwords included, into the log file. An array becomes its length, a
 * message becomes its id, and everything else is already a scalar or a small
 * object worth having.
 */
function summarize(result: unknown): unknown {
  if (Array.isArray(result)) {
    return { count: result.length };
  }

  if (typeof result === 'object' && result !== null && 'message_id' in result) {
    return { messageId: (result as { message_id: unknown }).message_id };
  }

  return result;
}
