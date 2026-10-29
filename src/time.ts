export function localTime(timestamp: number, timeZone = 'Asia/Tehran') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const get = (name: string) => parts.find(p => p.type === name)!.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), minute: Number(get('minute')) };
}

export function clockText(minutes: number) {
  const hour = Math.floor(minutes / 60);
  return `${hour % 12 || 12}${minutes % 60 ? ':' + String(minutes % 60).padStart(2, '0') : ''} ${hour < 12 ? 'AM' : 'PM'}`;
}

export function parseTime(value: string): number | undefined {
  const normalized = value.trim().replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
  const twelveHour = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i.exec(normalized);
  if (twelveHour) {
    const hour = Number(twelveHour[1]), minute = Number(twelveHour[2] ?? 0);
    if (hour < 1 || hour > 12 || minute > 59) return undefined;
    return (hour % 12 + (twelveHour[3]!.toUpperCase() === 'PM' ? 12 : 0)) * 60 + minute;
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(normalized);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
}

// Editing a time that has already passed takes effect tomorrow, not as a late dose today.
export function effectiveDate(timestamp: number, minutes: number, timeZone?: string) {
  const local = localTime(timestamp, timeZone);
  return minutes >= local.hour * 60 + local.minute ? local.date :
    new Date(Date.parse(`${local.date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}
