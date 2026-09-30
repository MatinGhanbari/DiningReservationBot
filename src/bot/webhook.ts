import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Telegraf } from 'telegraf';
import type { Update } from 'telegraf/types';
import { sleep } from '../shared/async';
import { scopedLogger } from '../shared/logger';

const log = scopedLogger('webhook');

/** Where Telegram puts the `setWebhook` secret on every delivery. */
const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/**
 * How much of a delivery is read before it is refused.
 *
 * A real update is a few kilobytes: text, entities, a caption. The cap exists
 * because the body is untrusted — without it, anyone who learns the path can
 * stream gigabytes into the process and have it killed by the allocator.
 */
const MAX_BODY_BYTES = 1024 * 1024;

/** How often the drain loop re-checks whether the last update has finished. */
const DRAIN_POLL_MS = 100;

export interface WebhookReceiver {
  /** The route the deliveries arrive on. */
  path: string;
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  /**
   * Waits for the updates already being processed, up to `deadlineMs`.
   *
   * Nothing else waits for them: the HTTP connection is closed as soon as the
   * delivery is acknowledged, so without this the process would close the
   * database underneath work that is still running.
   */
  drain: (deadlineMs: number) => Promise<void>;
}

/**
 * Receives Telegram's deliveries: acknowledge first, process afterwards.
 *
 * Telegraf's own `webhookCallback` ends the response only once the whole
 * middleware chain has finished, and that chain has a 90-second budget — so
 * Telegram is left holding the request for as long as the slowest handler runs,
 * and an update that overruns is killed *after* the platform has been made to
 * wait for it. Reading the body and answering `200` straight away takes the wait
 * off the delivery path: Telegram's own timeout and retry logic never sees a
 * slow handler, and the update is processed in the background.
 *
 * What that costs is the meaning of the acknowledgement. `200` now says
 * "accepted", not "processed", and Telegram does not redeliver an update whose
 * handling failed. Failures therefore have to be visible in the log instead of
 * being retried by the platform, which is what the lines below are for. The
 * other casualty is Telegraf's `webhookReply` optimisation, which answers the
 * first API call in the response body: there is no longer a response to answer
 * in, so every call becomes a real request.
 */
export function createWebhookReceiver(bot: Telegraf, options: { path: string; secretToken: string }): WebhookReceiver {
  const inFlight = new Set<Promise<void>>();

  if (options.secretToken.length === 0) {
    log.warn('no webhook secret is configured, so any caller that knows the path can inject updates');
  }

  return {
    path: options.path,

    handler: async (request, response) => {
      const receivedAt = Date.now();

      if (!secretMatches(options.secretToken, request.headers[SECRET_HEADER])) {
        log.warn({ presented: typeof request.headers[SECRET_HEADER] === 'string' }, 'rejected a delivery whose secret token did not match');
        respond(response, 403, 'forbidden');
        return;
      }

      const declaredLength = Number(request.headers['content-length'] ?? '0');

      if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
        log.warn({ declaredLength }, 'refused a delivery larger than the body cap');
        respond(response, 413, 'body too large');
        return;
      }

      let update: Update;

      try {
        update = parseUpdate(await readBody(request));
      } catch (error) {
        log.warn({ err: error }, 'rejected a delivery whose body could not be read');
        respond(response, 415, 'unreadable body');
        return;
      }

      const identity = identify(update);

      // The acknowledgement, and the reason this module exists. Everything below
      // this line runs with the request already answered and closed.
      respond(response, 200, 'ok');

      // The arrival is already on the record: `logUpdate` is the first
      // middleware in the chain, and it runs inside `handleUpdate` below. What
      // only this layer can measure is the delivery path itself — how long the
      // body took to read before the platform got its answer.
      log.debug({ ...identity, readMs: Date.now() - receivedAt }, 'delivery acknowledged');

      const task = processUpdate(bot, update, identity);

      inFlight.add(task);
      void task.finally(() => {
        inFlight.delete(task);
      });
    },

    drain: async (deadlineMs: number) => {
      const startedAt = Date.now();

      while (inFlight.size > 0 && Date.now() - startedAt < deadlineMs) {
        await Promise.race([Promise.all([...inFlight]), sleep(DRAIN_POLL_MS)]);
      }

      if (inFlight.size > 0) {
        log.warn({ pending: inFlight.size, waitedMs: Date.now() - startedAt }, 'stopping with updates still being processed');
      }
    },
  };
}

