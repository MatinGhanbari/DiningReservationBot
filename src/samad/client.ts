import type { Logger } from 'pino';
import { findUniversityById } from '../domain/universities';
import { isTransientNetworkError, retry } from '../shared/async';
import {
  InvalidCredentialsError,
  SessionExpiredError,
  UpstreamRejectedError,
  UpstreamUnavailableError,
} from '../shared/errors';
import type { SamadEnvelope } from './types';

export interface SamadHttpClientOptions {
  timeoutMs: number;
  /** Additional attempts after the first one, for requests that are safe to repeat. */
  maxRetries: number;
  logger: Logger;
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

  async request<T>(request: SamadRequest): Promise<T> {
    const university = findUniversityById(request.universityId);

    if (university === undefined) {
      throw new UpstreamRejectedError(
        `Unsupported university id: ${request.universityId}`,
        'این دانشگاه در حال حاضر پشتیبانی نمی‌شود.',
        { context: { universityId: request.universityId } },
      );
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

  private async attempt<T>(
    url: URL,
    request: SamadRequest,
    headers: Record<string, string>,
    body: string | undefined,
  ): Promise<T> {
    const startedAt = Date.now();
    let response: Response;

    try {
      // AbortSignal.timeout cancels the request itself, so a hung socket is
      // released instead of merely being ignored by an impatient caller.
      response = await fetch(url, {
        method: request.method,
        headers,
        body,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw new UpstreamUnavailableError({
        cause: error,
        context: { url: url.toString(), method: request.method },
      });
    }

    const durationMs = Date.now() - startedAt;

    if (response.status === 401 || response.status === 403) {
      this.options.logger.warn(
        { status: response.status, path: request.path, durationMs },
        'Samad rejected the credentials',
      );

      if (request.onUnauthorized === 'invalid-credentials') {
        throw new InvalidCredentialsError({ context: { url: url.toString() } });
      }

      throw new SessionExpiredError({ context: { url: url.toString() } });
    }

    if (response.status >= 500) {
      throw new UpstreamUnavailableError({
        context: { status: response.status, url: url.toString(), durationMs },
      });
    }

    const rawText = await response.text();
    const payload = this.parsePayload(rawText, url);

    if (!response.ok) {
      const upstreamMessage = extractUpstreamMessage(payload);
      throw new UpstreamRejectedError(
        `Samad responded ${response.status} for ${request.path}`,
        upstreamMessage ?? 'سماد این درخواست را نپذیرفت. لطفاً یک‌بار دیگر امتحان کن.',
        { context: { status: response.status, url: url.toString() } },
      );
    }

    this.options.logger.debug({ path: request.path, status: response.status, durationMs }, 'Samad request completed');

    return payload as T;
  }

  /**
   * Parses a response body, tolerating the two shapes Samad produces on failure:
   * an HTML error page from the reverse proxy, and an empty body.
   */
  private parsePayload(rawText: string, url: URL): unknown {
    if (rawText.trim().length === 0) {
      return {};
    }

    try {
      return JSON.parse(rawText) as unknown;
    } catch (error) {
      throw new UpstreamUnavailableError({
        cause: error,
        context: { url: url.toString(), bodyPreview: rawText.slice(0, 200) },
      });
    }
  }
}
