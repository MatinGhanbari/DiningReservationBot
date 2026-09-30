import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../src/app/auth.service';
import { SessionService } from '../src/app/session.service';
import { MemorySessionStore } from '../src/cache/session.store';
import { AesSecretBox } from '../src/crypto/secret-box';
import type { User } from '../src/domain/models';
import { InvalidCredentialsError, SessionExpiredError } from '../src/shared/errors';
import { FixedClock } from '../src/shared/clock';
import { type TestStores, createFakeGateway, fixedClock, makeUser, createTestStores } from './helpers';

const KEY = 'a-test-key-that-is-definitely-long-enough-for-the-required-minimum-length';

/** The shared factory stores a placeholder cipher; these tests need a real one. */
const withRefreshToken = (overrides: Partial<User> = {}): User =>
  makeUser({ encryptedRefreshToken: new AesSecretBox(KEY).encrypt('old-refresh-token'), ...overrides });

describe('session and auth', () => {
  let stores: TestStores;
  let users: TestStores['users'];
  let sessions: MemorySessionStore;
  let secretBox: AesSecretBox;
  let clock: FixedClock;

  beforeEach(() => {
    stores = createTestStores();
    users = stores.users;
    clock = fixedClock('2026-09-20T06:00:00Z');
    sessions = new MemorySessionStore(clock);
    secretBox = new AesSecretBox(KEY);
  });

  afterEach(async () => {
    await stores.cleanup();
  });

  function build(gateway = createFakeGateway()) {
    const sessionService = new SessionService(users, sessions, gateway, secretBox, clock);
    const auth = new AuthService(users, gateway, secretBox, sessionService, clock);

    return { gateway, sessionService, auth };
  }

  describe('AuthService.login', () => {
    it('links the account, keeps the refresh token and stores no password', async () => {
      const { auth, gateway } = build();

      const result = await auth.login(555, 8, '99123456', 'my-password');

      expect(result.isNewUser).toBe(true);
      expect(result.user.firstName).toBe('مهدی');
      expect(gateway.login).toHaveBeenCalledWith({ universityId: 8, samadUsername: '99123456', password: 'my-password' });

      const stored = await users.findByTelegramId(555);
      expect(stored?.encryptedRefreshToken).not.toContain('refresh-token-1');
      expect(secretBox.decrypt(stored?.encryptedRefreshToken ?? '')).toBe('refresh-token-1');

      // The password is used once and dropped: nothing in the record holds it.
      expect(JSON.stringify(stored)).not.toContain('my-password');
    });

    it('does not touch stored credentials when Samad rejects the login', async () => {
      const { auth } = build(createFakeGateway({ loginError: new InvalidCredentialsError() }));
      await users.save(withRefreshToken());

      await expect(auth.login(555, 8, '99123456', 'wrong')).rejects.toBeInstanceOf(InvalidCredentialsError);

      // A failed sign-in must not overwrite a token that already worked.
      const stored = await users.findByTelegramId(555);
      expect(secretBox.decrypt(stored?.encryptedRefreshToken ?? '')).toBe('old-refresh-token');
    });

    it('keeps auto-reserve configuration across a re-login', async () => {
      const { auth } = build();

      await users.save(withRefreshToken());
      await users.setAutoReserveSelf(555, 5);
      await users.setAutoReserveEnabled(555, true);
      await users.toggleAutoReserveWeekday(555, 1);

      const result = await auth.login(555, 8, '99123456', 'my-password');

      expect(result.isNewUser).toBe(false);
      expect(result.user.autoReserveEnabled).toBe(true);
      expect(result.user.autoReserveWeekdays).toEqual([1]);
      expect(result.user.autoReserveSelfId).toBe(5);
    });
  });

  describe('AuthService.logout', () => {
    it('removes the account and forgets the token', async () => {
      const { auth, sessionService } = build();

      await auth.login(555, 8, '99123456', 'my-password');
      await auth.logout(555);

      // Both halves matter: keeping the token would let the bot log the user back
      // in, which is not what «خروج» (logout) means.
      expect(await users.findByTelegramId(555)).toBeNull();
      await expect(sessionService.getAccessToken(555)).rejects.toBeInstanceOf(SessionExpiredError);
    });
  });

  describe('SessionService.getAccessToken', () => {
    it('returns the cached token without calling Samad again', async () => {
      const { auth, sessionService, gateway } = build();

      await auth.login(555, 8, '99123456', 'my-password');
      gateway.login.mockClear();

      const { accessToken } = await sessionService.getAccessToken(555);

      expect(accessToken).toBe('access-token-1');
      expect(gateway.login).not.toHaveBeenCalled();
    });

    it('renews from the stored refresh token once the access token has expired', async () => {
      const { auth, sessionService, gateway } = build();

      await auth.login(555, 8, '99123456', 'my-password');
      gateway.login.mockClear();

      // Move past the session lifetime.
      clock.advance(2 * 60 * 60 * 1000);

      const { accessToken } = await sessionService.getAccessToken(555);

      expect(accessToken).toBe('access-token-2');

      // Samad is handed the token it issued, never the password again.
      expect(gateway.login).not.toHaveBeenCalled();
      expect(gateway.refresh).toHaveBeenCalledWith({
        universityId: 8,
        samadUsername: '99123456',
        refreshToken: 'refresh-token-1',
      });
    });

    it('renews with the rotated token, not the one it already spent', async () => {
      const { auth, sessionService, gateway } = build();

      await auth.login(555, 8, '99123456', 'my-password');

      clock.advance(2 * 60 * 60 * 1000);
      await sessionService.getAccessToken(555);

      // Samad replaces the refresh token when it is used, so the first one is
      // spent: a second renewal only works if the new one was written back.
      clock.advance(2 * 60 * 60 * 1000);
      await sessionService.getAccessToken(555);

      expect(gateway.refresh).toHaveBeenLastCalledWith({
        universityId: 8,
        samadUsername: '99123456',
        refreshToken: 'refresh-token-2',
      });
    });

    it('asks the user to sign in again when no refresh token was issued', async () => {
      const { auth, sessionService } = build(createFakeGateway({ session: { refreshToken: null } }));

      await auth.login(555, 8, '99123456', 'my-password');
      clock.advance(2 * 60 * 60 * 1000);

      // Nothing to renew with, and no password to fall back on: signing in is
      // the only way forward, so that is what the user is told.
      await expect(sessionService.getAccessToken(555)).rejects.toBeInstanceOf(SessionExpiredError);
    });

    it('refreshes early rather than letting a token die mid-request', async () => {
      const { auth, sessionService, gateway } = build();

      await auth.login(555, 8, '99123456', 'my-password');
      gateway.refresh.mockClear();

      // The stored session is still technically valid here, but only just.
      clock.advance(59 * 60 * 1000);

      await sessionService.getAccessToken(555);

      expect(gateway.refresh).toHaveBeenCalled();
    });

    it('reports an expired session when the account is not linked', async () => {
      const { sessionService } = build();

      await expect(sessionService.getAccessToken(999)).rejects.toBeInstanceOf(SessionExpiredError);
    });
  });

  describe('SessionService.withToken', () => {
    it('recovers once from a token Samad rejects early', async () => {
      const gateway = createFakeGateway();
      const { auth, sessionService } = build(gateway);

      await auth.login(555, 8, '99123456', 'my-password');

      const operation = vi.fn().mockRejectedValueOnce(new SessionExpiredError()).mockResolvedValueOnce('done');

      // Samad can revoke a token before our cached expiry says it is gone.
      const result = await sessionService.withToken(555, operation);

      expect(result).toBe('done');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('does not retry a failure that is not an expired session', async () => {
      const gateway = createFakeGateway();
      const { auth, sessionService } = build(gateway);

      await auth.login(555, 8, '99123456', 'my-password');

      const operation = vi.fn().mockRejectedValue(new InvalidCredentialsError());

      await expect(sessionService.withToken(555, operation)).rejects.toBeInstanceOf(InvalidCredentialsError);
      expect(operation).toHaveBeenCalledTimes(1);
    });
  });
});
