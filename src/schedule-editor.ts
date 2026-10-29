import { Store } from './store';
import { clockText, effectiveDate, parseTime } from './time';
import { scheduleKeyboard, shortPills } from './messages';
import type { Keyboard, Schedule, ScheduleEdit, User } from './types';

type Reply = (text: string, keyboard?: Keyboard) => void;
const MAX_SLOTS = 12;
const EDIT_TTL = 15 * 60_000;
const timePrompt = '⏰ ساعتشو بفرست، مثلاً 2 PM یا 10:30 PM.';
const pillsPrompt = '💊 قرص‌های این نوبت رو بفرست، هرکدوم تو یه خط.';
const staleText = 'این دکمه قدیمی شده. برنامه رو دوباره باز کن.';

export function parsePills(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length || lines.length > 8 || lines.some(line => line.length > 60 || line.startsWith('/'))) return undefined;
  return lines.join('\n');
}

export class ScheduleEditor {
  constructor(private store: Store) {}

  async menu(user: User, reply: Reply) {
    if (user.is_admin) { reply('این بخش برای دریافت‌کنندهٔ یادآوری‌هاست. برای پنل مدیریت /admin را بفرست.'); return; }
    const slots = await this.store.schedules(user.id);
    const lines = slots.map(slot => `${slot.enabled ? '✅' : '⏸'} ${clockText(slot.time_minutes)} — ${shortPills(slot.pills)}`);
    const keyboard: Keyboard = { inline_keyboard: slots.map(slot => [{
      text: `${slot.enabled ? '⏰' : '⏸'} ${clockText(slot.time_minutes)} · ${shortPills(slot.pills, 35)}`,
      callback_data: `cfg|view|${slot.key}|${slot.revision}`,
    }]) };
    keyboard.inline_keyboard.push([{ text: '➕ یادآوری جدید', callback_data: 'cfg|add' }]);
    reply(`💊 قرص‌ها و ساعت‌ها (تهران)\n\n${lines.join('\n') || 'هنوز یادآوری‌ای نداری.'}` +
      (user.active ? '' : '\n\nبرای شروع /start رو بفرست.'), keyboard);
  }

  private detail(slot: Schedule) {
    return `⏰ هر روز ساعت ${clockText(slot.time_minutes)} (تهران)\n💊 ${slot.pills}\n${slot.enabled ? '✅ فعال' : '⏸ متوقف'}`;
  }

  private show(slot: Schedule, reply: Reply) {
    const suffix = `${slot.key}|${slot.revision}`;
    reply(this.detail(slot), { inline_keyboard: [
      [{ text: '💊 ویرایش قرص‌ها', callback_data: `cfg|pills|${suffix}` }],
      [{ text: '⏰ تغییر ساعت', callback_data: `cfg|time|${suffix}` }],
      [{ text: slot.enabled ? '⏸ توقف این یادآوری' : '▶️ فعال کردن', callback_data: `cfg|toggle|${suffix}` }],
      [{ text: '🗑 حذف یادآوری', callback_data: `cfg|delete|${suffix}` }],
      [{ text: '⬅️ برنامهٔ من', callback_data: 'cfg|menu' }],
    ] });
  }

  clear(userId: number) { return this.store.sql('DELETE FROM schedule_edits WHERE user_id = ?', userId); }

  async callback(user: User, data: string, updateId: number, messageId: number,
    actions: D1PreparedStatement[], reply: Reply) {
    const s = this.store;
    if (user.is_admin) { await this.menu(user, reply); return; }
    const [, action, key = '', version = ''] = data.split('|');
    if (action === 'menu') {
      actions.push(this.clear(user.id)); await this.menu(user, reply); return;
    }
    if (action === 'cancel') {
      actions.push(s.sql('DELETE FROM schedule_edits WHERE user_id = ? AND token = ?', user.id, key));
      reply('ویرایش لغو شد.', scheduleKeyboard); return;
    }
    if (action === 'save') {
      await this.save(user, key, updateId, messageId, actions, reply); return;
    }
    if (action === 'add') {
      if ((await s.schedules(user.id)).length >= MAX_SLOTS) {
        reply('۱۲ تا یادآوری داری. یکی رو ویرایش یا حذف کن.', scheduleKeyboard); return;
      }
      const token = `n${updateId.toString(36)}`;
      this.draft(user.id, token, 'add', token, 0, 'time', null, null, actions);
      reply(timePrompt, this.cancelKeyboard(token)); return;
    }
    const slot = await s.schedule(user.id, key);
    if (!slot || String(slot.revision) !== version) { reply(staleText, scheduleKeyboard); return; }
    if (action === 'view') {
      actions.push(this.clear(user.id)); this.show(slot, reply);
    } else if (action === 'time' || action === 'pills') {
      const token = `e${updateId.toString(36)}`;
      this.draft(user.id, token, action, slot.key, slot.revision, action, slot.time_minutes, slot.pills, actions);
      reply(action === 'time' ? `ساعت فعلی: ${clockText(slot.time_minutes)}\n\n${timePrompt}` :
        `فهرست فعلی:\n${slot.pills}\n\n${pillsPrompt}`, this.cancelKeyboard(token));
    } else if (action === 'delete') {
      reply(`این یادآوری حذف بشه؟\n\n${this.detail(slot)}`, { inline_keyboard: [
        [{ text: '🗑 بله، حذفش کن', callback_data: `cfg|remove|${slot.key}|${slot.revision}` }],
        [{ text: 'نه، نگهش دار', callback_data: `cfg|view|${slot.key}|${slot.revision}` }],
      ] });
    } else if (action === 'remove' || action === 'toggle') {
      this.apply(user, { ...slot, enabled: action === 'remove' ? 0 : Number(!slot.enabled), deleted: Number(action === 'remove') },
        updateId, messageId, actions);
    } else reply(staleText, scheduleKeyboard);
  }

