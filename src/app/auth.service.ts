import type { User } from '../domain/models';
import type { Clock, SamadGateway, SecretBox, UserRepository } from '../domain/ports';
import { scopedLogger } from '../shared/logger';
import type { SessionService } from './session.service';

const log = scopedLogger('auth');

export interface LoginResult {
  user: User;
  /** True when this Telegram account had never linked a Samad account before. */
  isNewUser: boolean;
}

/**
 * Signing in, signing out, and the profile screen.
 *
 * The password never leaves this class except as ciphertext or as part of an
 * outgoing login request, and it is never logged.
 */
export class AuthService {
  constructor(
    private readonly users: UserRepository,
    private readonly gateway: SamadGateway,
    private readonly secretBox: SecretBox,
    private readonly sessionService: SessionService,
    private readonly clock: Clock,
  ) {}

  /**
   * Verifies credentials against Samad and links the account to this Telegram id.
   *
   * The order matters: Samad is asked first, so a wrong password never overwrites
   * credentials that already worked.
   */
  async login(telegramId: number, universityId: number, samadUsername: string, password: string): Promise<LoginResult> {
    const session = await this.gateway.login({ universityId, samadUsername, password });

    const existing = await this.users.findByTelegramId(telegramId);
    const now = this.clock.now();

    const user: User = {
      telegramId,
      firstName: session.firstName,
      lastName: session.lastName,
      universityId,
      samadUsername,
      encryptedPassword: this.secretBox.encrypt(password),
      // Preserved across re-login; the repository ignores these columns on update.
      autoReserveEnabled: existing?.autoReserveEnabled ?? false,
      autoReserveSelfId: existing?.autoReserveSelfId ?? null,
      autoReserveWeekdays: existing?.autoReserveWeekdays ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.users.save(user);
    await this.sessionService.establish(telegramId, session);

    log.info({ telegramId, universityId, isNewUser: existing === null }, 'user signed in');

    return { user, isNewUser: existing === null };
  }

  /**
   * Unlinks the account and forgets the token.
   *
   * Both halves matter: dropping only the token would leave the bot able to log
   * the user straight back in from the stored password, which is not what
   * «خروج» means to the person who tapped it.
   */
  async logout(telegramId: number): Promise<void> {
    await Promise.all([this.users.deleteByTelegramId(telegramId), this.sessionService.invalidate(telegramId)]);

    log.info({ telegramId }, 'user signed out');
  }

  async findUser(telegramId: number): Promise<User | null> {
    return this.users.findByTelegramId(telegramId);
  }
}
