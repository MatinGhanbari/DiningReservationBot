import type { ChatRole } from '../domain/models';
import type { ChatbotMessageRow, ChatbotRepository } from '../domain/ports';
import type { SqliteDatabase } from './database';

interface MessageRow {
  telegram_id: number;
  role: string;
  content: string;
  created_at: number;
}

function toRow(row: MessageRow): ChatbotMessageRow {
  return {
    telegramId: row.telegram_id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    createdAt: new Date(row.created_at),
  };
}

export class SqliteChatbotRepository implements ChatbotRepository {
  private readonly statements;

  constructor(db: SqliteDatabase) {
    this.statements = {
      insert: db.prepare<[number, string, string, string | null, number]>(
        'INSERT INTO chatbot_messages (telegram_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?)',
      ),
      historyForUser: db.prepare<[number, number], MessageRow>(
        'SELECT * FROM chatbot_messages WHERE telegram_id = ? ORDER BY id DESC LIMIT ?',
      ),
      countForUserSince: db.prepare<[number, number, string], { total: number }>(
        'SELECT COUNT(*) AS total FROM chatbot_messages WHERE telegram_id = ? AND created_at >= ? AND role = ?',
      ),
      countSince: db.prepare<[number], { total: number }>(
        'SELECT COUNT(*) AS total FROM chatbot_messages WHERE created_at >= ?',
      ),
      countUsersSince: db.prepare<[number], { total: number }>(
        'SELECT COUNT(DISTINCT telegram_id) AS total FROM chatbot_messages WHERE created_at >= ?',
      ),
      recent: db.prepare<[number], MessageRow>(
        'SELECT * FROM chatbot_messages ORDER BY id DESC LIMIT ?',
      ),
      recentQuestions: db.prepare<[number], MessageRow>(
        "SELECT * FROM chatbot_messages WHERE role = 'user' ORDER BY id DESC LIMIT ?",
      ),
      purgeBefore: db.prepare<[number]>('DELETE FROM chatbot_messages WHERE created_at < ?'),
    };
  }

  async append(telegramId: number, role: ChatRole, content: string, model: string | null): Promise<void> {
    this.statements.insert.run(telegramId, role, content, model, Date.now());
  }

  async historyForUser(telegramId: number, limit: number) {
    return this.statements.historyForUser
      .all(telegramId, limit)
      .reverse()
      .map(row => ({ role: row.role === 'assistant' ? ('assistant' as const) : ('user' as const), content: row.content }));
  }

  async countForUserSince(telegramId: number, since: Date): Promise<number> {
    return this.statements.countForUserSince.get(telegramId, since.getTime(), 'user')?.total ?? 0;
  }

  async countSince(since: Date): Promise<number> {
    return this.statements.countSince.get(since.getTime())?.total ?? 0;
  }

  async countUsersSince(since: Date): Promise<number> {
    return this.statements.countUsersSince.get(since.getTime())?.total ?? 0;
  }

  async recent(limit: number): Promise<readonly ChatbotMessageRow[]> {
    return this.statements.recent.all(limit).map(toRow);
  }

  async recentQuestions(limit: number): Promise<readonly ChatbotMessageRow[]> {
    return this.statements.recentQuestions.all(limit).map(toRow);
  }

  async purgeBefore(cutoff: Date): Promise<number> {
    return this.statements.purgeBefore.run(cutoff.getTime()).changes;
  }
}
