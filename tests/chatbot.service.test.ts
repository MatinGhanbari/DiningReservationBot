import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatbotService } from '../src/app/chatbot.service';
import { SqliteChatbotRepository } from '../src/db/chatbot.repository';
import type { SqliteDatabase } from '../src/db/database';
import type { AssistantGateway, ChatTurn } from '../src/domain/ports';
import { createTestDatabase, expectUserMessage, fixedClock } from './helpers';

/**
 * The chatbot is the one place in this bot where a user's text is handed to
 * something that will act on it.
 *
 * Everything here is about what the service does *before* and *after* the model,
 * because that is the part under our control: strip what cannot be seen, cap what
 * costs money, answer one question at a time, and never let a question be more
 * than a question.
 */

function fakeAssistant(answer = 'جواب تست'): AssistantGateway & { answer: ReturnType<typeof vi.fn> } {
  return { answer: vi.fn(async () => answer) };
}

function build(options: { assistant?: AssistantGateway | null; answer?: string } = {}) {
  const db: SqliteDatabase = createTestDatabase();
  const messages = new SqliteChatbotRepository(db);
  const assistant = options.assistant === undefined ? fakeAssistant(options.answer) : options.assistant;

  return { messages, service: new ChatbotService(assistant, messages, fixedClock()), assistant };
}

describe('ChatbotService', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = createTestDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it('reports itself unavailable when no model is configured', () => {
    const { service } = build({ assistant: null });
    expect(service.available).toBe(false);
  });

  it('reports itself available when a model is configured', () => {
    const { service } = build();
    expect(service.available).toBe(true);
  });

  it('stores both sides of the exchange', async () => {
    const { service, messages } = build({ answer: 'جواب' });

    await service.ask(555, 'سؤال');

    const history = await messages.historyForUser(555, 10);
    expect(history.map(turn => turn.role)).toEqual(['user', 'assistant']);
    expect(history[0]?.content).toBe('سؤال');
    expect(history[1]?.content).toBe('جواب');
  });

  it('strips hidden characters but keeps the ZWNJ Persian needs', async () => {
    const { service, assistant } = build();

    await service.ask(555, 'چه طوری می\u200Bتونم رزرو کنم؟');

    const asked = (assistant as { answer: ReturnType<typeof vi.fn> }).answer.mock.calls[0]?.[0] as {
      question: string;
    };
    expect(asked.question).toBe('چه طوری میتونم رزرو کنم؟');
  });

  it('passes a correctly written Persian question through untouched', async () => {
    const { service, assistant } = build();

    const question = 'می\u200Cخوام رزرو خودکار رو فعال کنم. چطور؟';
    await service.ask(555, question);

    const asked = (assistant as { answer: ReturnType<typeof vi.fn> }).answer.mock.calls[0]?.[0] as {
      question: string;
    };
    expect(asked.question).toBe(question);
  });

  it('rejects a question that is nothing but invisible characters', async () => {
    const { service } = build();

    await expectUserMessage(service.ask(555, '​‌‍‮'), /خالی/);
  });

  it('refuses a second question while the first is still being answered', async () => {
    // The gate is only armed once the first call reaches the model, so the test
    // waits for that signal rather than racing it.
    let started: (() => void) | undefined;
    const startedSignal = new Promise<void>(resolve => {
      started = resolve;
    });

    let release: (() => void) | undefined;
    const pending = new Promise<string>(resolve => {
      release = () => resolve('جواب');
    });

    const { service } = build({
      assistant: {
        answer: async () => {
          started?.();
          return pending;
        },
      },
    });

    const first = service.ask(555, 'سؤال اول');
    await startedSignal;

    await expectUserMessage(service.ask(555, 'سؤال دوم'), /صبر کن/);

    release?.();
    await first;
  });

  it('allows a second question once the first has finished', async () => {
    const { service } = build();

    await service.ask(555, 'اول');
    const second = await service.ask(555, 'دوم');

    expect(second.used).toBe(2);
  });

  it('clamps an oversized question instead of sending it whole', async () => {
    const { service, assistant } = build();

    await service.ask(555, 'الف'.repeat(5_000));

    const asked = (assistant as { answer: ReturnType<typeof vi.fn> }).answer.mock.calls[0]?.[0] as {
      question: string;
    };
    expect(asked.question.length).toBeLessThanOrEqual(501);
  });

  it('clamps an oversized answer before it is stored', async () => {
    const { service, messages } = build({ answer: 'ب'.repeat(10_000) });

    const result = await service.ask(555, 'سؤال');

    expect(result.answer.length).toBeLessThanOrEqual(2_001);
    expect((await messages.historyForUser(555, 10))[1]?.content.length).toBeLessThanOrEqual(2_001);
  });

  it('holds the model to the history window it was configured with', async () => {
    const { service, messages, assistant } = build();

    for (let index = 0; index < 6; index += 1) {
      await messages.append(555, 'user', `قدیمی ${index}`, null);
      await messages.append(555, 'assistant', `جواب ${index}`, 'model');
    }

    await service.ask(555, 'تازه');

    const asked = (assistant as { answer: ReturnType<typeof vi.fn> }).answer.mock.calls[0]?.[0] as {
      history: readonly ChatTurn[];
    };
    expect(asked.history.length).toBeLessThanOrEqual(16);
    expect(asked.history.at(-1)?.content).toBe('جواب 5');
  });

  it('counts the question against the daily allowance', async () => {
    const { service } = build();

    const result = await service.ask(555, 'سؤال');

    expect(result.used).toBe(1);
    expect(result.limit).toBeGreaterThan(0);
  });

  it('reports what is left today', async () => {
    const { service } = build();

    const before = await service.remainingToday(555);
    await service.ask(555, 'سؤال');
    const after = await service.remainingToday(555);

    expect(after).toBe(before - 1);
  });
});
