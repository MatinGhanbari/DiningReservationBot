import { describe, expect, it } from 'vitest';
import { MAX_RESPONSE_BYTES, ResponseTooLargeError, readTextWithLimit, redactUrl } from '../src/shared/http';

/**
 * A response from a third party is untrusted data.
 *
 * Node's `fetch` buffers whatever the other side sends, so an upstream that is
 * compromised — or merely confused — can turn one request into an out-of-memory
 * kill. These tests assert that the cap holds and that the socket is released
 * rather than merely abandoned.
 */

/** A minimal stand-in for a `fetch` response body. */
function fakeResponse(chunks: readonly Uint8Array[]): Response {
  let index = 0;

  const body = {
    getReader: () => ({
      read: async () => {
        if (index >= chunks.length) {
          return { done: true, value: undefined };
        }
        const value = chunks[index];
        index += 1;
        return { done: false, value };
      },
      cancel: async () => undefined,
    }),
  };

  return { body } as unknown as Response;
}

const bytes = (text: string): Uint8Array => Buffer.from(text, 'utf8');

describe('readTextWithLimit', () => {
  it('returns the whole body when it fits', async () => {
    await expect(readTextWithLimit(fakeResponse([bytes('hello'), bytes(' world')]))).resolves.toBe('hello world');
  });

  it('refuses a body past the cap', async () => {
    const oversized = [bytes('x'.repeat(1024)), bytes('y'.repeat(1024))];

    await expect(readTextWithLimit(fakeResponse(oversized), 1024)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('reports the limit it enforced', async () => {
    const error = await readTextWithLimit(fakeResponse([bytes('x'.repeat(50))]), 10).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ResponseTooLargeError);
    expect((error as ResponseTooLargeError).limitBytes).toBe(10);
  });

  it('accepts a body exactly at the cap', async () => {
    await expect(readTextWithLimit(fakeResponse([bytes('x'.repeat(100))]), 100)).resolves.toHaveLength(100);
  });

  it('returns an empty string for a response with no body', async () => {
    await expect(readTextWithLimit({ body: null } as unknown as Response)).resolves.toBe('');
  });

  it('cancels the reader even when the cap is hit', async () => {
    let cancelled = false;

    const response = {
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: bytes('x'.repeat(2048)) }),
          cancel: async () => {
            cancelled = true;
          },
        }),
      },
    } as unknown as Response;

    await expect(readTextWithLimit(response, 10)).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(cancelled).toBe(true);
  });

  it('has a cap that is large enough for real payloads and small enough to be safe', () => {
    expect(MAX_RESPONSE_BYTES).toBeGreaterThan(256 * 1024);
    expect(MAX_RESPONSE_BYTES).toBeLessThan(32 * 1024 * 1024);
  });
});

describe('redactUrl', () => {
  it('keeps the origin and path', () => {
    expect(redactUrl(new URL('https://samad.example/api/v1/meals'))).toBe('https://samad.example/api/v1/meals');
  });

  it('replaces the query string, which is where credentials end up', () => {
    const url = new URL('https://samad.example/api/token?access_token=SECRET&grant_type=x');
    expect(redactUrl(url)).toBe('https://samad.example/api/token?<redacted>');
  });

  it('replaces numeric path segments, which are identifiers', () => {
    expect(redactUrl(new URL('https://samad.example/api/users/99887766/meals'))).toBe('https://samad.example/api/users/:id/meals');
  });

  it('never lets a secret reach the string', () => {
    const secret = 'SUPER_SECRET_VALUE';
    expect(redactUrl(new URL(`https://x.example/p?token=${secret}`))).not.toContain(secret);
  });
});
