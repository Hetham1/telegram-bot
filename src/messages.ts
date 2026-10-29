import type { Keyboard, Period } from './types';

export const welcome = 'من اینجام تا بهت یادآوری کنم قرص‌هات رو بخوری! 💊\nهر روز ساعت 2 برای اسنترا و ساعت 10 برای اون دوتای دیگه،';
export const thanks = 'عالیه! 🎉\nممنون که قرص‌هات رو خوردی. مراقب خودت باش! 💚\n\nگل برای گل 🌸';
export const snoozed = 'اشکالی نداره! 😊\n۱۵ دقیقه دیگه دوباره ازت می‌پرسم...';
export const stopped = 'یادآوری‌ها متوقف شدند. برای شروع دوباره /start را بفرست.';

export function question(period: Period) {
  return period === 'afternoon'
    ? 'عصر بخیر ثارینا! ☀️\nساعت 2 عه؛ اسنترا رو خوردی؟ 💊'
    : 'شب بخیر ثارینا! 🌙\nساعت 10 عه؛ اون دوتا رو خوردی؟ 💊💊';
}
export function reminderQuestion(period: Period) {
  return period === 'afternoon' ? 'اسنترا رو خوردی؟ 💊' : 'اون دوتا رو خوردی؟ 💊💊';
}
export function questionKeyboard(id: string): Keyboard {
  return { inline_keyboard: [[
    { text: 'اله، خولدم! ✅', callback_data: `r|${id}|yes` },
    { text: 'هنوز نه 😅', callback_data: `r|${id}|no` },
  ]] };
}
export const back: Keyboard = { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin_back' }]] };
export const adminKeyboard: Keyboard = { inline_keyboard: [
  [{ text: '📊 Statistics', callback_data: 'admin_stats' }, { text: '📝 Logs', callback_data: 'admin_logs' }],
  [{ text: '👥 Manage users', callback_data: 'admin_users' }],
  [{ text: '🚪 Exit admin', callback_data: 'admin_exit' }],
] };
export const adminText = 'Admin panel\n\n/stats — Today’s responses\n/logs — Recent dates\n/users — Manage users\n/promote <id> — Grant admin access\n/demote <id> — Remove admin access\n/cancel — Cancel a pending action\n/exit — Exit admin\n\nDaily reminders: 2 p.m. (1 pill) and 10 p.m. (2 pills), Tehran time.\nAdmins do not receive pill reminders.';
