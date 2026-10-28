import type { Env, Keyboard, Period, Prompt, User } from './types';
import { question, questionKeyboard, reminderQuestion } from './messages';

export class Store {
  constructor(public env: Env, public now: number) {}
  sql(query: string, ...values: Array<string | number | null>) { return this.env.DB.prepare(query).bind(...values); }
  admins() { return new Set((this.env.ADMIN_IDS ?? '').split(',').map(v => Number(v.trim())).filter(v => Number.isSafeInteger(v) && v > 0)); }
  user(id: number) { return this.sql('SELECT * FROM users WHERE id = ?', id).first<User>(); }
  prompt(id: string) { return this.sql('SELECT * FROM prompts WHERE id = ?', id).first<Prompt>(); }

  outgoing(id: string, chatId: number, method: string, payload: Record<string, unknown>, promptId: string | null = null) {
    return this.sql(`INSERT OR IGNORE INTO outbox(id, chat_id, method, payload, prompt_id, created_at, due_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, id, chatId, method, JSON.stringify(payload), promptId, this.now, this.now);
  }
  reply(id: string, chatId: number, text: string, keyboard?: Keyboard, messageId?: number) {
    return this.outgoing(id, chatId, messageId ? 'editMessageText' : 'sendMessage', {
      chat_id: chatId, text, ...(messageId ? { message_id: messageId } : {}),
      ...(keyboard ? { reply_markup: keyboard } : messageId ? { reply_markup: { inline_keyboard: [] } } : {}),
    });
  }

  question(id: string, userId: number, date: string, period: Period, daily = false, sourceUpdateId?: number, seriesId = id) {
    const sourceCondition = sourceUpdateId === undefined ? '' :
      ' AND EXISTS (SELECT 1 FROM reminders WHERE user_id = ? AND date = ? AND period = ? AND source_update_id = ?)';
    const params: Array<string | number> = [id, userId, date, period, seriesId, this.now, userId, seriesId];
    if (sourceUpdateId !== undefined) params.push(userId, date, period, sourceUpdateId);
    const payload = JSON.stringify({ chat_id: userId, text: daily ? question(period) : reminderQuestion(period), reply_markup: questionKeyboard(id) });
    return [
      this.sql(`INSERT OR IGNORE INTO prompts(id, user_id, date, period, series_id, created_at)
        SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND active = 1 AND is_admin = 0)
        AND NOT EXISTS (SELECT 1 FROM prompts WHERE series_id = ? AND answer = 'yes')${sourceCondition}`, ...params),
      this.sql(`INSERT OR IGNORE INTO outbox(id, chat_id, method, payload, prompt_id, created_at, due_at)
        SELECT ?, ?, 'sendMessage', ?, id, ?, ? FROM prompts WHERE id = ? AND answer IS NULL`,
      `prompt:${id}`, userId, payload, this.now, this.now, id),
    ];
  }

  async complete(updateId: number, statements: D1PreparedStatement[]) {
    await this.env.DB.batch([...statements,
      this.sql('UPDATE inbox SET processed_at = ?, locked_until = 0 WHERE update_id = ?', this.now, updateId),
    ]);
  }
}
