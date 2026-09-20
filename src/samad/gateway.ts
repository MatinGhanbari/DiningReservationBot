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
import { LUNCH_MEAL_TYPE_ID } from '../domain/models';
import type { LoginInput, ProgramQuery, ReserveInput, ReservesQuery, SamadGateway } from '../domain/ports';
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
 * It is a public identifier baked into a shipped application, not a secret of
 * ours, which is why it lives in code rather than in configuration. It is named
 * here instead of inlined so that the next reader can see what it is.
 */
const SAMAD_MOBILE_BASIC_AUTH = `Basic ${Buffer.from('samad-mobile:samad-mobile-secret').toString('base64')}`;

/** Samad's own week-start format: `YYYY-MM-DD+HH:mm:ss`. */
export function formatSamadWeekStart(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');

  const datePart = [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-');
  const timePart = [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join(':');

  return `${datePart}+${timePart}`;
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
 * and its inconsistent null handling is contained in this class. Everything
 * above it works with `MealOption` and `ReservedMeal`.
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
      path: '/oauth/token',
      method: 'POST',
      extraHeaders: { authorization: SAMAD_MOBILE_BASIC_AUTH },
      formBody: {
        username: input.samadUsername,
        password: input.password,
        grant_type: 'password',
        scope: 'read write',
      },
      onUnauthorized: 'invalid-credentials',
    });

    if (typeof response.access_token !== 'string' || response.access_token.length === 0) {
      throw new UpstreamRejectedError(
        'Samad login succeeded but returned no access token',
        'سماد پاسخ نامعتبری داد. لطفاً یک‌بار دیگر امتحان کن.',
      );
    }

    // Samad reports lifetime in seconds. Falling back to an hour keeps a missing
    // field from producing a session that never expires.
    const expiresInSeconds = typeof response.expires_in === 'number' && response.expires_in > 0 ? response.expires_in : 3_600;

    return {
      accessToken: response.access_token,
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
      path: '/rest/selfs',
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
      path: '/rest/programs',
      method: 'GET',
      accessToken: query.accessToken,
      query: {
        selectedSelfId: query.selfId,
        weekStartDate: query.weekStart === undefined ? '' : formatSamadWeekStart(query.weekStart),
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
        typeof program.daysDifferenceWithToday !== 'number'
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
      path: '/rest/reserves',
      method: 'GET',
      accessToken: query.accessToken,
      query: {
        weekStartDate: query.weekStart === undefined ? '' : formatSamadWeekStart(query.weekStart),
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
      path: `/rest/reserves/${input.programId}/reserve`,
      method: 'PUT',
      accessToken: input.accessToken,
      jsonBody: {
        foodTypeId: input.foodTypeId,
        freeFoodSelected: false,
        mealTypeId: LUNCH_MEAL_TYPE_ID,
        selected: true,
        selectedCount: 1,
      },
      // Never repeated automatically: the reservation may have succeeded even if
      // the response was lost, and a retry would book the meal a second time.
      allowRetry: false,
    });

    const succeeded = (response.type ?? '').toUpperCase() === 'SUCCESS';

    return {
      succeeded,
      message: cleanText(response.messageFa, succeeded ? 'رزرو انجام شد.' : 'سماد این رزرو را نپذیرفت.'),
    };
  }

  async fetchProfile(universityId: number, accessToken: string): Promise<UserProfile> {
    const response = await this.http.request<SamadProfileResponse>({
      universityId,
      path: '/rest/users/nurture-profiles',
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
    const response = await this.http.request<SamadForgetCodeResponse>({
      universityId,
      path: '/rest/forget-card-codes/print',
      method: 'GET',
      accessToken,
      query: { reserveId, count: 1 },
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
