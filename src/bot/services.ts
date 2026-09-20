import type { AdminService } from '../app/admin.service';
import type { AutoReserveService } from '../app/auto-reserve.service';
import type { AuthService } from '../app/auth.service';
import type { ChatbotService } from '../app/chatbot.service';
import type { CreditWatchService } from '../app/credit-watch.service';
import type { ForgetCodeService } from '../app/forget-code.service';
import type { ReservationService } from '../app/reservation.service';
import type { SupportService } from '../app/support.service';
import type { Clock, SupportMessenger } from '../domain/ports';
import type { ConversationStore } from './state';

/**
 * What a handler is allowed to reach.
 *
 * Passed as one object rather than as a long constructor argument list, so adding
 * a service does not change the signature of every handler in the bot.
 */
export interface BotServices {
  auth: AuthService;
  reservations: ReservationService;
  forgetCodes: ForgetCodeService;
  autoReserve: AutoReserveService;
  creditWatch: CreditWatchService;
  support: SupportService;
  chatbot: ChatbotService;
  admin: AdminService;
  messenger: SupportMessenger;
  conversations: ConversationStore;
  clock: Clock;
}
