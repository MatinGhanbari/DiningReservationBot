import type { Logger } from 'pino';
import { Agent, type Dispatcher } from 'undici';
import { findUniversityById } from '../domain/universities';
import { isTransientNetworkError, retry } from '../shared/async';
import { readTextWithLimit, redactUrl } from '../shared/http';
import { InvalidCredentialsError, SessionExpiredError, UpstreamRejectedError, UpstreamUnavailableError } from '../shared/errors';
import type { SamadEnvelope } from './types';

export interface SamadHttpClientOptions {
  timeoutMs: number;
  /** Additional attempts after the first one, for requests that are safe to repeat. */
  maxRetries: number;
  logger: Logger;
  /**
   * Verify Samad's TLS certificate chain. True by default. Set false only when
   * Samad's host serves an incomplete chain that Node refuses but browsers
   * tolerate — this disables chain validation for Samad traffic.
   */
  verifyTls: boolean;
}

export interface SamadRequest {
  universityId: number;
  /** Path relative to the university's base URL, starting with a slash. */
  path: string;
  method: 'GET' | 'POST' | 'PUT';
  accessToken?: string;
  query?: Record<string, string | number | undefined>;
  jsonBody?: unknown;
  formBody?: Record<string, string>;
  /** Endpoint-specific headers, such as the Basic credential the token endpoint wants. */
  extraHeaders?: Record<string, string>;
  /**
   * What a 401 means for this particular call.
   *
   * On a normal request it means the stored token is stale and the user should
   * be re-authenticated silently. On the login call itself it means the password
   * was wrong, which is a different message and must not be retried.
   */
  onUnauthorized?: 'session-expired' | 'invalid-credentials';
  /**
   * Allows repeating a non-idempotent request.
   *
   * Off by default: a PUT that reserves a meal may well have succeeded even
   * though the response never arrived, and retrying it would reserve twice.
   */
  allowRetry?: boolean;
}

function extractUpstreamMessage(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const envelope = payload as SamadEnvelope;
  const candidate = envelope.messageFa ?? envelope.message;

  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate.trim() : null;
}

/**
 * Talks HTTP to Samad.
 *
 * Responsibilities kept here and nowhere else: URL construction, timeouts,
 * retry policy, and turning transport-level outcomes into the application's
 * error types. Callers deal in domain concepts and never see a status code.
 */
export class SamadHttpClient {
  constructor(private readonly options: SamadHttpClientOptions) {}

  /**
   * Built once, only when TLS verification is disabled. An undici dispatcher with
   * `rejectUnauthorized: false` relaxes the cert chain check that Node enforces
   * but browsers work around automatically.
   */
  private insecureDispatcher: Dispatcher | null = null;

  private get dispatcher(): Dispatcher | undefined {
    if (this.options.verifyTls) {
      return undefined;
    }

    if (this.insecureDispatcher === null) {
      this.insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    }

    return this.insecureDispatcher;
  }

  async request<T>(request: SamadRequest): Promise<T> {
    const university = findUniversityById(request.universityId);

    if (university === undefined) {
      throw new UpstreamRejectedError(`Unsupported university id: ${request.universityId}`, 'این دانشگاه در حال حاضر پشتیبانی نمی‌شود.', {
        context: { universityId: request.universityId },
      });
    }

    const url = new URL(request.path, university.baseUrl);

    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = { accept: 'application/json', ...request.extraHeaders };
    let body: string | undefined;

    if (request.accessToken !== undefined) {
      headers.authorization = `Bearer ${request.accessToken}`;
    }

    if (request.jsonBody !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(request.jsonBody);
    } else if (request.formBody !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      body = new URLSearchParams(request.formBody).toString();
    }

    const isIdempotent = request.method === 'GET';
    const attempts = isIdempotent || request.allowRetry === true ? this.options.maxRetries + 1 : 1;

    return retry(() => this.attempt<T>(url, request, headers, body), {
      attempts,
      baseDelayMs: 300,
      maxDelayMs: 3_000,
      shouldRetry: error => isTransientNetworkError(error),
      onRetry: (error, attempt, delayMs) => {
        this.options.logger.warn(
          { err: error, attempt, delayMs, path: request.path, universityId: request.universityId },
          'retrying Samad request',
        );
      },
    });
  }

  private async attempt<T>(url: URL, request: SamadRequest, headers: Record<string, string>, body: string | undefined): Promise<T> {
    const startedAt = Date.now();
    const safeUrl = redactUrl(url);

    let response: Response;

    try {
      response = await fetch(url, {
        method: request.method,
        headers,
        body,
        signal: AbortSignal.timeout(this.options.timeoutMs),
        // A 3xx to another host would otherwise carry the bearer token with it.
        // Samad's API does not redirect, so a redirect is an error, not a
        // navigation to follow.
        redirect: 'manual',
        // Only set when verification is disabled; otherwise undefined, which
        // leaves the default secure dispatcher in place.
        dispatcher: this.dispatcher,
      });
    } catch (error) {
      throw new UpstreamUnavailableError({
        cause: error,
        context: { url: safeUrl, method: request.method },
      });
    }

    const durationMs = Date.now() - startedAt;

    if (response.status >= 300 && response.status < 400) {
      throw new UpstreamUnavailableError({ context: { status: response.status, url: safeUrl } });
    }

    if (response.status === 401 || response.status === 403) {
      this.options.logger.warn({ status: response.status, path: request.path, durationMs }, 'Samad rejected the credentials');

      if (request.onUnauthorized === 'invalid-credentials') {
        throw new InvalidCredentialsError({ context: { url: safeUrl } });
      }

      throw new SessionExpiredError({ context: { url: safeUrl } });
    }

    if (response.status >= 500) {
      throw new UpstreamUnavailableError({ context: { status: response.status, url: safeUrl, durationMs } });
    }

    const rawText = await readTextWithLimit(response);
    const payload = this.parsePayload(rawText, safeUrl);

    if (!response.ok) {
      const upstreamMessage = extractUpstreamMessage(payload);
      throw new UpstreamRejectedError(
        `Samad responded ${response.status} for ${request.path}`,
        upstreamMessage ?? 'سماد این درخواست را نپذیرفت. لطفاً یک‌بار دیگر امتحان کن.',
        { context: { status: response.status, url: safeUrl } },
      );
    }

    this.options.logger.debug({ path: request.path, status: response.status, durationMs }, 'Samad request completed');

    return payload as T;
  }

  /**
   * Parses a response body, tolerating the two shapes Samad produces on failure:
   * an HTML error page from the reverse proxy, and an empty body.
   *
   * The body is never echoed into the log. An error page from a proxy can contain
   * the request that caused it, which for this client means credentials.
   */
  private parsePayload(rawText: string, safeUrl: string): unknown {
    if (rawText.trim().length === 0) {
      return {};
    }

    try {
      return JSON.parse(rawText) as unknown;
    } catch (error) {
      throw new UpstreamUnavailableError({
        cause: error,
        context: { url: safeUrl, bodyLength: rawText.length },
      });
    }
  }
}
