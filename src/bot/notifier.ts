import type { Telegraf } from 'telegraf';
import type { Notifier, SupportMessenger } from '../domain/ports';
import { scopedLogger } from '../shared/logger';

const log = scopedLogger('notifier');

/**
 * Delivers messages that are not replies to an update, and is the transport the
 * support flow uses to reach both users and admins.
 *
 * Every method returns the id of the message it created, or null when delivery
 * failed. Returning null rather than throwing is deliberate for the support
 * paths: a user who blocked the bot is an expected outcome, not an incident, and
 * the caller usually has a better answer than an error — telling the admin the
 * message did not arrive.
 *
 * `Notifier.notify` keeps its throwing contract, because the scheduled jobs do
 * want a failure to be visible in the log.
 */
export class TelegramNotifier implements Notifier, SupportMessenger {
  constructor(
    private readonly bot: Telegraf,
    private readonly admins: readonly number[],
  ) {}

  async notify(telegramId: number, html: string): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(telegramId, html, { parse_mode: 'HTML' });
    } catch (error) {
      log.warn({ err: error, telegramId }, 'could not deliver notification');
      throw error;
    }
  }

  async send(telegramId: number, html: string): Promise<number | null> {
    try {
      const message = await this.bot.telegram.sendMessage(telegramId, html, { parse_mode: 'HTML' });
      return message.message_id;
    } catch (error) {
      log.warn({ err: error, telegramId }, 'could not send message');
      return null;
    }
  }

  async reply(telegramId: number, replyToMessageId: number, html: string): Promise<number | null> {
    try {
      const message = await this.bot.telegram.sendMessage(telegramId, html, {
        parse_mode: 'HTML',
        reply_parameters: { message_id: replyToMessageId },
      });
      return message.message_id;
    } catch (error) {
      log.warn({ err: error, telegramId }, 'could not send reply');
      return null;
    }
  }

  async forward(targetTelegramId: number, sourceTelegramId: number, messageId: number): Promise<number | null> {
    try {
      const message = await this.bot.telegram.forwardMessage(targetTelegramId, sourceTelegramId, messageId);
      return message.message_id;
    } catch (error) {
      // Expected when the user has forwarding restricted, which is why the
      // support flow has a text fallback rather than treating this as a failure.
      log.info({ err: error, targetTelegramId, sourceTelegramId }, 'could not forward message');
      return null;
    }
  }

  async sendDocument(telegramId: number, filePath: string, caption: string): Promise<number | null> {
    try {
      const message = await this.bot.telegram.sendDocument(telegramId, { source: filePath }, { caption });
      return message.message_id;
    } catch (error) {
      log.warn({ err: error, telegramId }, 'could not send document');
      return null;
    }
  }

  adminIds(): readonly number[] {
    return this.admins;
  }
}
