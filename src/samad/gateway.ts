import type {
  IssuedForgetCode,
  MealOption,
  ReservationOutcome,
  ReservedMeal,
  SamadSession,
  Self,
  UserProfile,
  WeeklyReserves,
} from '../domain/models';
import type { LoginInput, ProgramQuery, RefreshInput, ReserveInput, ReservesQuery, SamadGateway } from '../domain/ports';
import { samadRoute, samadSettings } from '../config/appsettings';
import { config } from '../config/env';
import { toMealDateKey } from '../shared/dates';
import { RESERVABLE_DAYS_AHEAD } from '../shared/time';
import { normalizePersianText } from '../shared/persian';
import { UpstreamRejectedError } from '../shared/errors';
import type { SamadHttpClient } from './client';
import type {
  SamadForgetCodeResponse,
  SamadProgramsResponse,
  SamadProfileResponse,
  SamadReserveResponse,
  SamadReservesResponse,
  SamadSelfListResponse,
  SamadSelfProgram,
  SamadTokenResponse,
} from './types';

/**
 * The client credential the Samad mobile app itself uses.
 *
 * It is the mobile app's own identifier, but it is still a credential: the one
 * that was captured once already ended up in this repository's history, where it
 * cannot be deleted, only rotated. So the environment wins and `appsettings.json`
 * keeps only the shape of the value.
 *
 * Empty `SAMAD_BASIC_AUTH` therefore means the placeholder from the settings
 * file is sent and Samad answers `401`. That is intentional: a deployment that
 * never configured the credential should fail visibly, not run on a value that
 * every reader of this repository knows.
 */
const SAMAD_MOBILE_BASIC_AUTH = config.SAMAD_BASIC_AUTH.trim() || samadSettings.client.basicAuth;

/**
 * The self type the web and mobile clients always send on the reserves endpoint.
 * Omitting it makes Samad return an empty week instead of the user's reserves.
 */
const SAMAD_SELF_TYPE = samadSettings.client.selfType;

/**
 * Samad's own week-start format: `YYYY-MM-DD HH:mm:ss`.
 *
 * A week start is a calendar day, so the time is always midnight and only the
 * date carries meaning. The date is read in the configured timezone rather than
 * in the process's own zone: a container running in UTC would otherwise render
 * Tehran's Saturday as the Friday before it, and Samad would answer about the
 * wrong week.
 *
 * The separator is a space, and it has to be a space rather than a `+`.
 *
 * The captured client shows a bare `+` in the query string, but a bare `+` in a
 * query string is form-encoding for a space: the servlet container decodes it
 * back to a space before Samad's own parser ever sees the value. Writing a
 * literal `+` here and letting `URLSearchParams` escape it to `%2B` delivers a
 * plus character instead, which is a different value.
 *
 * An *empty* value is not the same as an absent one: Samad parses this parameter
 * as a date and answers `400` to `weekStartDate=`, which is why every caller
 * names the week it wants instead of leaving the field out.
 */
export function formatSamadWeekStart(date: Date): string {
  return `${toMealDateKey(date)} 00:00:00`;
}

/** Parses a date, returning null instead of an Invalid Date. */
function parseDate(value: string | undefined): Date | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Trims and repairs upstream text, falling back to a placeholder. */
function cleanText(value: string | undefined, fallback = ''): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalised = normalizePersianText(value);
  return normalised.length > 0 ? normalised : fallback;
}

/**
 * Adapts Samad's HTTP API to the domain.
 *
 * All knowledge of Samad's field names, its array-of-arrays program structure,
 * and its inconsistent null handling is contained in this class. Every URL it
 * calls is named in `appsettings.json` rather than written here.
 */
export class SamadApiGateway implements SamadGateway {
  /**
   * @param reservableDaysAhead Overrides the global reservation window. The
   *   gateway takes it as a constructor argument rather than reading
   *   configuration itself, so a test can exercise both sides of the boundary
   *   without touching the environment.
   */
  constructor(
    private readonly http: SamadHttpClient,
    private readonly reservableDaysAhead: number = RESERVABLE_DAYS_AHEAD,
  ) {}

