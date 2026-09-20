import type { Telegraf } from 'telegraf';
import type { Notifier } from '../domain/ports';
import { scopedLogger } from '../shared/logger';

const log = scopedLogger('notifier');

/**
 * Delivers messages that are not replies to an update.
 *
 * The scheduled auto-reserve run has no `Context` to reply to, so it reaches
 * users through the bot's own client. Failures are logged and swallowed: the
 * reservation has already happened by then, and a user who blocked the bot is
 * not a reason to fail the run.
 */
export class TelegramNotifier implements Notifier {
  constructor(private readonly bot: Telegraf) {}

  async notify(telegramId: number, html: string): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(telegramId, html, { parse_mode: 'HTML' });
    } catch (error) {
      log.warn({ err: error, telegramId }, 'could not deliver notification');
      throw error;
    }
  }
}
