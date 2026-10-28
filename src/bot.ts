import { Store } from './store';
import type { Keyboard, Update, User } from './types';
import { adminKeyboard, adminText, back, snoozed, stopped, thanks, welcome } from './messages';
import { currentPeriod, localTime, SCHEDULE } from './time';

export class Bot {
  constructor(private store: Store) {}

  async process(updateId: number): Promise<void> {
    const s = this.store;
    const item = await s.sql(`UPDATE inbox SET locked_until = ?, attempts = attempts + 1
      WHERE update_id = ? AND processed_at IS NULL AND locked_until <= ?
      RETURNING payload`, s.now + 60_000, updateId, s.now).first<{ payload: string }>();
    if (!item) return;
    try {
      const update = JSON.parse(item.payload) as Update;
      const query = update.callback_query;
      const message = query?.message ?? update.message;
      const actor = query?.from ?? update.message?.from;
      if (!actor || !message || message.chat.type !== 'private' || message.chat.id !== actor.id || actor.is_bot) {
        await s.complete(updateId, []);
        return;
      }
      const owner = s.admins().has(actor.id);
      await s.sql(`INSERT INTO users(id, username, first_name, is_admin, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
        username = excluded.username, first_name = excluded.first_name,
        is_admin = CASE WHEN ? = 1 THEN 1 ELSE users.is_admin END`,
      actor.id, (actor.username ?? '').slice(0, 64), (actor.first_name ?? '').slice(0, 100),
      Number(owner), Number(owner), s.now, Number(owner)).run();
      const user = (await s.user(actor.id))!;
      const actions: D1PreparedStatement[] = [];
      const reply = (text: string, keyboard?: Keyboard) => actions.push(s.reply(`update:${updateId}:reply`, user.id, text, keyboard, query ? message.message_id : undefined));

      if (query) {
        actions.push(s.outgoing(`update:${updateId}:ack`, user.id, 'answerCallbackQuery', { callback_query_id: query.id }));
        const data = query.data ?? '';
        if (data.startsWith('admin_') || data.startsWith('user_')) {
          if (!user.is_admin) reply('This command is not available.');
          else if (data === 'admin_stats') reply(await this.stats(), back);
          else if (data === 'admin_logs') reply(await this.logs(), back);
          else if (data === 'admin_exit') this.exitAdmin(user, actions, reply);
          else if (data === 'user_make_admin' || data === 'user_remove_admin') {
            actions.push(s.sql('UPDATE users SET pending_action = ?, pending_until = ? WHERE id = ?', data, s.now + 600_000, user.id));
            reply('Send the numeric user ID to ' + (data === 'user_make_admin' ? 'promote.' : 'demote.') + '\nUse /id to find an ID, or /cancel to cancel.',
              { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin_users_return' }]] });
          } else if (['admin_users', 'admin_users_return', 'user_refresh'].includes(data) || /^admin_users:\d+$/.test(data)) {
            actions.push(s.sql('UPDATE users SET pending_action = NULL, pending_until = NULL WHERE id = ?', user.id));
            const page = Math.min(Number(data.split(':')[1] ?? 0), 100_000);
            const view = await this.users(page); reply(view.text, view.keyboard);
          } else if (data === 'admin_back') {
            actions.push(s.sql('UPDATE users SET pending_action = NULL, pending_until = NULL WHERE id = ?', user.id));
            reply(adminText, adminKeyboard);
          }
        } else if (data.startsWith('r|')) {
          await this.answer(update, user, actions, reply);
        } else reply('این دکمه قدیمی است. لطفاً /start را بفرست.');
      } else {
        const text = message.text?.trim() ?? '';
        const [rawCommand = '', target = ''] = text.split(/\s+/);
        const command = rawCommand.split('@')[0]!.toLowerCase();
        if (command === '/id') reply(`Your Telegram user ID: ${user.id}`);
        else if (command === '/start') {
          actions.push(s.sql('UPDATE users SET active = 1, pending_action = NULL, pending_until = NULL WHERE id = ?', user.id));
          if (user.is_admin) reply(adminText, adminKeyboard);
          else {
            reply(welcome);
            const date = localTime(s.now, s.env.TIMEZONE).date;
            actions.push(...s.question(`u:${updateId}`, user.id, date, currentPeriod(s.now, s.env.TIMEZONE)));
          }
        } else if (command === '/stop') {
          actions.push(s.sql('UPDATE users SET active = 0, pending_action = NULL, pending_until = NULL WHERE id = ?', user.id),
            s.sql('DELETE FROM reminders WHERE user_id = ?', user.id),
            s.sql("UPDATE outbox SET failed_at = ?, last_error = 'stopped' WHERE chat_id = ? AND sent_at IS NULL AND prompt_id IS NOT NULL", s.now, user.id));
          reply(stopped);
        } else if (command === '/help') reply('شروع یادآوری‌ها: /start\nتوقف: /stop\nشناسهٔ شما: /id\n\nروزانه ساعت ۱۴ (یک قرص) و ۲۲ (دو قرص)، به وقت تهران.\nبا انتخاب «هنوز نه»، ۱۵ دقیقه بعد دوباره یادآوری می‌کنم.');
        else if (command === '/cancel') {
          actions.push(s.sql('UPDATE users SET pending_action = NULL, pending_until = NULL WHERE id = ?', user.id));
          reply('Cancelled.');
        } else if (['/admin', '/stats', '/logs', '/users', '/promote', '/demote', '/exit'].includes(command)) {
          if (!user.is_admin) reply('This command is not available.');
          else if (command === '/stats') reply(await this.stats(), back);
          else if (command === '/logs') reply(await this.logs(), back);
          else if (command === '/users') { const view = await this.users(); reply(view.text, view.keyboard); }
          else if (command === '/exit') this.exitAdmin(user, actions, reply);
          else if (command === '/promote' || command === '/demote') await this.changeAdmin(target, command === '/promote', user, actions, reply);
          else reply(adminText, adminKeyboard);
        } else if (user.is_admin && user.pending_action && (user.pending_until ?? 0) > s.now) {
          await this.changeAdmin(text, user.pending_action === 'user_make_admin', user, actions, reply);
        } else if (text) reply('برای شروع /start، برای توقف /stop و برای دیدن شناسه /id را بفرست.');
      }
      await s.complete(updateId, actions);
    } catch (error) {
      await s.sql('UPDATE inbox SET locked_until = ? WHERE update_id = ? AND processed_at IS NULL', s.now + 60_000, updateId).run();
      throw error;
    }
  }

  private async answer(update: Update, user: User, actions: D1PreparedStatement[], reply: (text: string) => void) {
    const s = this.store;
    const [, promptId, value] = update.callback_query!.data!.split('|');
    const prompt = promptId ? await s.prompt(promptId) : null;
    const today = localTime(s.now, s.env.TIMEZONE).date;
    if (!prompt || !['yes', 'no'].includes(value ?? '') || prompt.user_id !== user.id || prompt.date !== today || !user.active || user.is_admin) {
      reply('این یادآوری فعال نیست. برای شروع دوباره /start را بفرست.'); return;
    }
    const completed = await s.sql("SELECT id FROM prompts WHERE series_id = ? AND answer = 'yes' LIMIT 1", prompt.series_id).first();
    if (prompt.answer || completed) { reply('پاسخت قبلاً ثبت شده است. 💚'); return; }
    // Conditional writes in one D1 transaction make concurrent/retried button taps harmless.
    actions.push(s.sql(`UPDATE prompts SET answer = ?, answer_update_id = ?, answered_at = ? WHERE id = ? AND answer IS NULL
      AND NOT EXISTS (SELECT 1 FROM prompts WHERE series_id = ? AND answer = 'yes')`,
    value!, update.update_id, s.now, prompt.id, prompt.series_id));
    if (value === 'no') {
      actions.push(s.sql(`INSERT INTO reminders(user_id, date, period, due_at, source_update_id)
        SELECT user_id, date, period, ?, ? FROM prompts WHERE id = ? AND answer_update_id = ?
        ON CONFLICT(user_id, date, period) DO UPDATE SET due_at = excluded.due_at, source_update_id = excluded.source_update_id`,
      s.now + 900_000, update.update_id, prompt.id, update.update_id));
    } else {
      actions.push(s.sql(`DELETE FROM reminders WHERE user_id = ? AND date = ? AND period = ?
        AND source_update_id IN (SELECT answer_update_id FROM prompts WHERE series_id = ?)`, user.id, today, prompt.period, prompt.series_id),
        s.sql(`UPDATE outbox SET failed_at = ?, last_error = 'dose_confirmed' WHERE sent_at IS NULL AND prompt_id IN
          (SELECT id FROM prompts WHERE series_id = ?)`, s.now, prompt.series_id));
      const admins = await s.sql('SELECT id FROM users WHERE is_admin = 1 AND active = 1').all<{ id: number }>();
      const label = user.username ? `@${user.username}` : user.first_name || `User ${user.id}`;
      const text = `${label} confirmed taking ${prompt.period === 'afternoon' ? '1 pill (2 p.m.)' : '2 pills (10 p.m.)'}.\nDate: ${today} (Tehran)\nUser ID: ${user.id}`;
      for (const admin of admins.results) {
        actions.push(s.sql(`INSERT OR IGNORE INTO outbox(id, chat_id, method, payload, created_at, due_at)
          SELECT ?, ?, 'sendMessage', ?, ?, ? FROM prompts WHERE id = ? AND answer_update_id = ?`,
        `notify:${update.update_id}:${admin.id}`, admin.id, JSON.stringify({ chat_id: admin.id, text }), s.now, s.now, prompt.id, update.update_id));
      }
    }
    actions.push(s.sql(`INSERT OR IGNORE INTO outbox(id, chat_id, method, payload, created_at, due_at)
      SELECT ?, ?, 'editMessageText', ?, ?, ? FROM prompts WHERE id = ? AND answer_update_id = ?`,
    `update:${update.update_id}:reply`, user.id, JSON.stringify({ chat_id: user.id, message_id: update.callback_query!.message!.message_id,
      text: value === 'yes' ? thanks : snoozed, reply_markup: { inline_keyboard: [] } }), s.now, s.now, prompt.id, update.update_id));
  }

  private exitAdmin(user: User, actions: D1PreparedStatement[], reply: (text: string) => void) {
    const s = this.store;
    actions.push(s.sql('UPDATE users SET pending_action = NULL, pending_until = NULL WHERE id = ?', user.id));
    if (s.admins().has(user.id)) reply('Admin panel closed. Your configured owner access is preserved. Use /admin to reopen it.');
    else {
      actions.push(s.sql('UPDATE users SET is_admin = 0, active = 1 WHERE id = ?', user.id));
      reply('You are now a regular user and will receive daily reminders. Use /start to continue.');
    }
  }

  private async changeAdmin(target: string, promote: boolean, actor: User, actions: D1PreparedStatement[], reply: (text: string) => void) {
    const s = this.store;
    const id = Number(target);
    if (!/^\d+$/.test(target) || !Number.isSafeInteger(id) || id <= 0) { reply('Send a numeric Telegram user ID, or /cancel.'); return; }
    if (!promote && s.admins().has(id)) { reply('Configured owners cannot be removed here. Update ADMIN_IDS in Cloudflare to change ownership.'); return; }
    if (!await s.user(id)) { reply('That user needs to send /start or /id to this bot first.'); return; }
    actions.push(s.sql('UPDATE users SET is_admin = ?, active = 1, pending_action = NULL, pending_until = NULL WHERE id = ?', Number(promote), id),
      s.sql('UPDATE users SET pending_action = NULL, pending_until = NULL WHERE id = ?', actor.id));
    if (promote) actions.push(s.sql('DELETE FROM reminders WHERE user_id = ?', id));
    reply(`User ${id} is now ${promote ? 'an admin' : 'a regular user'}.`);
  }

  async stats(date = localTime(this.store.now, this.store.env.TIMEZONE).date) {
    const rows = await this.store.sql(`SELECT period, COUNT(*) AS total, SUM(answer = 'yes') AS yes, SUM(answer = 'no') AS no
      FROM prompts WHERE date = ? AND answer IS NOT NULL GROUP BY period`, date).all<{ period: string; total: number; yes: number; no: number }>();
    let text = `📊 Responses — ${date} (Tehran)\n`;
    for (const slot of SCHEDULE) {
      const row = rows.results.find(r => r.period === slot.period);
      text += `\n${slot.label}\nYes: ${row?.yes ?? 0} | Not yet: ${row?.no ?? 0} | Total: ${row?.total ?? 0}\n`;
    }
    const users = await this.store.sql(`SELECT u.id, u.username, u.first_name, SUM(p.answer = 'yes') AS yes, SUM(p.answer = 'no') AS no
      FROM prompts p JOIN users u ON u.id = p.user_id WHERE p.date = ? AND p.answer IS NOT NULL
      GROUP BY u.id ORDER BY u.id LIMIT 20`, date).all<User & { yes: number; no: number }>();
    if (users.results.length) text += '\nUsers (up to 20):\n' + users.results.map(u => `${u.username ? '@' + u.username : u.id}: ${u.yes} yes, ${u.no} not yet`).join('\n');
    return text;
  }

  async logs() {
    const rows = await this.store.sql(`SELECT date, period, SUM(answer = 'yes') AS yes, SUM(answer = 'no') AS no
      FROM prompts WHERE answer IS NOT NULL AND date IN (SELECT DISTINCT date FROM prompts WHERE answer IS NOT NULL ORDER BY date DESC LIMIT 10)
      GROUP BY date, period ORDER BY date DESC, period`).all<{ date: string; period: string; yes: number; no: number }>();
    return rows.results.length ? '📝 Recent response logs (Tehran)\n\n' + rows.results.map(r => `${r.date} · ${r.period === 'afternoon' ? '2 p.m.' : '10 p.m.'}\nYes: ${r.yes} | Not yet: ${r.no}`).join('\n\n') : 'No responses logged yet.';
  }

  async users(page = 0) {
    const s = this.store;
    const count = await s.sql('SELECT COUNT(*) AS total, COALESCE(SUM(is_admin), 0) AS admins FROM users').first<{ total: number; admins: number }>();
    const rows = await s.sql('SELECT * FROM users ORDER BY is_admin DESC, id LIMIT 15 OFFSET ?', page * 15).all<User>();
    const text = `👥 Users — ${count!.total} total, ${count!.admins} admins\nPage ${page + 1}\n\n` + rows.results.map(u =>
      `${u.is_admin ? 'Admin' : u.active ? 'Active' : 'Paused'} · ${u.username ? '@' + u.username : u.first_name || 'User'}\nID: ${u.id}`).join('\n\n');
    const keyboard: Keyboard = { inline_keyboard: [
      [{ text: '+ Make admin', callback_data: 'user_make_admin' }, { text: '− Remove admin', callback_data: 'user_remove_admin' }],
      [{ text: '🔄 Refresh', callback_data: `admin_users:${page}` }, { text: '⬅️ Back', callback_data: 'admin_back' }],
    ] };
    const navigation = [];
    if (page > 0) navigation.push({ text: 'Previous', callback_data: `admin_users:${page - 1}` });
    if ((page + 1) * 15 < count!.total) navigation.push({ text: 'Next', callback_data: `admin_users:${page + 1}` });
    if (navigation.length) keyboard.inline_keyboard.push(navigation);
    return { text, keyboard };
  }
}