  async login(input: LoginInput): Promise<SamadSession> {
    const response = await this.http.request<SamadTokenResponse>({
      universityId: input.universityId,
      path: samadRoute('login'),
      method: 'POST',
      extraHeaders: { authorization: SAMAD_MOBILE_BASIC_AUTH },
      formBody: {
        username: input.samadUsername,
        password: input.password,
        grant_type: samadSettings.client.grantType,
        scope: samadSettings.client.scope,
      },
      onUnauthorized: 'invalid-credentials',
    });

    return this.toSession(response, input);
  }

  /**
   * Trades the stored refresh token for a new access token.
   *
   * This is what replaced the stored password: the password is asked for once,
   * and every renewal after that uses the token Samad itself issued.
   *
   * The body mirrors the captured web client exactly, which is how this call was
   * verified: on a `401` from any endpoint but the token endpoint, that client
   * posts `grant_type=refresh_token&refresh_token=…` with the same Basic
   * credential and nothing else. No `scope` — the grant reuses the scope of the
   * token being renewed.
   *
   * A rejected refresh token is a dead end by design, so the `401` stays a
   * session-expired error here rather than being reported as a wrong password.
   */
  async refresh(input: RefreshInput): Promise<SamadSession> {
    const response = await this.http.request<SamadTokenResponse>({
      universityId: input.universityId,
      path: samadRoute('login'),
      method: 'POST',
      extraHeaders: { authorization: SAMAD_MOBILE_BASIC_AUTH },
      formBody: {
        grant_type: samadSettings.client.refreshGrantType,
        refresh_token: input.refreshToken,
      },
    });

    return this.toSession(response, input);
  }