/**
 * Runs one acknowledged update, and says how it went.
 *
 * The promise never rejects: it is fire-and-forget from the HTTP layer's point
 * of view, and a rejection there would have nobody to catch it — `main.ts` turns
 * an unhandled rejection into a process exit.
 */
async function processUpdate(bot: Telegraf, update: Update, identity: UpdateIdentity): Promise<void> {
  const startedAt = Date.now();

  try {
    await bot.handleUpdate(update);

    // A handler that ran past Telegraf's 90-second budget has already been
    // reported by `bot.catch`; this line is what shows how long it actually
    // took, and it arrives even for an update that was killed and kept running.
    log.debug({ ...identity, durationMs: Date.now() - startedAt }, 'update processed');
  } catch (error) {
    // A handler's own failure is funnelled into `bot.catch` by Telegraf, so
    // reaching here means the failure was outside the middleware chain: the
    // `getMe` on the first update, or the catch handler itself.
    log.error({ ...identity, durationMs: Date.now() - startedAt, err: error }, 'update could not be processed');
  }
}

/** The few fields that make a log line traceable back to one delivery. */
interface UpdateIdentity {
  updateId: number;
  updateType: string;
  telegramId?: number;
  chatId?: number;
}

/**
 * Reads the identity out of a delivery defensively.
 *
 * This runs before any middleware, so there is no Telegraf context yet, and the
 * payload is untrusted until a handler has looked at it — hence the shape
 * checks rather than a cast to the union of every update type.
 */
function identify(update: Update): UpdateIdentity {
  const updateType = Object.keys(update).find(key => key !== 'update_id') ?? 'unknown';
  const payload = (update as unknown as Record<string, unknown>)[updateType];
  const envelope = (typeof payload === 'object' && payload !== null ? payload : {}) as {
    from?: { id?: number };
    chat?: { id?: number };
    message?: { chat?: { id?: number } };
  };

  return {
    updateId: update.update_id,
    updateType,
    telegramId: envelope.from?.id,
    chatId: envelope.chat?.id ?? envelope.message?.chat?.id,
  };
}

/**
 * Parses a delivery body, refusing anything that is not an update.
 *
 * An update is an object with a numeric `update_id`. Accepting a body without
 * one would mean acknowledging something the bot cannot act on, which hides a
 * broken proxy or a wrong route behind a `200`.
 */
function parseUpdate(body: string): Update {
  const parsed: unknown = JSON.parse(body);

  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as Update).update_id !== 'number') {
    throw new Error('Delivery body is not a Telegram update');
  }

  return parsed as Update;
}

/**
 * Reads the request body, refusing to buffer past the cap.
 *
 * `content-length` is checked by the caller before this runs, which covers every
 * real delivery; this is the backstop for a chunked body that declares nothing.
 */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;

    if (size > MAX_BODY_BYTES) {
      throw new Error(`Delivery body exceeded ${MAX_BODY_BYTES} bytes`);
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Compares the delivery's secret without leaking it through timing.
 *
 * `timingSafeEqual` throws when the two buffers differ in length, so the length
 * is compared first: a length is not the secret. An empty configured secret
 * disables the check, which is the same trade-off Telegraf's own filter makes —
 * and the reason the constructor warns about it.
 */
function secretMatches(expected: string, received: unknown): boolean {
  if (expected.length === 0) {
    return true;
  }

  if (typeof received !== 'string') {
    return false;
  }

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');

  return a.length === b.length && timingSafeEqual(a, b);
}

function respond(response: ServerResponse, statusCode: number, message: string): void {
  if (response.headersSent || response.writableEnded) {
    response.end();
    return;
  }

  const payload = JSON.stringify({ status: statusCode === 200 ? 'ok' : 'error', message });

  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });

  response.end(payload);
}
