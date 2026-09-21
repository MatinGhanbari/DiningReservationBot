import { describe, expect, it, vi } from 'vitest';
import { samadSettings } from '../src/config/appsettings';
import { InvalidCredentialsError, SessionExpiredError, UpstreamRejectedError } from '../src/shared/errors';
import { SamadHttpClient } from '../src/samad/client';
import { SamadApiGateway, formatSamadWeekStart } from '../src/samad/gateway';

/** A logger that records nothing; the client only needs the interface. */
const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
} as never;

function createClient(maxRetries = 2): SamadHttpClient {
  return new SamadHttpClient({ timeoutMs: 1_000, maxRetries, logger: silentLogger, verifyTls: true });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('SamadHttpClient', () => {
  it('returns the parsed body on success', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ payload: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createClient().request<{ payload: unknown[] }>({
      universityId: 8,
      path: '/rest/reservations/selfs',
      method: 'GET',
    });

    expect(result.payload).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('treats 401 as an expired session by default', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, 401)),
    );

    await expect(
      createClient().request({ universityId: 8, path: '/rest/reservations/selfs', method: 'GET', accessToken: 'x' }),
    ).rejects.toBeInstanceOf(SessionExpiredError);

    vi.unstubAllGlobals();
  });

  it('passes no custom dispatcher when TLS verification is enabled', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: { dispatcher?: unknown }) => jsonResponse({ payload: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await createClient().request({ universityId: 8, path: '/rest/reservations/selfs', method: 'GET' });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.dispatcher).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it('passes an insecure dispatcher when TLS verification is disabled', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: { dispatcher?: unknown }) => jsonResponse({ payload: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await new SamadHttpClient({ timeoutMs: 1_000, maxRetries: 2, logger: silentLogger, verifyTls: false }).request({
      universityId: 8,
      path: '/rest/reservations/selfs',
      method: 'GET',
    });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.dispatcher).toBeDefined();

    vi.unstubAllGlobals();
  });

  it('treats 401 on the token endpoint as wrong credentials, not an expired session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, 401)),
    );

    // The distinction matters: one message tells the user to log in again, the
    // other tells them the password they just typed was wrong.
    await expect(
      createClient().request({
        universityId: 8,
        path: '/oauth/token',
        method: 'POST',
        onUnauthorized: 'invalid-credentials',
      }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    vi.unstubAllGlobals();
  });

  it('retries a GET that fails with a server error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ payload: 'ok' }));

    vi.stubGlobal('fetch', fetchMock);

    const result = await createClient().request<{ payload: string }>({
      universityId: 8,
      path: '/rest/reservations/selfs',
      method: 'GET',
    });

    expect(result.payload).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('never repeats a reservation, even when the response was lost', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('socket hang up');
    });

    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createClient().request({
        universityId: 8,
        path: '/rest/reserves/1/reserve',
        method: 'PUT',
        accessToken: 'x',
        jsonBody: {},
      }),
    ).rejects.toThrow();

    // A retried PUT could book the same meal twice and charge the user for both.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('surfaces a non-JSON error page as an unavailable upstream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 200 })),
    );

    await expect(createClient(0).request({ universityId: 8, path: '/rest/reservations/selfs', method: 'GET' })).rejects.toThrow();

    vi.unstubAllGlobals();
  });

  it('rejects an unsupported university before making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(createClient(0).request({ universityId: 999, path: '/rest/reservations/selfs', method: 'GET' })).rejects.toBeInstanceOf(
      UpstreamRejectedError,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('SamadApiGateway', () => {
  const request = vi.fn();
  const gateway = new SamadApiGateway({ request } as never);

  it('formats a week start the way Samad expects', () => {
    expect(formatSamadWeekStart(new Date(2026, 8, 19, 0, 0, 0))).toBe('2026-09-19+00:00:00');
  });

  it('keeps only dining halls that carry an id', async () => {
    request.mockResolvedValueOnce({
      payload: [{ id: 5, name: 'سلف مرکزی' }, { name: 'بدون شناسه' }, { id: 6, name: 'سلف دانشکده' }],
    });

    const selfs = await gateway.listSelfs(8, 'token');

    expect(selfs.map(self => self.id)).toEqual([5, 6]);
  });

  it('flattens the day-nested program structure', async () => {
    request.mockResolvedValueOnce({
      payload: {
        selfWeekPrograms: [
          [
            {
              programId: 1,
              selfId: 5,
              mealTypeId: 2,
              daysDifferenceWithToday: 3,
              date: '2026-09-22T00:00:00Z',
              programFoodTypes: [{ foodTypeId: 10, foodNames: 'چلوکباب', price: 120_000 }],
            },
          ],
          [
            {
              programId: 2,
              selfId: 5,
              mealTypeId: 2,
              daysDifferenceWithToday: 4,
              date: '2026-09-23T00:00:00Z',
              programFoodTypes: [{ foodTypeId: 11, foodNames: 'قیمه', price: 90_000 }],
            },
          ],
        ],
        userWeekReserves: [],
      },
    });

    const meals = await gateway.listMealOptions({ universityId: 8, accessToken: 't', selfId: 5 });

    expect(meals).toHaveLength(2);
    expect(meals[0]?.foodName).toBe('چلوکباب');
  });

  it('hides meals Samad still locks', async () => {
    request.mockResolvedValueOnce({
      payload: {
        selfWeekPrograms: [
          [
            {
              programId: 1,
              selfId: 5,
              mealTypeId: 2,
              daysDifferenceWithToday: 2,
              date: '2026-09-21T00:00:00Z',
              programFoodTypes: [{ foodTypeId: 10, foodNames: 'زود', price: 1 }],
            },
            {
              programId: 2,
              selfId: 5,
              mealTypeId: 2,
              daysDifferenceWithToday: 3,
              date: '2026-09-22T00:00:00Z',
              programFoodTypes: [{ foodTypeId: 11, foodNames: 'دیر', price: 1 }],
            },
          ],
        ],
        userWeekReserves: [],
      },
    });

    const meals = await gateway.listMealOptions({ universityId: 8, accessToken: 't', selfId: 5 });

    // The boundary is inclusive: exactly RESERVABLE_DAYS_AHEAD is bookable, one
    // day closer is not.
    expect(meals.map(meal => meal.foodName)).toEqual(['دیر']);
  });

  it('hides meals the user has already reserved', async () => {
    request.mockResolvedValueOnce({
      payload: {
        selfWeekPrograms: [
          [
            {
              programId: 1,
              selfId: 5,
              mealTypeId: 2,
              daysDifferenceWithToday: 3,
              date: '2026-09-23T00:00:00Z',
              programFoodTypes: [{ foodTypeId: 10, foodNames: 'رزروشده', price: 1 }],
            },
            {
              programId: 2,
              selfId: 5,
              mealTypeId: 2,
              daysDifferenceWithToday: 3,
              date: '2026-09-23T00:00:00Z',
              programFoodTypes: [{ foodTypeId: 11, foodNames: 'آزاد', price: 1 }],
            },
          ],
        ],
        userWeekReserves: [{ programId: 1 }],
      },
    });

    const meals = await gateway.listMealOptions({ universityId: 8, accessToken: 't', selfId: 5 });

    expect(meals.map(meal => meal.foodName)).toEqual(['آزاد']);
  });

  it('includes today when the caller asks for it', async () => {
    request.mockResolvedValueOnce({
      payload: {
        selfWeekPrograms: [
          [
            {
              programId: 1,
              selfId: 5,
              mealTypeId: 2,
              daysDifferenceWithToday: 0,
              date: '2026-09-20T00:00:00Z',
              programFoodTypes: [{ foodTypeId: 10, foodNames: 'امروز', price: 1 }],
            },
          ],
        ],
        userWeekReserves: [{ programId: 1 }],
      },
    });

    const meals = await gateway.listMealOptions({
      universityId: 8,
      accessToken: 't',
      selfId: 5,
      minimumDaysAhead: 0,
      includeReserved: true,
    });

    expect(meals).toHaveLength(1);
    expect(meals[0]?.daysAhead).toBe(0);
  });

  it('skips a program with no food types', async () => {
    request.mockResolvedValueOnce({
      payload: {
        selfWeekPrograms: [
          [{ programId: 1, selfId: 5, mealTypeId: 2, daysDifferenceWithToday: 3, date: '2026-09-23T00:00:00Z', programFoodTypes: [] }],
        ],
        userWeekReserves: [],
      },
    });

    expect(await gateway.listMealOptions({ universityId: 8, accessToken: 't', selfId: 5 })).toEqual([]);
  });

  it('skips a program with no meal type, which could not be booked correctly', async () => {
    request.mockResolvedValueOnce({
      payload: {
        selfWeekPrograms: [
          [
            {
              programId: 1,
              selfId: 5,
              daysDifferenceWithToday: 3,
              date: '2026-09-23T00:00:00Z',
              programFoodTypes: [{ foodTypeId: 10, foodNames: 'بدون وعده', price: 1 }],
            },
          ],
        ],
        userWeekReserves: [],
      },
    });

    expect(await gateway.listMealOptions({ universityId: 8, accessToken: 't', selfId: 5 })).toEqual([]);
  });

  it('flattens reservations across days and meal types', async () => {
    request.mockResolvedValueOnce({
      payload: {
        weekDays: [
          {
            dayTranslated: 'سه‌شنبه',
            date: '2026-09-22T00:00:00Z',
            mealTypes: [
              {
                name: 'ناهار',
                reserve: {
                  id: 101,
                  programId: 1,
                  selfId: 5,
                  selfCodeName: 'سلف مرکزی',
                  foodNames: 'چلوکباب',
                  programDate: '2026-09-22T00:00:00Z',
                  remainedCount: 1,
                },
              },
            ],
          },
          {
            dayTranslated: 'چهارشنبه',
            date: '2026-09-23T00:00:00Z',
            mealTypes: [
              {
                name: 'ناهار',
                reserve: {
                  id: 102,
                  programId: 2,
                  selfId: 5,
                  selfCodeName: 'سلف مرکزی',
                  foodNames: 'قیمه',
                  programDate: '2026-09-23T00:00:00Z',
                  remainedCount: 1,
                },
              },
            ],
          },
        ],
        remainCredit: 250_000,
      },
    });

    const reserves = await gateway.listReserves({ universityId: 8, accessToken: 't' });

    expect(reserves.meals).toHaveLength(2);
    expect(reserves.remainingCreditRial).toBe(250_000);
  });

  it('drops reservations that can no longer be transferred', async () => {
    request.mockResolvedValueOnce({
      payload: {
        weekDays: [
          {
            dayTranslated: 'سه‌شنبه',
            date: '2026-09-22T00:00:00Z',
            mealTypes: [
              {
                name: 'ناهار',
                reserve: { id: 101, programId: 1, selfId: 5, foodNames: 'تمام‌شده', programDate: '2026-09-22T00:00:00Z', remainedCount: 0 },
              },
            ],
          },
        ],
      },
    });

    const reserves = await gateway.listReserves({ universityId: 8, accessToken: 't' });

    expect(reserves.meals).toEqual([]);
  });

  it('reports a successful reservation', async () => {
    request.mockResolvedValueOnce({ type: 'SUCCESS', messageFa: 'رزرو انجام شد.' });

    const outcome = await gateway.reserve({ universityId: 8, accessToken: 't', programId: 1, foodTypeId: 10, mealTypeId: 2 });

    expect(outcome.succeeded).toBe(true);
    expect(outcome.message).toBe('رزرو انجام شد.');
  });

  it('treats a created reservation id as success when the envelope has no type', async () => {
    request.mockResolvedValueOnce({ payload: { id: 55_231 } });

    const outcome = await gateway.reserve({ universityId: 8, accessToken: 't', programId: 1, foodTypeId: 10, mealTypeId: 2 });

    expect(outcome.succeeded).toBe(true);
  });

  it('echoes the program meal type rather than assuming lunch', async () => {
    request.mockResolvedValueOnce({ type: 'SUCCESS' });

    await gateway.reserve({ universityId: 8, accessToken: 't', programId: 77, foodTypeId: 10, mealTypeId: 3 });

    const sent = request.mock.calls.at(-1)?.[0] as { path: string; jsonBody: { mealTypeId: number } };

    expect(sent.path).toBe('/rest/reserves/77/reserve');
    expect(sent.jsonBody.mealTypeId).toBe(3);
  });

  it('reports a rejected reservation with the upstream explanation', async () => {
    request.mockResolvedValueOnce({ type: 'ERROR', messageFa: 'موجودی کافی نیست.' });

    const outcome = await gateway.reserve({ universityId: 8, accessToken: 't', programId: 1, foodTypeId: 10, mealTypeId: 2 });

    expect(outcome.succeeded).toBe(false);
    expect(outcome.message).toBe('موجودی کافی نیست.');
  });

  it('refuses a login response with no token', async () => {
    request.mockResolvedValueOnce({ first_name: 'مهدی' });

    await expect(gateway.login({ universityId: 8, samadUsername: 'u', password: 'p' })).rejects.toBeInstanceOf(UpstreamRejectedError);
  });

  it('derives the session expiry from the token lifetime', async () => {
    request.mockResolvedValueOnce({ access_token: 'tok', expires_in: 1_800, first_name: 'مهدی' });

    const session = await gateway.login({ universityId: 8, samadUsername: 'u', password: 'p' });

    expect(session.accessToken).toBe('tok');
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('repairs the wrong Arabic letter forms in upstream text', async () => {
    request.mockResolvedValueOnce({ payload: { user: { firstName: 'علي', username: 'u' }, credit: 1 } });

    const profile = await gateway.fetchProfile(8, 't');

    expect(profile.firstName).toBe('علی');
  });

  it('reads the card code field, not the unrelated forgetCode field', async () => {
    request.mockResolvedValueOnce({
      payload: { forgotCardCode: 'REAL-CODE', self: 'سلف مرکزی', foodName: 'چلوکباب', remainCount: 1 },
    });

    const issued = await gateway.issueForgetCode(8, 't', 101, new Date('2026-09-22T00:00:00Z'));

    expect(issued.code).toBe('REAL-CODE');
  });

  it('refuses an empty forget code rather than pooling it', async () => {
    request.mockResolvedValueOnce({ payload: { forgotCardCode: '   ', remainCount: 1 } });

    await expect(gateway.issueForgetCode(8, 't', 101, new Date())).rejects.toBeInstanceOf(UpstreamRejectedError);
  });

  it('prints a card code from the captured path, with dailySale stated', async () => {
    request.mockResolvedValueOnce({ payload: { forgotCardCode: 'REAL-CODE', remainCount: 1 } });

    await gateway.issueForgetCode(8, 't', 15_259_528, new Date('2026-09-22T00:00:00Z'));

    const sent = request.mock.calls.at(-1)?.[0] as { path: string; query: Record<string, unknown> };

    // The path is the one the web client uses. It is not nested under
    // /rest/reservations, which is where the bot used to look.
    expect(sent.path).toBe('/rest/forget-card-codes/print');
    expect(sent.query).toEqual({ reserveId: 15_259_528, count: 1, dailySale: 'false' });
  });

  it('sends the captured mobile credential on the token request', async () => {
    request.mockResolvedValueOnce({ access_token: 'tok', expires_in: 3_600 });

    await gateway.login({ universityId: 8, samadUsername: 'u', password: 'p' });

    const sent = request.mock.calls.at(-1)?.[0] as { path: string; extraHeaders: Record<string, string>; formBody: Record<string, string> };

    expect(sent.path).toBe('/oauth/token');

    // The credential itself is deliberately not written out here. A tracked file
    // must not carry it, and it has exactly one home — `appsettings.json`, or an
    // override of it. What this asserts is the behaviour that matters: the
    // gateway sends the configured client credential, not one of its own.
    expect(sent.extraHeaders.authorization).toBe(samadSettings.client.basicAuth);
    expect(sent.extraHeaders.authorization).toMatch(/^Basic [A-Za-z0-9+/=]+$/);

    expect(sent.formBody).toMatchObject({ grant_type: 'password', scope: 'read write' });
  });
});