  /**
   * Maps a token-endpoint response onto a session.
   *
   * Shared by both grants because they answer in the same shape, and because a
   * missing `access_token` means the same thing either way.
   */
  private toSession(response: SamadTokenResponse, input: { universityId: number; samadUsername: string }): SamadSession {
    if (typeof response.access_token !== 'string' || response.access_token.length === 0) {
      throw new UpstreamRejectedError('Samad returned no access token', 'سماد پاسخ نامعتبری داد. لطفاً یک‌بار دیگر امتحان کن.');
    }

    // Samad reports lifetime in seconds. Falling back to an hour keeps a missing
    // field from producing a session that never expires.
    const expiresInSeconds = typeof response.expires_in === 'number' && response.expires_in > 0 ? response.expires_in : 3_600;

    return {
      accessToken: response.access_token,
      // Kept when Samad issues one and null otherwise: the caller has to know
      // whether a renewal is possible at all.
      refreshToken: typeof response.refresh_token === 'string' && response.refresh_token.length > 0 ? response.refresh_token : null,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1_000),
      firstName: cleanText(response.first_name, 'دانشجو'),
      lastName: typeof response.last_name === 'string' ? cleanText(response.last_name) : null,
      samadUsername: input.samadUsername,
      universityId: input.universityId,
    };
  }

  async listSelfs(universityId: number, accessToken: string): Promise<readonly Self[]> {
    const response = await this.http.request<SamadSelfListResponse>({
      universityId,
      path: samadRoute('selfs'),
      method: 'GET',
      accessToken,
    });

    const payload = Array.isArray(response.payload) ? response.payload : [];

    return payload
      .filter((entry): entry is { id: number; name?: string } => typeof entry.id === 'number')
      .map(entry => ({
        id: entry.id,
        name: cleanText(entry.name, `سلف ${entry.id}`),
      }));
  }

  async listMealOptions(query: ProgramQuery): Promise<readonly MealOption[]> {
    const response = await this.http.request<SamadProgramsResponse>({
      universityId: query.universityId,
      path: samadRoute('programs'),
      method: 'GET',
      accessToken: query.accessToken,
      query: {
        selfId: query.selfId,
        weekStartDate: formatSamadWeekStart(query.weekStart),
      },
    });

    const programs = response.payload?.selfWeekPrograms ?? [];

    // Samad nests one array per day. Flattening first keeps the filter readable.
    const flat: SamadSelfProgram[] = programs.flat();

    const alreadyReservedProgramIds = new Set(
      (response.payload?.userWeekReserves ?? [])
        .map(reserve => reserve.programId)
        .filter((programId): programId is number => typeof programId === 'number'),
    );

    const options: MealOption[] = [];

    const minimumDaysAhead = query.minimumDaysAhead ?? this.reservableDaysAhead;
    const includeReserved = query.includeReserved ?? false;

    for (const program of flat) {
      if (
        typeof program.programId !== 'number' ||
        typeof program.selfId !== 'number' ||
        typeof program.daysDifferenceWithToday !== 'number' ||
        // The reserve call echoes the program's own meal type back to Samad, so a
        // program without one could only ever be booked with a guessed value.
        typeof program.mealTypeId !== 'number'
      ) {
        continue;
      }

      // Samad still locks meals that are too close, so offering them would only
      // produce a rejection the user cannot act on.
      if (program.daysDifferenceWithToday < minimumDaysAhead) {
        continue;
      }

      if (!includeReserved && alreadyReservedProgramIds.has(program.programId)) {
        continue;
      }

      const foodType = program.programFoodTypes?.[0];
      if (foodType === undefined || typeof foodType.foodTypeId !== 'number') {
        continue;
      }

      const servedAt = parseDate(program.date);
      if (servedAt === null) {
        continue;
      }

      options.push({
        programId: program.programId,
        foodTypeId: foodType.foodTypeId,
        mealTypeId: program.mealTypeId,
        selfId: program.selfId,
        foodName: cleanText(foodType.foodNames, 'غذا'),
        mealTypeName: cleanText(program.mealTypeName, 'وعدهٔ غذایی'),
        priceRial: typeof foodType.price === 'number' ? foodType.price : 0,
        servedAt,
        weekdayName: cleanText(program.dayTranslated),
        daysAhead: program.daysDifferenceWithToday,
      });
    }

    return options;
  }

  async listReserves(query: ReservesQuery): Promise<WeeklyReserves> {
    const response = await this.http.request<SamadReservesResponse>({
      universityId: query.universityId,
      path: samadRoute('reserves'),
      method: 'GET',
      accessToken: query.accessToken,
      query: {
        weekStartDate: formatSamadWeekStart(query.weekStart),
        selfType: SAMAD_SELF_TYPE,
      },
    });

    const weekDays = response.payload?.weekDays ?? [];
    const meals: ReservedMeal[] = [];

    for (const day of weekDays) {
      for (const mealType of day.mealTypes ?? []) {
        const reserve = mealType.reserve;

        if (reserve === undefined || typeof reserve.id !== 'number' || typeof reserve.programId !== 'number') {
          continue;
        }

        // A meal with nothing left to transfer cannot produce a forget code.
        if (typeof reserve.remainedCount === 'number' && reserve.remainedCount <= 0) {
          continue;
        }

        const servedAt = parseDate(reserve.programDate) ?? parseDate(day.date);
        if (servedAt === null) {
          continue;
        }

        meals.push({
          reserveId: reserve.id,
          programId: reserve.programId,
          selfId: typeof reserve.selfId === 'number' ? reserve.selfId : 0,
          selfName: cleanText(reserve.selfCodeName, 'سلف'),
          foodName: cleanText(reserve.foodNames, 'غذا'),
          mealTypeName: cleanText(mealType.name, 'وعدهٔ غذایی'),
          servedAt,
          weekdayName: cleanText(day.dayTranslated),
          transferableCount: typeof reserve.remainedCount === 'number' ? reserve.remainedCount : 0,
        });
      }
    }

    const firstDay = weekDays.find(day => parseDate(day.date) !== null);

    return {
      meals,
      remainingCreditRial: response.payload?.remainCredit ?? 0,
      weekStart: (firstDay === undefined ? null : parseDate(firstDay.date)) ?? new Date(),
    };
  }

  async reserve(input: ReserveInput): Promise<ReservationOutcome> {
    const response = await this.http.request<SamadReserveResponse>({
      universityId: input.universityId,
      path: samadRoute('reserve', { programId: input.programId }),
      method: 'PUT',
      accessToken: input.accessToken,
      // Mirrors the web client's `reserve` payload exactly. `mealTypeId` is the
      // one the program itself reported, not a fixed meal: sending lunch's id for
      // a dinner program is a request Samad rejects.
      jsonBody: {
        foodTypeId: input.foodTypeId,
        freeFoodSelected: false,
        mealTypeId: input.mealTypeId,
        selected: true,
        selectedCount: 1,
      },
      // Never repeated automatically: the reservation may have succeeded even if
      // the response was lost, and a retry would book the meal a second time.
      allowRetry: false,
    });

    // Samad signals the outcome two ways depending on the deployment: an envelope
    // `type` of `SUCCESS`, and a created reservation id in the payload. Either is
    // a success; requiring both would report a real reservation as a failure.
    const succeeded = (response.type ?? '').toUpperCase() === 'SUCCESS' || typeof response.payload?.id === 'number';

    return {
      succeeded,
      message: cleanText(response.messageFa, succeeded ? 'رزرو انجام شد.' : 'سماد این رزرو را نپذیرفت.'),
    };
  }

  async fetchProfile(universityId: number, accessToken: string): Promise<UserProfile> {
    const response = await this.http.request<SamadProfileResponse>({
      universityId,
      path: samadRoute('profile'),
      method: 'GET',
      accessToken,
    });

    return {
      firstName: cleanText(response.payload?.user?.firstName, 'دانشجو'),
      lastName: typeof response.payload?.user?.lastName === 'string' ? cleanText(response.payload.user.lastName) : null,
      samadUsername: cleanText(response.payload?.user?.username),
      universityId,
      creditRial: typeof response.payload?.credit === 'number' ? response.payload.credit : 0,
    };
  }

  async issueForgetCode(universityId: number, accessToken: string, reserveId: number, mealDate: Date): Promise<IssuedForgetCode> {
    // The university id is used rather than a hard-coded host: the original code
    // always called the KNTU deployment, so students elsewhere got codes that
    // belonged to a different university's database.
    //
    // `dailySale` is not optional in the captured client and defaults to false
    // here: it selects the daily-sale variant of the same endpoint, and omitting
    // it makes Samad answer about a reservation that does not exist.
    const response = await this.http.request<SamadForgetCodeResponse>({
      universityId,
      path: samadRoute('forgetCardCode'),
      method: 'GET',
      accessToken,
      query: { reserveId, count: 1, dailySale: 'false' },
    });

    const payload = response.payload;

    if (payload === undefined) {
      throw new UpstreamRejectedError(
        'Samad returned no payload for the forget code request',
        'سماد کد فراموشی برنگرداند. لطفاً یک‌بار دیگر امتحان کن.',
      );
    }

    const code = typeof payload.forgotCardCode === 'string' ? payload.forgotCardCode.trim() : '';

    if (code.length === 0) {
      throw new UpstreamRejectedError('Samad returned an empty forget code', 'سماد کد خالی برگرداند. لطفاً یک‌بار دیگر امتحان کن.');
    }

    return {
      code,
      selfName: cleanText(payload.self, 'سلف'),
      foodName: cleanText(payload.foodName, 'غذا'),
      mealDate,
      remainingCount: typeof payload.remainCount === 'number' ? payload.remainCount : 1,
    };
  }
}
