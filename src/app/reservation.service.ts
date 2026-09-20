import type { MealOption, ReservationOutcome, ReservedMeal, Self, UserProfile, WeeklyReserves } from '../domain/models';
import type { Clock, SamadGateway, UserRepository } from '../domain/ports';
import { NotFoundError } from '../shared/errors';
import { addWeeks, startOfIranianWeek } from '../shared/dates';
import type { SessionService } from './session.service';

/** Which week the user asked to look at. */
export type WeekSelection = 'current' | 'next';

/**
 * Reading menus and booking meals.
 *
 * Every method takes the Telegram id and resolves the token internally, so no
 * caller can accidentally pass one user's token while acting on another's behalf.
 */
export class ReservationService {
  constructor(
    private readonly users: UserRepository,
    private readonly gateway: SamadGateway,
    private readonly sessionService: SessionService,
    private readonly clock: Clock,
  ) {}

  async listSelfs(telegramId: number): Promise<readonly Self[]> {
    return this.sessionService.withToken(telegramId, ({ accessToken, universityId }) => this.gateway.listSelfs(universityId, accessToken));
  }

  async listMealOptions(
    telegramId: number,
    selfId: number,
    week: WeekSelection,
    filter: { minimumDaysAhead?: number; includeReserved?: boolean } = {},
  ): Promise<readonly MealOption[]> {
    const weekStart = this.weekStartFor(week);

    return this.sessionService.withToken(telegramId, ({ accessToken, universityId }) =>
      this.gateway.listMealOptions({ universityId, accessToken, selfId, weekStart, ...filter }),
    );
  }

  /**
   * Today's meal at a given dining hall, or null when there is none.
   *
   * The forget-code flow needs this: a shared code is only useful if the person
   * receiving it actually has a meal today at that hall to spend it on.
   */
  async findTodaysProgram(telegramId: number, selfId: number): Promise<MealOption | null> {
    const options = await this.listMealOptions(telegramId, selfId, 'current', {
      minimumDaysAhead: 0,
      includeReserved: true,
    });

    return options.find(option => option.daysAhead === 0) ?? null;
  }

  async listReserves(telegramId: number, week: WeekSelection): Promise<WeeklyReserves> {
    const weekStart = this.weekStartFor(week);

    return this.sessionService.withToken(telegramId, ({ accessToken, universityId }) =>
      this.gateway.listReserves({ universityId, accessToken, weekStart }),
    );
  }

  async reserve(telegramId: number, programId: number, foodTypeId: number): Promise<ReservationOutcome> {
    return this.sessionService.withToken(telegramId, ({ accessToken, universityId }) =>
      this.gateway.reserve({ universityId, accessToken, programId, foodTypeId }),
    );
  }

  async getProfile(telegramId: number): Promise<UserProfile> {
    const user = await this.users.findByTelegramId(telegramId);

    if (user === null) {
      throw new NotFoundError('No linked account for this Telegram id', 'اول باید وارد حساب سمادت شوی.');
    }

    const profile = await this.sessionService.withToken(telegramId, ({ accessToken, universityId }) =>
      this.gateway.fetchProfile(universityId, accessToken),
    );

    // Prefer what Samad reports, but fall back to the stored name so the screen
    // still renders if the profile endpoint omits a field.
    return {
      ...profile,
      firstName: profile.firstName.length > 0 ? profile.firstName : user.firstName,
      lastName: profile.lastName ?? user.lastName,
      samadUsername: profile.samadUsername.length > 0 ? profile.samadUsername : user.samadUsername,
    };
  }

  /**
   * Finds a reserved meal by its reservation id.
   *
   * The bot only ever holds reservation ids inside callback data, so the meal
   * details have to be looked up again rather than trusted from the button.
   */
  async findReservedMeal(telegramId: number, reserveId: number): Promise<ReservedMeal> {
    const weeks: readonly WeekSelection[] = ['current', 'next'];

    for (const week of weeks) {
      const reserves = await this.listReserves(telegramId, week);
      const match = reserves.meals.find(meal => meal.reserveId === reserveId);

      if (match !== undefined) {
        return match;
      }
    }

    throw new NotFoundError(`Reservation ${reserveId} not found for this user`, 'این رزرو پیدا نشد. شاید لغو شده باشد.');
  }

  /** The Saturday that starts the requested week, or undefined for the current one. */
  private weekStartFor(week: WeekSelection): Date | undefined {
    if (week === 'current') {
      return undefined;
    }

    return addWeeks(startOfIranianWeek(this.clock.now()), 1);
  }
}
