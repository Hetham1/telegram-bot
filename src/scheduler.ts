import { Bot } from './bot';
import { drainOutbox } from './delivery';
import { Store } from './store';
import { Telegram } from './telegram';
import { localTime } from './time';
import type { Schedule } from './types';

export async function runScheduler(store: Store, telegram: Telegram) {
  const pending = await store.sql(`SELECT update_id FROM inbox WHERE processed_at IS NULL AND locked_until <= ? AND attempts < 10
    ORDER BY update_id LIMIT 10`, store.now).all<{ update_id: number }>();
  for (const item of pending.results) {
    try { await new Bot(store).process(item.update_id); }
    catch { console.error('update_retry_failed', { update_id: item.update_id }); }
  }

  // Covers subscribers created by the previous deployment during migration.
  const uninitialized = await store.sql('SELECT id FROM users WHERE schedule_initialized = 0 ORDER BY id LIMIT 10').all<{ id: number }>();
  for (const user of uninitialized.results) await store.ensureSchedules(user.id);

  const local = localTime(store.now, store.env.TIMEZONE);
  await store.sql('DELETE FROM reminders WHERE date < ?', local.date).run();
  const minute = local.hour * 60 + local.minute;
  const slots = await store.sql(`SELECT s.* FROM schedules s JOIN users u ON u.id = s.user_id
    WHERE u.active = 1 AND u.is_admin = 0 AND s.enabled = 1 AND s.deleted = 0 AND s.effective_date <= ?
    AND s.time_minutes <= ? AND s.time_minutes > ?
    AND NOT EXISTS (SELECT 1 FROM prompts WHERE id = 'd:' || ? || ':' || s.key || ':' || s.user_id)
    ORDER BY s.time_minutes, s.user_id, s.key LIMIT 25`, local.date, minute, minute - 30, local.date).all<Schedule>();
  if (slots.results.length) await store.env.DB.batch(slots.results.flatMap(slot =>
    store.question(`d:${local.date}:${slot.key}:${slot.user_id}`, slot.user_id, local.date, slot, true)));

  const reminders = await store.sql(`SELECT r.*, p.series_id, p.schedule_revision FROM reminders r JOIN users u ON u.id = r.user_id
    JOIN prompts p ON p.answer_update_id = r.source_update_id
    WHERE r.due_at <= ? AND r.date = ? AND u.active = 1 AND u.is_admin = 0 ORDER BY r.due_at LIMIT 25`,
    store.now, local.date).all<{ user_id: number; date: string; period: string; source_update_id: number; series_id: string; schedule_revision: number }>();
  for (const reminder of reminders.results) {
    const slot = await store.schedule(reminder.user_id, reminder.period);
    await store.env.DB.batch([
      ...(slot?.enabled && slot.revision === reminder.schedule_revision ?
        store.question(`s:${reminder.source_update_id}`, reminder.user_id, reminder.date, slot, false, reminder.source_update_id, reminder.series_id) : []),
      store.sql('DELETE FROM reminders WHERE user_id = ? AND date = ? AND period = ? AND source_update_id = ?',
        reminder.user_id, reminder.date, reminder.period, reminder.source_update_id),
    ]);
  }
  await drainOutbox(store, telegram);

  if (local.hour === 3 && local.minute === 0) {
    const cutoff = store.now - 7 * 86_400_000;
    await store.env.DB.batch([
      store.sql('DELETE FROM inbox WHERE processed_at < ?', cutoff),
      store.sql('DELETE FROM outbox WHERE sent_at < ? OR failed_at < ?', cutoff, cutoff),
      store.sql('DELETE FROM schedule_edits WHERE expires_at < ?', store.now),
    ]);
  }
}
