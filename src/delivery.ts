import { Store } from './store';
import { Telegram, TelegramError } from './telegram';
import { localTime } from './time';
import type { Outgoing } from './types';

export async function drainOutbox(store: Store, telegram: Telegram, limit = 20) {
  const deadline = Date.now() + 20_000;
  for (let i = 0; i < limit && Date.now() < deadline; i++) {
    const item = await store.sql(`UPDATE outbox SET locked_until = ?, attempts = attempts + 1
      WHERE id = (SELECT id FROM outbox WHERE sent_at IS NULL AND failed_at IS NULL AND due_at <= ? AND locked_until <= ?
        ORDER BY CASE WHEN method = 'answerCallbackQuery' THEN 0 ELSE 1 END, created_at, rowid LIMIT 1)
      RETURNING *`, store.now + 60_000, store.now, store.now).first<Outgoing>();
    if (!item) break;
    if (item.prompt_id) {
      const prompt = await store.prompt(item.prompt_id);
      const user = await store.user(item.chat_id);
      const yes = prompt ? await store.sql("SELECT id FROM prompts WHERE user_id = ? AND date = ? AND period = ? AND answer = 'yes' LIMIT 1",
        item.chat_id, prompt.date, prompt.period).first() : null;
      if (!prompt || prompt.answer || prompt.date !== localTime(store.now, store.env.TIMEZONE).date || !user?.active || user.is_admin || yes) {
        await fail(store, item, 'inactive_prompt'); continue;
      }
    }
    if (item.id.startsWith('notify:')) {
      const admin = await store.user(item.chat_id);
      if (!admin?.is_admin || !admin.active) { await fail(store, item, 'inactive_admin'); continue; }
    }
    try {
      await telegram.call(item.method, JSON.parse(item.payload));
      await store.sql('UPDATE outbox SET sent_at = ?, locked_until = 0, last_error = NULL WHERE id = ?', store.now, item.id).run();
    } catch (error) {
      const failure = error instanceof TelegramError ? error : new TelegramError(503);
      if (failure.unchanged) {
        await store.sql('UPDATE outbox SET sent_at = ?, locked_until = 0 WHERE id = ?', store.now, item.id).run();
      } else if (failure.code === 403) {
        await store.env.DB.batch([
          store.sql('UPDATE users SET active = 0 WHERE id = ?', item.chat_id),
          store.sql('DELETE FROM reminders WHERE user_id = ?', item.chat_id),
          store.sql("UPDATE outbox SET failed_at = ?, last_error = '403', locked_until = 0 WHERE id = ?", store.now, item.id),
        ]);
      } else if (failure.code === 429 || failure.code >= 500) {
        if (item.attempts >= 10) await fail(store, item, String(failure.code));
        else {
          const delay = Math.max(failure.retryAfter * 1000, Math.min(3_600_000, 30_000 * 2 ** (item.attempts - 1)));
          await store.sql('UPDATE outbox SET due_at = ?, locked_until = 0, last_error = ? WHERE id = ?', store.now + delay, String(failure.code), item.id).run();
        }
        // A global Telegram rate limit should delay the rest of this batch too.
        if (failure.code === 429) break;
      } else await fail(store, item, String(failure.code));
    }
  }
}

async function fail(store: Store, item: Outgoing, reason: string) {
  await store.sql('UPDATE outbox SET failed_at = ?, locked_until = 0, last_error = ? WHERE id = ?', store.now, reason, item.id).run();
}
