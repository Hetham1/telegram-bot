import { Bot } from './bot';
import { drainOutbox } from './delivery';
import { runScheduler } from './scheduler';
import { Store } from './store';
import { Telegram } from './telegram';
import type { Env, Fetcher, Update } from './types';

const MAX_BODY_BYTES = 256 * 1024;

export async function handleRequest(request: Request, env: Env, fetcher: Fetcher = fetch, now = Date.now()): Promise<Response> {
  const path = new URL(request.url).pathname;
  if ((path === '/' || path === '/health') && request.method === 'GET') {
    try {
      await env.DB.prepare('SELECT update_id FROM inbox LIMIT 1').all();
      const configured = Boolean(env.BOT_TOKEN && env.WEBHOOK_SECRET);
      return Response.json({ service: 'saripill-telegram-bot', status: configured ? 'ok' : 'setup_required',
        timezone: env.TIMEZONE ?? 'Asia/Tehran', reminders: [{ time: '14:00', pills: 1 }, { time: '22:00', pills: 2 }] },
      { status: configured ? 200 : 503, headers: { 'cache-control': 'no-store' } });
    } catch { return Response.json({ status: 'unavailable' }, { status: 503 }); }
  }
  if (path !== '/webhook') return new Response('Not found', { status: 404 });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET) return new Response('Setup required', { status: 503 });
  if (!await secretMatches(request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '', env.WEBHOOK_SECRET)) {
    return new Response('Unauthorized', { status: 401 });
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return new Response('Expected JSON', { status: 415 });
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) return new Response('Payload too large', { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) return new Response('Invalid update', { status: 400 });
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.length;
    if (length > MAX_BODY_BYTES) { await reader.cancel(); return new Response('Payload too large', { status: 413 }); }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let update: Update;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isUpdate(value)) return new Response('Invalid update', { status: 400 });
    update = value;
  } catch { return new Response('Invalid JSON', { status: 400 }); }

  const store = new Store(env, now);
  try {
    await store.sql('INSERT OR IGNORE INTO inbox(update_id, payload, created_at) VALUES (?, ?, ?)', update.update_id, JSON.stringify(update), now).run();
  } catch { return new Response('Please retry', { status: 503 }); }
  try {
    await new Bot(store).process(update.update_id);
    await drainOutbox(store, new Telegram(env.BOT_TOKEN, fetcher));
  } catch {
    // The update is durably saved; cron retries processing even after Telegram receives 200.
    console.error('update_deferred', { update_id: update.update_id });
  }
  return new Response('OK');
}

async function secretMatches(received: string, expected: string) {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([received, expected].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const first = new Uint8Array(a!), second = new Uint8Array(b!);
  let difference = 0;
  for (let i = 0; i < first.length; i++) difference |= first[i]! ^ second[i]!;
  return difference === 0;
}

function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function isUser(value: unknown) { return isObject(value) && Number.isSafeInteger(value.id) && Number(value.id) > 0 &&
  (value.username === undefined || typeof value.username === 'string') && (value.first_name === undefined || typeof value.first_name === 'string'); }
function isMessage(value: unknown) {
  return isObject(value) && Number.isSafeInteger(value.message_id) && isObject(value.chat) && Number.isSafeInteger(value.chat.id) &&
    typeof value.chat.type === 'string' && (value.from === undefined || isUser(value.from)) && (value.text === undefined || typeof value.text === 'string');
}
function isUpdate(value: unknown): value is Update {
  if (!isObject(value) || !Number.isSafeInteger(value.update_id) || Number(value.update_id) < 0) return false;
  if (value.message !== undefined && !isMessage(value.message)) return false;
  if (value.callback_query !== undefined) {
    const q = value.callback_query;
    if (!isObject(q) || typeof q.id !== 'string' || !isUser(q.from) || (q.message !== undefined && !isMessage(q.message)) ||
      (q.data !== undefined && (typeof q.data !== 'string' || q.data.length > 64))) return false;
  }
  return true;
}

export default {
  fetch(request, env) { return handleRequest(request, env); },
  async scheduled(_event: ScheduledController, env: Env) {
    if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET) return;
    // Use execution time to avoid replaying an old cron as a fresh medication reminder.
    await runScheduler(new Store(env, Date.now()), new Telegram(env.BOT_TOKEN));
  },
} satisfies ExportedHandler<Env>;
