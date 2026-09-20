import { config } from '../config/env';
import type { SamadSession } from '../domain/models';
import type { Clock, SamadGateway, SecretBox, SessionStore, TokenProvider, UserRepository } from '../domain/ports';
import { SessionExpiredError } from '../shared/errors';
import { scopedLogger } from '../shared/logger';
import { MINUTE } from '../shared/time';

const log = scopedLogger('session');

/**
 * Renew a token this long before it actually expires.
 *
 * Without the margin a token can pass the expiry check and then die in flight,
 * which surfaces to the user as an unexplained upstream failure on a request
 * that should have worked.
 */
const REFRESH_MARGIN_MS = 5 * MINUTE;

/**
 * Owns the lifetime of Samad access tokens.
 *
 * In the original code `AuthService` depended on `UserService` and `UserService`
 * depended on `AuthService`, so neither could be constructed or tested on its
 * own and the dependency graph had a cycle. Both now depend on the repositories
 * and this class instead, and the cycle is gone.
 *
 * The other thing this fixes: the old token cache keyed on the Telegram id but
 * stored only the token string, so nothing knew when it expired — an expired
 * token was returned as if it were valid, and the user saw a raw upstream 401.
 * Here the expiry is part of the stored value and is checked on every read.
 */
export class SessionService implements TokenProvider {
  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionStore,
    private readonly gateway: SamadGateway,
    private readonly secretBox: SecretBox,
    private readonly clock: Clock,
  ) {}

  /** Stores a freshly obtained session, honouring both its own and the configured lifetime. */
  async establish(telegramId: number, session: SamadSession): Promise<void> {
    await this.sessions.set(telegramId, session, this.ttlFor(session));
  }

  async getAccessToken(telegramId: number): Promise<{ accessToken: string; universityId: number }> {
    const cached = await this.sessions.get(telegramId);

    if (cached !== null && this.isUsable(cached)) {
      return { accessToken: cached.accessToken, universityId: cached.universityId };
    }

    const user = await this.users.findByTelegramId(telegramId);

    if (user === null) {
      throw new SessionExpiredError({ context: { telegramId, reason: 'no-linked-account' } });
    }

    // The stored password is what makes re-login invisible to the user. It is
    // decrypted only here, only for as long as the request needs it.
    const password = this.secretBox.decrypt(user.encryptedPassword);

    log.debug({ telegramId, universityId: user.universityId }, 'refreshing expired Samad session');

    const session = await this.gateway.login({
      universityId: user.universityId,
      samadUsername: user.samadUsername,
      password,
    });

    await this.sessions.set(telegramId, session, this.ttlFor(session));

    return { accessToken: session.accessToken, universityId: session.universityId };
  }

  async invalidate(telegramId: number): Promise<void> {
    await this.sessions.delete(telegramId);
  }

  /**
   * Runs an authenticated operation, recovering once from a token that Samad
   * rejected.
   *
   * The cached expiry is only our best guess: Samad can revoke a token early,
   * and a token can lapse between the check and the request. Without this, that
   * race reaches the user as «نشستت منقضی شده» on a request that should have
   * succeeded silently.
   */
  async withToken<T>(
    telegramId: number,
    operation: (context: { accessToken: string; universityId: number }) => Promise<T>,
  ): Promise<T> {
    const context = await this.getAccessToken(telegramId);

    try {
      return await operation(context);
    } catch (error) {
      if (!(error instanceof SessionExpiredError)) {
        throw error;
      }

      log.debug({ telegramId }, 'Samad rejected a cached token; refreshing once');

      await this.invalidate(telegramId);
      const refreshed = await this.getAccessToken(telegramId);

      return operation(refreshed);
    }
  }

  /** Current in-memory session count, for the health endpoint. */
  sessionCount(): number {
    return this.sessions.size();
  }

  private isUsable(session: SamadSession): boolean {
    return session.expiresAt.getTime() - REFRESH_MARGIN_MS > this.clock.now().getTime();
  }

  private ttlFor(session: SamadSession): number {
    const remaining = session.expiresAt.getTime() - this.clock.now().getTime();
    const configured = config.SESSION_TTL_MINUTES * MINUTE;

    return Math.max(0, Math.min(remaining, configured));
  }
}
