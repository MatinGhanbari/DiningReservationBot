import type { ForgetCode, IssuedForgetCode } from '../domain/models';
import type { Clock, ForgetCodeReportRepository, ForgetCodeRepository, SamadGateway, UserRepository } from '../domain/ports';
import { NotFoundError, UpstreamRejectedError } from '../shared/errors';
import { toMealDateKey, todayKey } from '../shared/dates';
import { scopedLogger } from '../shared/logger';
import type { ReservationService } from './reservation.service';
import type { SessionService } from './session.service';

const log = scopedLogger('forget-code');

export type ShareOutcome = { kind: 'shared'; issued: IssuedForgetCode } | { kind: 'already-shared'; issued: IssuedForgetCode };

/**
 * The community pool of forget codes.
 *
 * A student who has lost their card can use someone else's code, but only if
 * that someone gives up the meal. The pool exists so this can happen without
 * either of them being in the same room — and it is why codes are single-use.
 *
 * This class also repairs the two defects that made the feature non-functional:
 *
 *   1. The duplicate check was written as `if (this.forgetCodes.findOne(...))`
 *      with no `await`. A pending Promise is always truthy, so the condition was
 *      always true and *every* share attempt threw "this code is already used".
 *      Uniqueness is now enforced by a database constraint and the insert reports
 *      whether it actually happened.
 *   2. The code was always printed from the KNTU deployment's host, so students
 *      at the other three universities received codes from a database that did
 *      not contain their reservation. The university now comes from the user.
 */
export class ForgetCodeService {
  constructor(
    private readonly codes: ForgetCodeRepository,
    private readonly reports: ForgetCodeReportRepository,
    private readonly users: UserRepository,
    private readonly reservations: ReservationService,
    private readonly gateway: SamadGateway,
    private readonly sessionService: SessionService,
    private readonly clock: Clock,
  ) {}

  /**
   * Prints a fresh code for one of the user's own reserved meals and adds it to
   * the pool.
   *
   * The user is asked to confirm first, in the UI: sharing a code means giving up
   * that meal, and that is not something to do on a single mis-tap.
   */
  async share(telegramId: number, reserveId: number): Promise<ShareOutcome> {
    const user = await this.users.findByTelegramId(telegramId);

    if (user === null) {
      throw new NotFoundError('No linked account', 'اول باید وارد حساب سمادت شوی.');
    }

    const meal = await this.reservations.findReservedMeal(telegramId, reserveId);

    // The university comes from the stored account, not from the cached session.
    // The two normally agree, but the database is the source of truth: a stale or
    // mismatched session must never send the request to another university's host.
    const issued = await this.sessionService.withToken(telegramId, ({ accessToken }) =>
      this.gateway.issueForgetCode(user.universityId, accessToken, reserveId, meal.servedAt),
    );

    if (issued.remainingCount <= 0) {
      throw new UpstreamRejectedError(
        `Forget code for reserve ${reserveId} has no transfers left`,
        'این غذا دیگر قابل انتقال نیست، چون تعداد دفعات مجازش تمام شده.',
      );
    }

    const inserted = await this.codes.insert({
      code: issued.code,
      mealDateKey: toMealDateKey(meal.servedAt),
      universityId: user.universityId,
      selfId: meal.selfId,
      samadUsername: user.samadUsername,
      sharedByTelegramId: telegramId,
    });

    log.info({ telegramId, reserveId, inserted }, 'forget code shared');

    return inserted ? { kind: 'shared', issued } : { kind: 'already-shared', issued };
  }

  /**
   * Takes an unused code for today's meal at the chosen dining hall.
   *
   * Checking that a meal exists first is what keeps this honest: handing someone
   * a code for a meal they do not have would look like help and be useless.
   */
  async claimTodaysCode(telegramId: number, selfId: number): Promise<ForgetCode> {
    const user = await this.users.findByTelegramId(telegramId);

    if (user === null) {
      throw new NotFoundError('No linked account', 'اول باید وارد حساب سمادت شوی.');
    }

    const program = await this.reservations.findTodaysProgram(telegramId, selfId);

    if (program === null) {
      throw new NotFoundError(`No meal today at self ${selfId}`, 'امروز برای این سلف غذایی نداری، پس کد فراموشی به کارت نمی‌آید.');
    }

    const claimed = await this.codes.claim(user.universityId, selfId, toMealDateKey(program.servedAt), telegramId);

    if (claimed === null) {
      throw new NotFoundError(
        `No unclaimed forget code for self ${selfId} on ${toMealDateKey(program.servedAt)}`,
        'متأسفانه برای این وعده کد آزادی توی مخزن نیست. می‌تونی خودت کد بذاری یا بعداً دوباره سر بزنی.',
      );
    }

    log.info({ telegramId, selfId, codeId: claimed.id }, 'forget code claimed');

    return claimed;
  }

  /** Records a report that a shared code did not work, for an admin to follow up. */
  async reportBadCode(telegramId: number, code: string): Promise<void> {
    const trimmed = code.trim();

    if (trimmed.length === 0) {
      throw new NotFoundError('Empty code reported', 'کد را درست بفرست تا بررسی کنم.');
    }

    await this.reports.insert(telegramId, trimmed);

    log.info({ telegramId }, 'bad forget code reported');
  }

  /** How many codes are waiting in the pool for a university. */
  async countAvailable(universityId: number): Promise<number> {
    return this.codes.countAvailable(universityId);
  }

  /**
   * Removes codes whose meal has already passed.
   *
   * Without this the pool grows forever and every claim scans rows that can never
   * be used again. Called on a timer, never on the request path.
   */
  async purgeExpired(): Promise<number> {
    const removed = await this.codes.deleteForMealsBefore(todayKey(this.clock.now()));

    if (removed > 0) {
      log.info({ removed }, 'purged expired forget codes');
    }

    return removed;
  }
}
