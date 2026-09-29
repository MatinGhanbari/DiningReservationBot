import { config } from '../config/env';
import { copy } from '../copy/fa';
import type { ChatbotRepository, AssistantGateway } from '../domain/ports';
import { RateLimitedError, ValidationError } from '../shared/errors';
import { startOfConfiguredDay } from '../shared/dates';
import { clampText } from '../shared/sanitize';
import { scopedLogger } from '../shared/logger';
import type { Clock } from '../domain/ports';

const log = scopedLogger('chatbot');

export interface ChatbotAnswer {
  answer: string;
  /** How many messages the user has spent today, including this one. */
  used: number;
  limit: number;
}

/**
 * The support chatbot.
 *
 * It answers questions about this bot and nothing else — the scope lives in the
 * system prompt, and this class is responsible for the four things a language
 * model cannot be trusted to do for itself: staying inside a daily budget, not
 * answering twice at once, surviving a hostile question, and leaving a record
 * behind.
 *
 * Every exchange is persisted. Free models have a habit of being unavailable at
 * the exact moment someone needs help, and a conversation that was never stored
 * is one an admin cannot follow up on.
 */
export class ChatbotService {
  /** People with a request already in flight. One question at a time, per person. */
  private readonly inFlight = new Set<number>();

  constructor(
    private readonly assistant: AssistantGateway | null,
    private readonly messages: ChatbotRepository,
    private readonly clock: Clock,
  ) {}

  /** False when no OpenRouter key is configured, so the UI can hide the option. */
  get available(): boolean {
    return this.assistant !== null;
  }

  async ask(telegramId: number, rawQuestion: string): Promise<ChatbotAnswer> {
    const assistant = this.assistant;

    if (assistant === null) {
      throw new ValidationError('The chatbot is not configured', copy.support.chatbotUnavailable());
    }

    // Invisible characters are stripped before the length check: a zero-width
    // joiner costs nothing to a human reader and everything to a token budget.
    const question = clampText(rawQuestion, config.CHATBOT_MAX_QUESTION_CHARS);

    if (question.length === 0) {
      throw new ValidationError('Chatbot received an empty question', copy.errors.emptyQuestion());
    }

    if (this.inFlight.has(telegramId)) {
      throw new RateLimitedError(`Chatbot is already answering user ${telegramId}`, copy.errors.chatbotBusy(), {
        context: { telegramId },
      });
    }

    const limit = config.CHATBOT_DAILY_LIMIT;
    const usedToday = await this.messages.countForUserSince(telegramId, startOfConfiguredDay(this.clock.now()));

    if (usedToday >= limit) {
      throw new RateLimitedError(
        `Chatbot daily limit reached for user ${telegramId}`,
        `سهمیهٔ امروزت از چت‌بات تموم شده (${limit} پیام در روز). فردا دوباره فعال می‌شه، یا از گزینهٔ «پیام به پشتیبانی» استفاده کن.`,
        { context: { telegramId, limit } },
      );
    }

    const history = await this.messages.historyForUser(telegramId, config.CHATBOT_HISTORY_TURNS * 2);

    // Stored before the call, so a question that never got an answer is still on
    // record — that is exactly the case an admin needs to see.
    await this.messages.append(telegramId, 'user', question, null);

    this.inFlight.add(telegramId);

    try {
      const answer = clampText(await assistant.answer({ question, history }), config.CHATBOT_MAX_ANSWER_CHARS);

      await this.messages.append(telegramId, 'assistant', answer, config.OPENROUTER_MODEL);
      log.info({ telegramId, usedToday: usedToday + 1 }, 'chatbot answered');

      return { answer, used: usedToday + 1, limit };
    } catch (error) {
      log.warn({ err: error, telegramId }, 'chatbot could not answer');
      throw error;
    } finally {
      this.inFlight.delete(telegramId);
    }
  }

  /** How many messages this user has left today. */
  async remainingToday(telegramId: number): Promise<number> {
    const used = await this.messages.countForUserSince(telegramId, startOfConfiguredDay(this.clock.now()));
    return Math.max(0, config.CHATBOT_DAILY_LIMIT - used);
  }
}