  private draft(userId: number, token: string, action: ScheduleEdit['action'], key: string, revision: number,
    step: ScheduleEdit['step'], time: number | null, pills: string | null, actions: D1PreparedStatement[]) {
    actions.push(this.store.sql(`INSERT INTO schedule_edits(user_id, token, action, schedule_key, base_revision, step, time_minutes, pills, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET token = excluded.token, action = excluded.action,
      schedule_key = excluded.schedule_key, base_revision = excluded.base_revision, step = excluded.step,
      time_minutes = excluded.time_minutes, pills = excluded.pills, expires_at = excluded.expires_at`,
    userId, token, action, key, revision, step, time, pills, this.store.now + EDIT_TTL));
  }

  private cancelKeyboard(token: string): Keyboard {
    return { inline_keyboard: [[{ text: 'انصراف', callback_data: `cfg|cancel|${token}` }]] };
  }

  private async edit(userId: number) {
    return this.store.sql('SELECT * FROM schedule_edits WHERE user_id = ?', userId).first<ScheduleEdit>();
  }

  async text(user: User, text: string, actions: D1PreparedStatement[], reply: Reply): Promise<boolean> {
    const edit = await this.edit(user.id);
    if (!edit || user.is_admin) return false;
    if (edit.expires_at <= this.store.now) {
      actions.push(this.clear(user.id)); reply(staleText, scheduleKeyboard); return true;
    }
    if (edit.step === 'confirm') {
      reply('ذخیره کنم؟', this.confirmKeyboard(edit.token)); return true;
    }
    if (edit.step === 'time') {
      const minutes = parseTime(text);
      if (minutes === undefined) { reply(`ساعت معتبر نیست.\n\n${timePrompt}`, this.cancelKeyboard(edit.token)); return true; }
      if (await this.conflict(user.id, edit.schedule_key, minutes)) {
        reply('این ساعت رو داری. یه ساعت دیگه بفرست، یا قرص‌هاشو از /schedule ویرایش کن.', this.cancelKeyboard(edit.token));
        return true;
      }
      edit.time_minutes = minutes;
      edit.step = edit.action === 'add' ? 'pills' : 'confirm';
    } else {
      const pills = parsePills(text);
      if (!pills) { reply('۱ تا ۸ قرص بنویس، هرکدوم تو یه خط؛ حداکثر ۶۰ حرف در هر خط.', this.cancelKeyboard(edit.token)); return true; }
      edit.pills = pills; edit.step = 'confirm';
    }
    actions.push(this.store.sql(`UPDATE schedule_edits SET time_minutes = ?, pills = ?, step = ?, expires_at = ?
      WHERE user_id = ? AND token = ?`, edit.time_minutes, edit.pills, edit.step, this.store.now + EDIT_TTL, user.id, edit.token));
    if (edit.step === 'pills') reply(pillsPrompt, this.cancelKeyboard(edit.token));
    else reply(`اینو ذخیره کنم؟\n\n⏰ هر روز ساعت ${clockText(edit.time_minutes!)} (تهران)\n💊 ${edit.pills}`,
      this.confirmKeyboard(edit.token));
    return true;
  }

  private confirmKeyboard(token: string): Keyboard {
    return { inline_keyboard: [[{ text: '✅ ذخیره', callback_data: `cfg|save|${token}` },
      { text: 'انصراف', callback_data: `cfg|cancel|${token}` }]] };
  }

  private conflict(userId: number, key: string, time: number) {
    return this.store.sql('SELECT key FROM schedules WHERE user_id = ? AND key != ? AND time_minutes = ? AND deleted = 0',
      userId, key, time).first();
  }

