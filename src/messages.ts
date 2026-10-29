import type { Keyboard, Schedule } from './types';
import { clockText } from './time';

export const welcome = 'من اینجام تا بهت یادآوری کنم قرص‌هات رو بخوری! 💊\nهر روز ساعت 2 PM برای اسنترا و ساعت 10 PM برای اون دوتای دیگه،';
export const thanks = 'عالیه! 🎉\nممنون که قرص‌هات رو خوردی. مراقب خودت باش! 💚\n\nگل برای گل 🌸';
export const snoozed = 'اشکالی نداره! 😊\n۱۵ دقیقه دیگه دوباره ازت می‌پرسم...';
export const stopped = 'یادآوری‌ها متوقف شدند. برای شروع دوباره /start را بفرست.';

export function question(slot: Pick<Schedule, 'key' | 'time_minutes' | 'pills'>) {
  if (slot.key === 'afternoon' && slot.time_minutes === 840 && slot.pills === 'اسنترا') {
    return 'عصر بخیر ثارینا! ☀️\nساعت 2 PM عه؛ اسنترا رو خوردی؟ 💊';
  }
  if (slot.key === 'evening' && slot.time_minutes === 1320 && slot.pills === 'اون دوتا') {
    return 'شب بخیر ثارینا! 🌙\nساعت 10 PM عه؛ اون دوتا رو خوردی؟ 💊💊';
  }
  const greeting = slot.time_minutes < 720 ? 'صبح بخیر ثارینا! ☀️' :
    slot.time_minutes < 1080 ? 'عصر بخیر ثارینا! ☀️' : 'شب بخیر ثارینا! 🌙';
  return `${greeting}\nساعت ${clockText(slot.time_minutes)} عه؛ ${reminderQuestion(slot)}`;
}
export function reminderQuestion(slot: Pick<Schedule, 'pills'>) {
  return slot.pills.includes('\n') ? `قرص‌های این نوبت رو خوردی؟ 💊\n${slot.pills.split('\n').map(pill => `• ${pill}`).join('\n')}` :
    `${slot.pills} رو خوردی؟ ${slot.pills === 'اون دوتا' ? '💊💊' : '💊'}`;
}
export const scheduleKeyboard: Keyboard = { inline_keyboard: [[{ text: '💊 قرص‌ها و ساعت‌ها', callback_data: 'cfg|menu' }]] };
export const scheduleGuide = 'تغییر قرص‌ها و ساعت‌ها: /schedule';
export function welcomeMessage(slots: Schedule[]) {
  const active = slots.filter(slot => slot.enabled);
  if (active.length === 2 && active.some(s => s.key === 'afternoon' && s.time_minutes === 840 && s.pills === 'اسنترا') &&
      active.some(s => s.key === 'evening' && s.time_minutes === 1320 && s.pills === 'اون دوتا')) return welcome;
  return `من اینجام تا بهت یادآوری کنم قرص‌هات رو بخوری! 💊\n${active.length ?
    active.map(slot => `${clockText(slot.time_minutes)} — ${shortPills(slot.pills)}`).join('\n') : 'فعلاً یادآوری فعالی نداری.'}`;
}
export function shortPills(pills: string, length = 50) {
  const chars = Array.from(pills.replace(/\n/g, '، '));
  return chars.length <= length ? chars.join('') : chars.slice(0, length - 1).join('') + '…';
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
export const adminText = 'Admin panel\n\n/stats — Today’s responses\n/logs — Recent dates\n/users — Manage users\n/promote <id> — Grant admin access\n/demote <id> — Remove admin access\n/cancel — Cancel a pending action\n/exit — Exit admin\n\nUsers manage their own pills and daily times with /schedule (Tehran time).\nAdmins do not receive pill reminders.';
