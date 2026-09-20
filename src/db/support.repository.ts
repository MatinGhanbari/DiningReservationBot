import type {
  SupportDirection,
  SupportEnvelope,
  SupportMessage,
  SupportTicket,
  SupportTicketStatus,
  SupportTicketSummary,
} from '../domain/models';
import type { SupportRepository } from '../domain/ports';
import type { SqliteDatabase } from './database';

interface TicketRow {
  id: number;
  telegram_id: number;
  status: string;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

interface SummaryRow extends TicketRow {
  message_count: number;
  last_message: string | null;
  first_name: string | null;
  last_name: string | null;
}

interface MessageRow {
  id: number;
  ticket_id: number;
  direction: string;
  content: string;
  created_at: number;
}

function toTicket(row: TicketRow): SupportTicket {
  return {
    id: row.id,
    telegramId: row.telegram_id,
    status: row.status === 'closed' ? 'closed' : 'open',
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    closedAt: row.closed_at === null ? null : new Date(row.closed_at),
  };
}

/** A person who never logged in has no name on file, so the ticket says so. */
function displayNameOf(firstName: string | null, lastName: string | null): string {
  const name = [firstName, lastName]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(' ')
    .trim();
  return name.length === 0 ? 'کاربر بدون حساب' : name;
}

export class SqliteSupportRepository implements SupportRepository {
  private readonly statements;

  constructor(private readonly db: SqliteDatabase) {
    this.statements = {
      findOpen: db.prepare<[number, string], TicketRow>(
        'SELECT * FROM support_tickets WHERE telegram_id = ? AND status = ? ORDER BY id DESC LIMIT 1',
      ),
      findById: db.prepare<[number], TicketRow>('SELECT * FROM support_tickets WHERE id = ?'),
      insertTicket: db.prepare<[number, string, number, number]>(
        'INSERT INTO support_tickets (telegram_id, status, created_at, updated_at) VALUES (?, ?, ?, ?)',
      ),
      insertMessage: db.prepare<[number, string, string, number]>(
        'INSERT INTO support_messages (ticket_id, direction, content, created_at) VALUES (?, ?, ?, ?)',
      ),
      touchTicket: db.prepare<[number, number]>('UPDATE support_tickets SET updated_at = ? WHERE id = ?'),
      closeTicket: db.prepare<[number, number, number]>(
        "UPDATE support_tickets SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'open'",
      ),
      listMessages: db.prepare<[number, number], MessageRow>('SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY id DESC LIMIT ?'),
      countMessages: db.prepare<[number], { total: number }>('SELECT COUNT(*) AS total FROM support_messages WHERE ticket_id = ?'),
      recordDelivery: db.prepare<[number, number, number, number]>(
        'INSERT OR IGNORE INTO support_deliveries (ticket_id, admin_telegram_id, message_id, created_at) VALUES (?, ?, ?, ?)',
      ),
      findByDelivery: db.prepare<[number, number], TicketRow>(`
        SELECT t.* FROM support_tickets t
        JOIN support_deliveries d ON d.ticket_id = t.id
        WHERE d.admin_telegram_id = ? AND d.message_id = ?
        LIMIT 1
      `),
      listOpen: db.prepare<[number], SummaryRow>(`
        SELECT
          t.*,
          (SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id = t.id) AS message_count,
          (SELECT m.content FROM support_messages m WHERE m.ticket_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_message,
          u.first_name,
          u.last_name
        FROM support_tickets t
        LEFT JOIN users u ON u.telegram_id = t.telegram_id
        WHERE t.status = 'open'
        ORDER BY t.updated_at DESC
        LIMIT ?
      `),
      countByStatus: db.prepare<[string], { total: number }>('SELECT COUNT(*) AS total FROM support_tickets WHERE status = ?'),
      countMessagesSince: db.prepare<[number], { total: number }>('SELECT COUNT(*) AS total FROM support_messages WHERE created_at >= ?'),
      lastMessageAt: db.prepare<[], { latest: number | null }>('SELECT MAX(created_at) AS latest FROM support_messages'),
    };
  }

