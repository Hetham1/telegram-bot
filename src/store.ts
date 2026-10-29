import type { Env, Keyboard, Prompt, Schedule, User } from './types';
import { question, questionKeyboard, reminderQuestion } from './messages';

export class Store {
  constructor(public env: Env, public now: number) {}
  sql(query: string, ...values: Array<string | number | null>) { return this.env.DB.prepare(query).bind(...values); }
  admins() { return new Set((this.env.ADMIN_IDS ?? '').split(',').map(v => Number(v.trim())).filter(v => Number.isSafeInteger(v) && v > 0)); }
  user(id: number) { return this.sql('SELECT * FROM users WHERE id = ?', id).first<User>(); }
  prompt(id: string) {
    return this.sql(`SELECT *, COALESCE(schedule_key, period) AS schedule_key,
      COALESCE(time_minutes, CASE period WHEN 'afternoon' THEN 840 ELSE 1320 END) AS time_minutes,
      COALESCE(pills, CASE period WHEN 'afternoon' THEN 'اسنترا' ELSE 'اون دوتا' END) AS pills
      FROM prompts WHERE id = ?`, id).first<Prompt>();
  }
  schedule(userId: number, key: string) {
    return this.sql('SELECT * FROM schedules WHERE user_id = ? AND key = ? AND deleted = 0', userId, key).first<Schedule>();
  }
  async schedules(userId: number) {
    return (await this.sql('SELECT * FROM schedules WHERE user_id = ? AND deleted = 0 ORDER BY time_minutes, key', userId).all<Schedule>()).results;
  }
  async ensureSchedules(userId: number) {
    await this.env.DB.batch([
      this.sql(`INSERT OR IGNORE INTO schedules(user_id, key, time_minutes, pills)
        SELECT id, 'afternoon', 840, 'اسنترا' FROM users WHERE id = ? AND schedule_initialized = 0`, userId),
      this.sql(`INSERT OR IGNORE INTO schedules(user_id, key, time_minutes, pills)
        SELECT id, 'evening', 1320, 'اون دوتا' FROM users WHERE id = ? AND schedule_initialized = 0`, userId),
      this.sql('UPDATE users SET schedule_initialized = 1 WHERE id = ? AND schedule_initialized = 0', userId),
    ]);
  }

  outgoing(id: string, chatId: number, method: string, payload: Record<string, unknown>, promptId: string | null = null,
    condition = '1', values: Array<string | number | null> = []) {
    return this.sql(`INSERT OR IGNORE INTO outbox(id, chat_id, method, payload, prompt_id, created_at, due_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${condition}`, id, chatId, method, JSON.stringify(payload), promptId, this.now, this.now, ...values);
  }
  reply(id: string, chatId: number, text: string, keyboard?: Keyboard, messageId?: number) {
    return this.outgoing(id, chatId, messageId ? 'editMessageText' : 'sendMessage', {
      chat_id: chatId, text, ...(messageId ? { message_id: messageId } : {}),
      ...(keyboard ? { reply_markup: keyboard } : messageId ? { reply_markup: { inline_keyboard: [] } } : {}),
    });
  }

  question(id: string, userId: number, date: string, slot: Schedule, daily = false, sourceUpdateId?: number, seriesId = id) {
    const sourceCondition = sourceUpdateId === undefined ? '' :
      ' AND EXISTS (SELECT 1 FROM reminders WHERE user_id = ? AND date = ? AND period = ? AND source_update_id = ?)';
    const params: Array<string | number> = [id, userId, date, slot.time_minutes >= 1320 ? 'evening' : 'afternoon', seriesId,
      this.now, slot.key, slot.revision, slot.time_minutes, slot.pills, userId, seriesId, userId, slot.key, slot.revision];
    if (sourceUpdateId !== undefined) params.push(userId, date, slot.key, sourceUpdateId);
    const payload = JSON.stringify({ chat_id: userId, text: daily ? question(slot) : reminderQuestion(slot), reply_markup: questionKeyboard(id) });
    return [
      this.sql(`INSERT OR IGNORE INTO prompts(id, user_id, date, period, series_id, created_at, schedule_key, schedule_revision, time_minutes, pills)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND active = 1 AND is_admin = 0)
        AND NOT EXISTS (SELECT 1 FROM prompts WHERE series_id = ? AND answer = 'yes')
        AND EXISTS (SELECT 1 FROM schedules WHERE user_id = ? AND key = ? AND revision = ? AND enabled = 1 AND deleted = 0)${sourceCondition}`, ...params),
      this.sql(`INSERT OR IGNORE INTO outbox(id, chat_id, method, payload, prompt_id, created_at, due_at)
        SELECT ?, ?, 'sendMessage', ?, id, ?, ? FROM prompts WHERE id = ? AND answer IS NULL AND canceled_at IS NULL`,
      `prompt:${id}`, userId, payload, this.now, this.now, id),
    ];
  }

  async complete(updateId: number, statements: D1PreparedStatement[]) {
    await this.env.DB.batch([...statements,
      this.sql('UPDATE inbox SET processed_at = ?, locked_until = 0 WHERE update_id = ?', this.now, updateId),
    ]);
  }
}