  private async save(user: User, token: string, updateId: number, messageId: number,
    actions: D1PreparedStatement[], reply: Reply) {
    const edit = await this.edit(user.id);
    if (!edit || edit.token !== token || edit.step !== 'confirm' || edit.expires_at <= this.store.now ||
        edit.time_minutes === null || !edit.pills) { reply(staleText, scheduleKeyboard); return; }
    const slot = await this.store.schedule(user.id, edit.schedule_key);
    if (edit.action !== 'add' && (!slot || slot.revision !== edit.base_revision)) {
      actions.push(this.clear(user.id)); reply(staleText, scheduleKeyboard); return;
    }
    if (await this.conflict(user.id, edit.schedule_key, edit.time_minutes)) {
      reply('این ساعت رو داری. قرص‌هاشو از /schedule ویرایش کن.', scheduleKeyboard); return;
    }
    if (edit.action === 'add' && (await this.store.schedules(user.id)).length >= MAX_SLOTS) {
      reply('حداکثر ۱۲ یادآوری می‌تونی داشته باشی.', scheduleKeyboard); return;
    }
    this.apply(user, { user_id: user.id, key: edit.schedule_key, time_minutes: edit.time_minutes, pills: edit.pills,
      enabled: slot?.enabled ?? 1, deleted: 0, revision: edit.base_revision, effective_date: '' }, updateId, messageId, actions, edit);
  }

  private apply(user: User, slot: Schedule, updateId: number, messageId: number,
    actions: D1PreparedStatement[], edit?: ScheduleEdit) {
    const s = this.store;
    const effective = effectiveDate(s.now, slot.time_minutes, s.env.TIMEZONE);
    const draftGuard = edit ? ` AND EXISTS (SELECT 1 FROM schedule_edits WHERE user_id = ? AND token = ? AND step = 'confirm' AND expires_at > ?)` : '';
    const draftParams = edit ? [user.id, edit.token, s.now] : [];
    if (edit?.action === 'add') {
      actions.push(s.sql(`INSERT OR IGNORE INTO schedules(user_id, key, time_minutes, pills, enabled, deleted, revision, effective_date, last_update_id)
        SELECT ?, ?, ?, ?, 1, 0, 1, ?, ? WHERE (SELECT COUNT(*) FROM schedules WHERE user_id = ? AND deleted = 0) < ?${draftGuard}`,
      user.id, slot.key, slot.time_minutes, slot.pills, effective, updateId, user.id, MAX_SLOTS, ...draftParams));
    } else {
      actions.push(s.sql(`UPDATE schedules SET time_minutes = ?, pills = ?, enabled = ?, deleted = ?, revision = revision + 1,
        effective_date = ?, last_update_id = ? WHERE user_id = ? AND key = ? AND revision = ? AND deleted = 0${draftGuard}`,
      slot.time_minutes, slot.pills, slot.enabled, slot.deleted, effective, updateId, user.id, slot.key, slot.revision, ...draftParams));
    }
    const applied = 'EXISTS (SELECT 1 FROM schedules WHERE user_id = ? AND key = ? AND last_update_id = ?)';
    const appliedParams = [user.id, slot.key, updateId];
    actions.push(
      s.sql(`UPDATE prompts SET canceled_at = ? WHERE user_id = ? AND COALESCE(schedule_key, period) = ? AND answer IS NULL AND ${applied}`,
        s.now, user.id, slot.key, ...appliedParams),
      s.sql(`DELETE FROM reminders WHERE user_id = ? AND period = ? AND ${applied}`, user.id, slot.key, ...appliedParams),
      s.sql(`UPDATE outbox SET failed_at = ?, last_error = 'schedule_changed' WHERE sent_at IS NULL AND method = 'sendMessage'
        AND prompt_id IN (SELECT id FROM prompts WHERE user_id = ? AND COALESCE(schedule_key, period) = ?) AND ${applied}`,
      s.now, user.id, slot.key, ...appliedParams),
    );
    if (edit) actions.push(s.sql('DELETE FROM schedule_edits WHERE user_id = ? AND token = ?', user.id, edit.token));
    const success = slot.deleted ? 'حذف شد 🗑' : `ذخیره شد ✅\n\n${this.detail(slot)}`;
    const payload = { chat_id: user.id, message_id: messageId, reply_markup: scheduleKeyboard };
    actions.push(
      s.outgoing(`update:${updateId}:saved`, user.id, 'editMessageText', {
        ...payload, text: success + (!user.active && !slot.deleted ? '\nبرای دریافت یادآوری‌ها /start را بفرست.' : ''),
      }, null, applied, appliedParams),
      s.outgoing(`update:${updateId}:stale`, user.id, 'editMessageText', { ...payload, text: staleText }, null, `NOT ${applied}`, appliedParams),
    );
  }
}