  async openTicket(envelope: SupportEnvelope): Promise<{ ticket: SupportTicket; created: boolean }> {
    const now = Date.now();

    const run = this.db.transaction(() => {
      const existing = this.statements.findOpen.get(envelope.telegramId, 'open');

      const ticketId = existing === undefined ? this.insertTicket(envelope.telegramId, now) : existing.id;

      this.statements.insertMessage.run(ticketId, 'in', envelope.content, now);
      this.statements.touchTicket.run(now, ticketId);

      return { ticketId, created: existing === undefined };
    });

    const { ticketId, created } = run();
    const row = this.statements.findById.get(ticketId);

    if (row === undefined) {
      throw new Error(`Support ticket ${ticketId} vanished immediately after insert`);
    }

    return { ticket: toTicket(row), created };
  }

  async findOpenTicket(telegramId: number): Promise<SupportTicket | null> {
    const row = this.statements.findOpen.get(telegramId, 'open');
    return row === undefined ? null : toTicket(row);
  }

  async appendMessage(ticketId: number, direction: SupportDirection, content: string): Promise<void> {
    const now = Date.now();

    const run = this.db.transaction(() => {
      this.statements.insertMessage.run(ticketId, direction, content, now);
      this.statements.touchTicket.run(now, ticketId);
    });

    run();
  }

  async listMessages(ticketId: number, limit: number): Promise<readonly SupportMessage[]> {
    return this.statements.listMessages
      .all(ticketId, limit)
      .map(row => ({
        id: row.id,
        ticketId: row.ticket_id,
        direction: row.direction === 'out' ? ('out' as const) : ('in' as const),
        content: row.content,
        createdAt: new Date(row.created_at),
      }))
      .reverse();
  }

  async countMessages(ticketId: number): Promise<number> {
    return this.statements.countMessages.get(ticketId)?.total ?? 0;
  }

  async recordDelivery(ticketId: number, adminTelegramId: number, messageId: number): Promise<void> {
    this.statements.recordDelivery.run(ticketId, adminTelegramId, messageId, Date.now());
  }

  async findTicketByDelivery(adminTelegramId: number, messageId: number): Promise<SupportTicket | null> {
    const row = this.statements.findByDelivery.get(adminTelegramId, messageId);
    return row === undefined ? null : toTicket(row);
  }

  async findById(ticketId: number): Promise<SupportTicket | null> {
    const row = this.statements.findById.get(ticketId);
    return row === undefined ? null : toTicket(row);
  }

  async closeTicket(ticketId: number): Promise<boolean> {
    const now = Date.now();
    return this.statements.closeTicket.run(now, now, ticketId).changes > 0;
  }

  async listOpen(limit: number): Promise<readonly SupportTicketSummary[]> {
    return this.statements.listOpen.all(limit).map(row => ({
      ...toTicket(row),
      status: 'open' as SupportTicketStatus,
      displayName: displayNameOf(row.first_name, row.last_name),
      messageCount: row.message_count,
      lastMessage: row.last_message ?? '',
    }));
  }

  async countByStatus(status: 'open' | 'closed'): Promise<number> {
    return this.statements.countByStatus.get(status)?.total ?? 0;
  }

  async countMessagesSince(since: Date): Promise<number> {
    return this.statements.countMessagesSince.get(since.getTime())?.total ?? 0;
  }

  async lastMessageAt(): Promise<Date | null> {
    const latest = this.statements.lastMessageAt.get()?.latest;
    return typeof latest === 'number' ? new Date(latest) : null;
  }

  private insertTicket(telegramId: number, now: number): number {
    const result = this.statements.insertTicket.run(telegramId, 'open', now, now);
    return Number(result.lastInsertRowid);
  }
}
