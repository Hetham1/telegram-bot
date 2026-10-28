import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { handleRequest } from '../src/index';
import { Store } from '../src/store';
import { Telegram } from '../src/telegram';
import { runScheduler } from '../src/scheduler';
import { drainOutbox } from '../src/delivery';
import { localTime, scheduledPeriod } from '../src/time';
import type { Env, Fetcher, Update } from '../src/types';

let runtime: Miniflare;
let env: Env;
let calls: Array<{ method: string; body: any }>;
let failure: { code: number; retry?: number } | null;
let now: number;
let sequence: number;
const fetcher = (async (input: string, init: RequestInit) => {
  const method = input.split('/').at(-1)!;
  calls.push({ method, body: JSON.parse(init.body as string) });
  if (failure) return Response.json({ ok: false, error_code: failure.code, parameters: { retry_after: failure.retry } }, { status: failure.code });
  return Response.json({ ok: true, result: { message_id: calls.length } });
}) as Fetcher;

before(async () => {
  runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01', d1Databases: ['DB'] }));
  env = { DB: await runtime.getD1Database('DB') as unknown as D1Database, BOT_TOKEN: 'test-token', WEBHOOK_SECRET: 'test-secret', ADMIN_IDS: '1', TIMEZONE: 'Asia/Tehran' };
  const migration = await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
  for (const sql of migration.split(';').map(v => v.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
});
after(async () => runtime?.dispose());
beforeEach(async () => {
  for (const table of ['outbox', 'reminders', 'prompts', 'inbox', 'users']) await env.DB.prepare(`DELETE FROM ${table}`).run();
  calls = []; failure = null; now = Date.parse('2026-10-29T10:30:00Z'); sequence = 100;
});

function message(id: number, text: string): Update {
  return { update_id: sequence++, message: { message_id: sequence, from: { id, first_name: `User ${id}` }, chat: { id, type: 'private' }, text } };
}
function callback(id: number, data: string): Update {
  return { update_id: sequence++, callback_query: { id: `q${sequence}`, from: { id }, data,
    message: { message_id: sequence, chat: { id, type: 'private' } } } };
}
async function send(update: Update, secret = 'test-secret') {
  return handleRequest(new Request('https://bot.example/webhook', { method: 'POST', headers: {
    'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(update) }), env, fetcher, now);
}
async function rows(sql: string) { return (await env.DB.prepare(sql).all<any>()).results; }
function store() { return new Store(env, now); }
async function runCron() { await runScheduler(store(), new Telegram('test-token', fetcher)); }
async function promptId() { return (await rows('SELECT id FROM prompts ORDER BY created_at DESC, rowid DESC LIMIT 1'))[0].id as string; }

test('the two daily slots use Tehran local time, including UTC date rollover', () => {
  assert.equal(scheduledPeriod(Date.parse('2026-10-29T10:30:00Z')), 'afternoon');
  assert.equal(scheduledPeriod(Date.parse('2026-10-29T18:30:00Z')), 'evening');
  assert.equal(scheduledPeriod(Date.parse('2026-10-29T08:30:00Z')), undefined);
  assert.equal(scheduledPeriod(Date.parse('2026-10-29T17:30:00Z')), undefined);
  assert.equal(scheduledPeriod(Date.parse('2026-10-29T11:00:00Z')), undefined);
  assert.equal(localTime(Date.parse('2026-10-29T21:00:00Z')).date, '2026-10-30');
});

test('unauthorized webhooks cannot register users; malformed requests are rejected', async () => {
  assert.equal((await send(message(2, '/start'), 'wrong')).status, 401);
  assert.equal((await rows('SELECT * FROM users')).length, 0);
  assert.equal((await handleRequest(new Request('https://bot.example/webhook'), env, fetcher, now)).status, 405);
  const invalid = new Request('https://bot.example/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'test-secret' }, body: '{' });
  assert.equal((await handleRequest(invalid, env, fetcher, now)).status, 400);
  assert.equal((await send({ update_id: 1, message: { from: null } } as any)).status, 400);
  assert.equal(calls.length, 0);
});

test('health checks expose only service status and the requested schedule', async () => {
  const response = await handleRequest(new Request('https://bot.example/health'), env, fetcher, now);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /14:00/); assert.match(body, /22:00/);
  assert.doesNotMatch(body, /test-token|test-secret|ADMIN_IDS/);
});

test('start is durable and a replayed Telegram update sends no duplicate messages', async () => {
  const update = message(2, '/start');
  await send(update); await send(update);
  assert.equal((await rows('SELECT * FROM users'))[0].active, 1);
  assert.equal((await rows('SELECT * FROM prompts')).length, 1);
  assert.equal(calls.filter(c => c.method === 'sendMessage').length, 2);
  assert.equal((await rows('SELECT * FROM inbox WHERE processed_at IS NOT NULL')).length, 1);
});

test('regular users cannot access admin commands, callbacks or the old password', async () => {
  await send(message(2, '/start'));
  for (const data of ['admin_stats', 'admin_logs', 'admin_users', 'user_make_admin', 'user_remove_admin']) await send(callback(2, data));
  await send(message(2, 'Admin2024'));
  await send(message(2, '/promote 2'));
  const user = (await rows('SELECT * FROM users WHERE id = 2'))[0];
  assert.equal(user.is_admin, 0); assert.equal(user.pending_action, null);
  assert.equal((await rows('SELECT * FROM users WHERE is_admin = 1')).length, 0);
});

test('admin management survives requests and owners cannot be demoted', async () => {
  await send(message(1, '/start')); await send(message(2, '/id'));
  await send(callback(1, 'user_make_admin')); await send(message(1, '2'));
  assert.equal((await rows('SELECT is_admin FROM users WHERE id = 2'))[0].is_admin, 1);
  await send(message(2, '/demote 1'));
  assert.equal((await rows('SELECT is_admin FROM users WHERE id = 1'))[0].is_admin, 1);
  await send(message(1, '/demote 2'));
  assert.equal((await rows('SELECT is_admin FROM users WHERE id = 2'))[0].is_admin, 0);
});

test('no creates one persistent 15-minute snooze and yes clears it and notifies the admin once', async () => {
  await send(message(1, '/start')); await send(message(2, '/start'));
  const first = await promptId();
  const no = callback(2, `r|${first}|no`);
  await send(no); await send(no); await send(callback(2, `r|${first}|no`));
  assert.equal((await rows('SELECT * FROM reminders')).length, 1);
  assert.equal((await rows('SELECT * FROM reminders'))[0].due_at, now + 900_000);
  assert.equal((await rows("SELECT * FROM prompts WHERE answer = 'no'")).length, 1);
  now += 900_000;
  await runCron();
  const snooze = (await rows("SELECT * FROM prompts WHERE id LIKE 's:%'"))[0];
  assert.ok(snooze); assert.equal((await rows('SELECT * FROM reminders')).length, 0);
  const yes = callback(2, `r|${snooze.id}|yes`);
  await send(yes); await send(yes); await send(callback(2, `r|${snooze.id}|yes`));
  assert.equal((await rows("SELECT * FROM prompts WHERE answer = 'yes'")).length, 1);
  assert.equal(calls.filter(c => c.method === 'sendMessage' && /confirmed taking/.test(c.body.text)).length, 1);
});

test('concurrent taps are counted once and cannot create duplicate snoozes', async () => {
  await send(message(2, '/start'));
  const id = await promptId();
  await Promise.all([send(callback(2, `r|${id}|no`)), send(callback(2, `r|${id}|no`))]);
  assert.equal((await rows('SELECT * FROM prompts WHERE answer IS NOT NULL')).length, 1);
  assert.equal((await rows('SELECT * FROM reminders')).length, 1);
});

test('a user cannot answer another person’s prompt or a previous day’s prompt', async () => {
  await send(message(2, '/start')); const id = await promptId();
  await send(message(3, '/start'));
  await send(callback(3, `r|${id}|yes`));
  now += 86_400_000; await send(callback(2, `r|${id}|yes`));
  assert.equal((await rows('SELECT * FROM prompts WHERE answer IS NOT NULL')).length, 0);
});

test('cron produces exactly two daily prompts per subscribed non-admin, even when invoked repeatedly', async () => {
  await send(message(1, '/start')); await send(message(2, '/start')); calls = [];
  await runCron(); await runCron();
  now = Date.parse('2026-10-29T18:30:00Z');
  await runCron(); await runCron();
  const daily = await rows("SELECT * FROM prompts WHERE id LIKE 'd:%'");
  assert.equal(daily.length, 2); assert.ok(daily.every(p => p.user_id === 2));
  const messages = calls.filter(c => c.method === 'sendMessage');
  assert.equal(messages.length, 2); assert.match(messages[0].body.text, /یک قرص/); assert.match(messages[1].body.text, /دو قرص/);
});

test('stop cancels snoozes and prevents daily messages; start opts back in', async () => {
  await send(message(2, '/start')); await send(callback(2, `r|${await promptId()}|no`));
  await send(message(2, '/stop')); calls = [];
  now += 900_000; await runCron();
  assert.equal((await rows('SELECT * FROM reminders')).length, 0);
  assert.equal(calls.length, 0);
  await send(message(2, '/start')); assert.equal((await rows('SELECT active FROM users WHERE id = 2'))[0].active, 1);
});

test('statistics and logs both read the period-specific response schema', async () => {
  await send(message(1, '/start')); await send(message(2, '/start'));
  await send(callback(2, `r|${await promptId()}|yes`));
  await send(message(1, '/stats')); await send(message(1, '/logs'));
  const texts = calls.filter(c => c.method === 'sendMessage').map(c => c.body.text);
  assert.ok(texts.some(t => /Yes: 1/.test(t) && /2 p.m./.test(t)));
  assert.ok(texts.some(t => /Recent response logs/.test(t) && /Yes: 1/.test(t)));
});

test('429 retries survive invocations and respect Telegram retry_after', async () => {
  failure = { code: 429, retry: 120 }; await send(message(2, '/id'));
  const queued = (await rows('SELECT * FROM outbox'))[0];
  assert.equal(queued.sent_at, null); assert.equal(queued.due_at, now + 120_000);
  failure = null; now += 119_000; await drainOutbox(store(), new Telegram('test', fetcher));
  assert.equal(calls.length, 1);
  now += 1000; await drainOutbox(store(), new Telegram('test', fetcher));
  assert.equal(calls.length, 2); assert.ok((await rows('SELECT sent_at FROM outbox'))[0].sent_at);
});

test('blocked bot errors pause subscriptions instead of retrying forever', async () => {
  await send(message(2, '/start')); failure = { code: 403 };
  await send(message(2, '/id'));
  assert.equal((await rows('SELECT active FROM users WHERE id = 2'))[0].active, 0);
  assert.ok((await rows("SELECT failed_at FROM outbox WHERE last_error = '403'"))[0].failed_at);
});

test('cron recovers a persisted update after a worker interruption', async () => {
  const update = message(2, '/id');
  await store().sql('INSERT INTO inbox(update_id, payload, created_at) VALUES (?, ?, ?)', update.update_id, JSON.stringify(update), now).run();
  await runCron();
  assert.equal((await rows('SELECT * FROM inbox WHERE processed_at IS NOT NULL')).length, 1);
  assert.ok(calls.some(c => /user ID: 2/.test(c.body.text ?? '')));
});

test('group messages never subscribe users or disclose private records', async () => {
  const update = message(1, '/stats'); update.message!.chat = { id: -100, type: 'supergroup' };
  await send(update); assert.equal(calls.length, 0); assert.equal((await rows('SELECT * FROM users')).length, 0);
});
