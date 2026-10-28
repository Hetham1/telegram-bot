import type { Period } from './types';

export const SCHEDULE = [
  { period: 'afternoon' as const, hour: 14, pills: 1, label: '2 p.m. — 1 pill' },
  { period: 'evening' as const, hour: 22, pills: 2, label: '10 p.m. — 2 pills' },
];

export function localTime(timestamp: number, timeZone = 'Asia/Tehran') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const get = (name: string) => parts.find(p => p.type === name)!.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), minute: Number(get('minute')) };
}

export function currentPeriod(timestamp: number, timeZone?: string): Period {
  return localTime(timestamp, timeZone).hour >= 22 ? 'evening' : 'afternoon';
}

// A short catch-up window tolerates delayed/repeated cron delivery without late-night reminders.
export function scheduledPeriod(timestamp: number, timeZone?: string): Period | undefined {
  const { hour, minute } = localTime(timestamp, timeZone);
  return minute < 30 ? SCHEDULE.find(s => s.hour === hour)?.period : undefined;
}
