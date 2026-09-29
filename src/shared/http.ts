/**
 * How many bytes an upstream may send before we stop reading.
 *
 * Node's `fetch` will happily buffer whatever the other side streams, and an
 * upstream that is compromised, or merely broken, can turn that into an
 * out-of-memory kill of the whole bot. Every response from a third party is
 * therefore read through this limit.
 *
 * The cap is generous for the payloads these APIs actually return — a week of
 * meals is a few tens of kilobytes — and small enough that even a hostile
 * response costs nothing.
 */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class ResponseTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`Upstream response exceeded ${limitBytes} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

/**
 * Reads a response body as text, refusing anything past the byte cap.
 *
 * The reader is cancelled rather than merely ignored: without `cancel()` the
 * socket stays open and the remaining bytes keep arriving, so the memory this is
 * meant to protect is still consumed.
 */
export async function readTextWithLimit(response: Response, limitBytes = MAX_RESPONSE_BYTES): Promise<string> {
  const body = response.body;

  if (body === null) {
    return '';
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      received += value.byteLength;

      if (received > limitBytes) {
        throw new ResponseTooLargeError(limitBytes);
      }

      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return Buffer.concat(chunks).toString('utf8');
}

/**
 * A URL safe to write to a log.
 *
 * Query strings are where credentials end up — a token passed as a parameter, a
 * signed link, a session id — and a log line is the one place a secret is
 * guaranteed to be retained and shipped somewhere else. Only the origin and path
 * are kept; the query is replaced with a marker so its presence is still visible.
 */
export function redactUrl(url: URL): string {
  const path = url.pathname.replace(/\/\d+(?=\/|$)/g, '/:id');
  return url.search.length > 0 ? `${url.origin}${path}?<redacted>` : `${url.origin}${path}`;
}
