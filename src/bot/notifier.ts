import type { Telegraf } from 'telegraf';
import type { Notifier, SupportMessenger } from '../domain/ports';
import { scopedLogger } from '../shared/logger';
import { TypingIndicator } from './typing';

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
 *
 * ## Where the typing indicator is set, and where it deliberately is not
 *
 * `reply`, `forward` and `sendDocument` are conversational: someone is sitting in
 * that chat waiting for the result of an action they just took. They set the
 * indicator first.
 *
 * `notify` and `send` do not, and that is a decision rather than an oversight.
 * Both are *push* channels — the broadcast loop, the nightly auto-reserve run,
 * the credit warning — where the recipient is not waiting for anything, and where
 * the same method is called once per user in a loop that is already paced to stay
 * under Telegram's rate limit. A chat action there would not be seen by anyone
 * and would halve the throughput of a mass send for no benefit.
 */
export class TelegramNotifier implements Notifier, SupportMessenger {
  /**
   * Its own indicator rather than the shared one.
   *
   * These sends have no `Context` to take a chat id from, and the throttle is
   * only a cache of "when did we last say typing to this chat" — a second copy
   * of it costs nothing and keeps the class free of module-level state.
   */
  private readonly typing = new TypingIndicator();

  constructor(
    private readonly bot: Telegraf,
    private readonly admins: readonly number[],
  ) {}

  /** Best effort: a chat action never fails a delivery. */
  private async showTyping(telegramId: number): Promise<void> {
    await this.typing.show(telegramId, () => this.bot.telegram.sendChatAction(telegramId, 'typing'));
  }

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
    await this.showTyping(telegramId);

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
    await this.showTyping(targetTelegramId);

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
    await this.showTyping(telegramId);

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
