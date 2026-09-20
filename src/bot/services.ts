import type { AutoReserveService } from '../app/auto-reserve.service';
import type { AuthService } from '../app/auth.service';
import type { ForgetCodeService } from '../app/forget-code.service';
import type { ReservationService } from '../app/reservation.service';
import type { Clock } from '../domain/ports';
import type { ConversationStore } from './state';

/**
 * What a handler is allowed to reach.
 *
 * Passed as one object rather than as eight constructor arguments, so adding a
 * service does not change the signature of every handler in the bot.
 */
export interface BotServices {
  auth: AuthService;
  reservations: ReservationService;
  forgetCodes: ForgetCodeService;
  autoReserve: AutoReserveService;
  conversations: ConversationStore;
  clock: Clock;
}
