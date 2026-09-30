import { config } from '../config/env';
import type { SamadSession, User } from '../domain/models';
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

    const session = await this.renew(telegramId, user);

    await this.sessions.set(telegramId, session, this.ttlFor(session));

    return { accessToken: session.accessToken, universityId: session.universityId };
  }

  /**
   * Renews the session from the stored refresh token.
   *
   * No password is kept, so this is the only way back in. When there is nothing
   * usable to renew with — no token stored, a token that no longer decrypts, or
   * one Samad rejects — the user is sent back to the sign-in screen, which is the
   * one action that can fix it.
   */
  private async renew(telegramId: number, user: User): Promise<SamadSession> {
    if (user.encryptedRefreshToken.length === 0) {
      throw new SessionExpiredError({ context: { telegramId, reason: 'no-refresh-token' } });
    }

    let refreshToken: string;

    try {
      refreshToken = this.secretBox.decrypt(user.encryptedRefreshToken);
    } catch (error) {
      // A key that changed under a running deployment makes every stored token
      // unreadable at once. That is not an internal fault to the user; it is a
      // sign-in, which also re-encrypts under the current key.
      log.warn({ err: error, telegramId }, 'the stored refresh token could not be decrypted');
      throw new SessionExpiredError({ context: { telegramId, reason: 'unreadable-refresh-token' } });
    }

    log.debug({ telegramId, universityId: user.universityId }, 'renewing the Samad session');

    const session = await this.gateway.refresh({
      universityId: user.universityId,
      samadUsername: user.samadUsername,
      refreshToken,
    });

    // Samad hands back a refresh token on every renewal. The captured web client
    // ignores it and keeps the one it has, which suggests the same token comes
    // back — but if it is ever rotated instead, the old one is spent and the next
    // renewal would fail with it. Writing the new one costs a single write on a
    // path that runs once an hour per user, and removes that failure mode.
    //
    // Written through the existing credential path: `save` refreshes credentials
    // on an account that already exists and leaves the rest of the record alone.
    if (session.refreshToken !== null && session.refreshToken !== refreshToken) {
      await this.users.save({ ...user, encryptedRefreshToken: this.secretBox.encrypt(session.refreshToken) });
    }

    return session;
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
   * race reaches the user as «نشستت منقضی شده» ("your session has expired") on
   * a request that should have succeeded silently.
   */
  async withToken<T>(telegramId: number, operation: (context: { accessToken: string; universityId: number }) => Promise<T>): Promise<T> {
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
