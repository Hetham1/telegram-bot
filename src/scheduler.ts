import { Bot } from './bot';
import { drainOutbox } from './delivery';
import { Store } from './store';
import { Telegram } from './telegram';
import { localTime, scheduledPeriod } from './time';
import type { Period } from './types';

export async function runScheduler(store: Store, telegram: Telegram) {
  const pending = await store.sql(`SELECT update_id FROM inbox WHERE processed_at IS NULL AND locked_until <= ? AND attempts < 10
    ORDER BY update_id LIMIT 10`, store.now).all<{ update_id: number }>();
  for (const item of pending.results) {
    try { await new Bot(store).process(item.update_id); }
    catch { console.error('update_retry_failed', { update_id: item.update_id }); }
  }

  const local = localTime(store.now, store.env.TIMEZONE);
  await store.sql('DELETE FROM reminders WHERE date < ?', local.date).run();
  const period = scheduledPeriod(store.now, store.env.TIMEZONE);
  if (period) {
    const users = await store.sql(`SELECT id FROM users WHERE active = 1 AND is_admin = 0
      AND NOT EXISTS (SELECT 1 FROM prompts WHERE id = 'd:' || ? || ':' || ? || ':' || users.id)
      AND NOT EXISTS (SELECT 1 FROM prompts WHERE user_id = users.id AND date = ? AND period = ? AND answer = 'yes')
      ORDER BY id LIMIT 25`, local.date, period, local.date, period).all<{ id: number }>();
    if (users.results.length) await store.env.DB.batch(users.results.flatMap(user =>
      store.question(`d:${local.date}:${period}:${user.id}`, user.id, local.date, period, true)));
  }

  const reminders = await store.sql(`SELECT r.* FROM reminders r JOIN users u ON u.id = r.user_id
    WHERE r.due_at <= ? AND r.date = ? AND u.active = 1 AND u.is_admin = 0 ORDER BY r.due_at LIMIT 25`,
  store.now, local.date).all<{ user_id: number; date: string; period: Period; source_update_id: number }>();
  for (const reminder of reminders.results) {
    await store.env.DB.batch([
      ...store.question(`s:${reminder.source_update_id}`, reminder.user_id, reminder.date, reminder.period, false, reminder.source_update_id),
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
    ]);
  }
}
