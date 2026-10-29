import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { handleRequest } from '../src/index';
import { Store } from '../src/store';
import { Telegram } from '../src/telegram';
import { runScheduler } from '../src/scheduler';
import { drainOutbox } from '../src/delivery';
import { clockText, localTime, parseTime } from '../src/time';
import { parsePills } from '../src/schedule-editor';
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
    compatibilityDate: '2026-10-01', d1Databases: ['DB', 'MIGRATION_DB'] }));
  env = { DB: await runtime.getD1Database('DB') as unknown as D1Database, BOT_TOKEN: 'test-token', WEBHOOK_SECRET: 'test-secret', ADMIN_IDS: '1', TIMEZONE: 'Asia/Tehran' };
  for (const name of ['0001_initial.sql', '0002_prompt_series.sql', '0003_editable_schedules.sql']) {
    const migration = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    for (const sql of migration.split(';').map(v => v.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
  }
});
after(async () => runtime?.dispose());
beforeEach(async () => {
  for (const table of ['outbox', 'reminders', 'prompts', 'inbox', 'schedule_edits', 'schedules', 'users']) await env.DB.prepare(`DELETE FROM ${table}`).run();
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

test('times support AM/PM and Persian digits, including noon, midnight, and Tehran date rollover', () => {
  assert.equal(parseTime('2 PM'), 840); assert.equal(parseTime('10:30pm'), 1350);
  assert.equal(parseTime('۲:۱۵ PM'), 855); assert.equal(parseTime('١٤:٣٠'), 870);
  assert.equal(parseTime('12 AM'), 0); assert.equal(parseTime('12 PM'), 720);
  assert.equal(parseTime('14:00'), 840);
  for (const invalid of ['2', '0 PM', '13 AM', '25:00', '14:60', '12:9 PM', '-1:00', 'tomorrow']) {
    assert.equal(parseTime(invalid), undefined, invalid);
  }
  assert.equal(clockText(840), '2 PM'); assert.equal(clockText(1350), '10:30 PM');
  assert.equal(clockText(0), '12 AM'); assert.equal(clockText(720), '12 PM');
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
  assert.equal(messages.length, 2); assert.match(messages[0].body.text, /اسنترا/); assert.match(messages[1].body.text, /اون دوتا/);
});

test('early introductory confirmations cannot suppress either daily notification or its snoozes', async () => {
  now = Date.parse('2026-10-28T22:30:00Z'); // 2 a.m. on October 29 in Tehran.
  for (const id of [2, 3]) {
    await send(message(id, '/start'));
    await send(callback(id, `r|${await promptId()}|yes`));
  }
  calls = [];
  now = Date.parse('2026-10-29T10:30:00Z');
  await runCron(); await runCron();
  assert.equal(calls.filter(c => c.method === 'sendMessage').length, 2);
  const afternoon = (await rows("SELECT * FROM prompts WHERE user_id = 2 AND id LIKE 'd:%'"))[0];
  await send(callback(2, `r|${afternoon.id}|no`));
  assert.equal((await rows('SELECT * FROM reminders')).length, 1);
  now += 900_000; await runCron();
  const snooze = (await rows("SELECT * FROM prompts WHERE id LIKE 's:%'"))[0];
  assert.equal(snooze.series_id, afternoon.id);
  assert.ok(calls.some(c => c.method === 'sendMessage' && c.body.reply_markup?.inline_keyboard[0][0].callback_data === `r|${snooze.id}|yes`));
  await send(callback(2, `r|${snooze.id}|yes`));
  assert.equal((await rows('SELECT * FROM reminders')).length, 0);
  calls = [];
  now = Date.parse('2026-10-29T18:30:00Z');
  await runCron(); await runCron();
  assert.equal(calls.filter(c => c.method === 'sendMessage').length, 2);
  assert.equal((await rows("SELECT * FROM prompts WHERE id LIKE 'd:%'")).length, 4);
});

test('answering an introductory question cannot cancel a daily reminder’s pending snooze', async () => {
  now = Date.parse('2026-10-28T22:30:00Z');
  await send(message(2, '/start')); const intro = await promptId();
  now = Date.parse('2026-10-29T10:30:00Z'); await runCron(); const daily = await promptId();
  await send(callback(2, `r|${daily}|no`));
  await send(callback(2, `r|${intro}|yes`));
  assert.equal((await rows('SELECT * FROM reminders')).length, 1);
  now += 900_000; calls = []; await runCron();
  assert.equal(calls.filter(c => c.method === 'sendMessage').length, 1);
  assert.equal((await rows("SELECT series_id FROM prompts WHERE id LIKE 's:%'"))[0].series_id, daily);
});

test('migration preserves existing answers and reconstructs snooze ancestry', async () => {
  const legacy = await runtime.getD1Database('MIGRATION_DB');
  const initial = await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
  for (const sql of initial.split(';').map(v => v.trim()).filter(Boolean)) await legacy.prepare(sql).run();
  await legacy.prepare('INSERT INTO users(id, created_at) VALUES (2, 0)').run();
  for (const [id, answer, update] of [['u:100', 'no', 101], ['s:101', 'no', 102], ['s:102', 'yes', 103]] as const) {
    await legacy.prepare("INSERT INTO prompts(id, user_id, date, period, created_at, answer, answer_update_id) VALUES (?, 2, '2026-10-29', 'afternoon', 0, ?, ?)").bind(id, answer, update).run();
  }
  const migration = await readFile(new URL('../migrations/0002_prompt_series.sql', import.meta.url), 'utf8');
  for (const sql of migration.split(';').map(v => v.trim()).filter(Boolean)) await legacy.prepare(sql).run();
  const data = (await legacy.prepare('SELECT answer, series_id FROM prompts ORDER BY answer_update_id').all()).results;
  assert.deepEqual(data, [{ answer: 'no', series_id: 'u:100' }, { answer: 'no', series_id: 'u:100' }, { answer: 'yes', series_id: 'u:100' }]);
  await legacy.prepare("INSERT INTO reminders VALUES (2, '2026-10-29', 'afternoon', 5000, 102)").run();
  await legacy.prepare("INSERT INTO outbox(id, chat_id, method, payload, prompt_id, created_at, due_at) VALUES ('old', 2, 'sendMessage', '{}', 'u:100', 0, 0)").run();
  const editable = await readFile(new URL('../migrations/0003_editable_schedules.sql', import.meta.url), 'utf8');
  for (const sql of editable.split(';').map(v => v.trim()).filter(Boolean)) await legacy.prepare(sql).run();
  assert.equal((await legacy.prepare('SELECT * FROM prompts').all()).results.length, 3);
  assert.equal((await legacy.prepare('SELECT * FROM outbox').all()).results.length, 1);
  assert.equal((await legacy.prepare('SELECT * FROM reminders').all()).results.length, 1);
  assert.deepEqual((await legacy.prepare('SELECT key, time_minutes, pills FROM schedules ORDER BY time_minutes').all()).results,
    [{ key: 'afternoon', time_minutes: 840, pills: 'اسنترا' }, { key: 'evening', time_minutes: 1320, pills: 'اون دوتا' }]);
  assert.equal((await legacy.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
});

async function beginEdit(id: number, action: 'pills' | 'time', key = 'afternoon') {
  const slot = await store().schedule(id, key);
  assert.ok(slot);
  await send(callback(id, `cfg|${action}|${key}|${slot.revision}`));
}
async function saveEdit(id: number) {
  const edit = (await rows(`SELECT * FROM schedule_edits WHERE user_id = ${id}`))[0];
  assert.equal(edit?.step, 'confirm');
  await send(callback(id, `cfg|save|${edit.token}`));
  return edit;
}
async function addSlot(id: number, time: string, pills: string) {
  await send(callback(id, 'cfg|add'));
  await send(message(id, time)); await send(message(id, pills));
  return saveEdit(id);
}

test('default reminder wording keeps the requested text and explicit PM labels', async () => {
  await send(message(2, '/start'));
  const texts = calls.filter(c => c.method === 'sendMessage').map(c => c.body.text);
  assert.ok(texts.includes('من اینجام تا بهت یادآوری کنم قرص‌هات رو بخوری! 💊\nهر روز ساعت 2 PM برای اسنترا و ساعت 10 PM برای اون دوتای دیگه،'));
  assert.ok(texts.includes('اسنترا رو خوردی؟ 💊'));
  calls = []; await runCron();
  assert.ok(calls.some(c => c.body.text === 'عصر بخیر ثارینا! ☀️\nساعت 2 PM عه؛ اسنترا رو خوردی؟ 💊'));
  assert.ok(calls.some(c => c.body.reply_markup?.inline_keyboard[0][0].text === 'اله، خولدم! ✅'));
});

test('schedule editing is available to a regular user and changes only after confirmation', async () => {
  await send(message(2, '/start')); await send(message(2, '/schedule'));
  assert.ok(calls.some(c => /قرص‌ها و ساعت‌ها/.test(c.body.text ?? '') && /2 PM/.test(c.body.text)));
  await beginEdit(2, 'pills');
  await send(message(2, 'اسنترا\nقرص آزمایشی — ۱ عدد'));
  assert.equal((await store().schedule(2, 'afternoon'))!.pills, 'اسنترا');
  const draft = await saveEdit(2);
  const slot = (await store().schedule(2, 'afternoon'))!;
  assert.equal(slot.pills, 'اسنترا\nقرص آزمایشی — ۱ عدد'); assert.equal(slot.revision, 2);
  await send(callback(2, `cfg|save|${draft.token}`));
  assert.equal((await store().schedule(2, 'afternoon'))!.revision, 2);
  assert.equal((await rows('SELECT is_admin FROM users WHERE id = 2'))[0].is_admin, 0);
});

test('new reminders combine multiple pills into one daily notification at the chosen minute', async () => {
  await send(message(2, '/start'));
  const draft = await addSlot(2, '۲:۱۵ PM', 'قرص اول\nقرص دوم');
  calls = []; now = Date.parse('2026-10-29T10:45:00Z');
  await runCron(); await runCron();
  const custom = calls.filter(c => c.method === 'sendMessage' && /قرص اول/.test(c.body.text ?? ''));
  assert.equal(custom.length, 1); assert.match(custom[0].body.text, /2:15 PM/); assert.match(custom[0].body.text, /قرص دوم/);
  const prompt = (await rows(`SELECT * FROM prompts WHERE schedule_key = '${draft.schedule_key}'`))[0];
  assert.equal(prompt.time_minutes, 855); assert.equal(prompt.pills, 'قرص اول\nقرص دوم');
  for (const call of calls) for (const row of call.body.reply_markup?.inline_keyboard ?? []) {
    for (const button of row) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  }
});

test('renaming or rescheduling cancels stale snoozes, queued reminders and old answer buttons', async () => {
  await send(message(2, '/start')); const intro = await promptId();
  await send(callback(2, `r|${intro}|no`));
  assert.equal((await rows('SELECT * FROM reminders')).length, 1);
  await beginEdit(2, 'time'); await send(message(2, '3:30 PM')); await saveEdit(2);
  assert.equal((await rows('SELECT * FROM reminders')).length, 0);
  calls = []; now += 900_000; await runCron();
  assert.equal(calls.filter(c => c.method === 'sendMessage').length, 0);
  await send(callback(2, `r|${intro}|yes`));
  assert.equal((await rows("SELECT * FROM prompts WHERE answer = 'yes'")).length, 0);
  calls = []; now = Date.parse('2026-10-29T12:00:00Z'); await runCron();
  assert.ok(calls.some(c => /3:30 PM/.test(c.body.text ?? '') && /اسنترا/.test(c.body.text)));
});

test('the test account cannot read or change another person’s pills, schedule, or draft', async () => {
  await send(message(2, '/start')); await send(message(3, '/start'));
  const custom = await addSlot(2, '5 PM', 'قرص شخصی');
  await beginEdit(2, 'pills', custom.schedule_key);
  await send(message(2, 'فهرست خصوصی'));
  const draft = (await rows('SELECT * FROM schedule_edits WHERE user_id = 2'))[0];
  calls = [];
  await send(callback(3, `cfg|view|${custom.schedule_key}|1`));
  await send(callback(3, `cfg|remove|${custom.schedule_key}|1`));
  await send(callback(3, `cfg|save|${draft.token}`));
  assert.ok(calls.every(c => !/قرص شخصی|فهرست خصوصی/.test(c.body.text ?? '')));
  assert.equal((await store().schedule(2, custom.schedule_key))!.pills, 'قرص شخصی');
  assert.equal((await store().schedule(3, 'afternoon'))!.pills, 'اسنترا');
});

test('invalid or duplicate times never change a saved schedule and cancel discards edits', async () => {
  await send(message(2, '/start')); await beginEdit(2, 'time');
  await send(message(2, '25:00')); await send(message(2, '10 PM'));
  const draft = (await rows('SELECT * FROM schedule_edits'))[0];
  assert.equal(draft.step, 'time'); assert.equal((await store().schedule(2, 'afternoon'))!.time_minutes, 840);
  await send(message(2, '4 PM')); await send(message(2, '/cancel'));
  await send(callback(2, `cfg|save|${draft.token}`));
  assert.equal((await rows('SELECT * FROM schedule_edits')).length, 0);
  assert.equal((await store().schedule(2, 'afternoon'))!.time_minutes, 840);
  assert.equal(parsePills(''), undefined); assert.equal(parsePills('x'.repeat(61)), undefined);
  assert.equal(parsePills(Array(9).fill('قرص').join('\n')), undefined);
});

test('expired drafts and stale buttons cannot overwrite newer settings', async () => {
  await send(message(2, '/start')); await beginEdit(2, 'pills'); await send(message(2, 'جدید'));
  const draft = (await rows('SELECT * FROM schedule_edits'))[0];
  now += 16 * 60_000; await send(callback(2, `cfg|save|${draft.token}`));
  assert.equal((await store().schedule(2, 'afternoon'))!.pills, 'اسنترا');
  await beginEdit(2, 'pills'); await send(message(2, 'قرص جدید')); await saveEdit(2);
  await send(callback(2, 'cfg|remove|afternoon|1'));
  assert.equal((await store().schedule(2, 'afternoon'))!.pills, 'قرص جدید');
});

test('pausing and deleting reminders work without resetting an intentionally empty schedule', async () => {
  await send(message(2, '/start'));
  await send(callback(2, 'cfg|toggle|afternoon|1'));
  calls = []; await runCron(); assert.equal(calls.filter(c => c.method === 'sendMessage').length, 0);
  await send(callback(2, 'cfg|delete|afternoon|2'));
  assert.ok(await store().schedule(2, 'afternoon'));
  await send(callback(2, 'cfg|remove|afternoon|2')); await send(callback(2, 'cfg|remove|evening|1'));
  calls = []; await send(message(2, '/start')); await runCron();
  assert.equal((await store().schedules(2)).length, 0);
  assert.equal(calls.filter(c => c.method === 'sendMessage').length, 1);
  assert.match(calls.find(c => c.method === 'sendMessage')!.body.text, /فعلاً یادآوری فعالی نداری/);
});

test('past-time additions start tomorrow and a changed daily slot is not delivered twice today', async () => {
  await send(message(2, '/start')); await runCron();
  await beginEdit(2, 'time'); await send(message(2, '4 PM')); await saveEdit(2);
  const added = await addSlot(2, '1:50 PM', 'قرص گذشته');
  assert.equal((await store().schedule(2, added.schedule_key))!.effective_date, '2026-10-30');
  calls = []; now = Date.parse('2026-10-29T12:30:00Z'); await runCron();
  assert.equal(calls.filter(c => c.method === 'sendMessage').length, 0);
  now = Date.parse('2026-10-30T12:30:00Z'); await runCron();
  assert.ok(calls.some(c => /4 PM/.test(c.body.text ?? '') && /اسنترا/.test(c.body.text)));
});

test('custom slots work at Tehran midnight and stop still pauses every slot', async () => {
  await send(message(2, '/start')); const midnight = await addSlot(2, '12 AM', 'قرص نیمه‌شب');
  calls = []; now = Date.parse('2026-10-29T20:30:00Z'); await runCron();
  assert.ok(calls.some(c => /12 AM/.test(c.body.text ?? '') && /قرص نیمه‌شب/.test(c.body.text)));
  const prompts = await rows(`SELECT * FROM prompts WHERE schedule_key = '${midnight.schedule_key}'`);
  assert.equal(prompts[0].date, '2026-10-30');
  await send(message(2, '/stop')); calls = []; now += 86_400_000; await runCron();
  assert.equal(calls.length, 0);
});

test('custom reminders retain their snapshot through snoozes, confirmations, and reports', async () => {
  await send(message(1, '/start')); await send(message(2, '/start'));
  await addSlot(2, '4 PM', 'قرص جدید');
  now = Date.parse('2026-10-29T12:30:00Z'); await runCron(); const daily = await promptId();
  await send(callback(2, `r|${daily}|no`)); now += 900_000; await runCron(); const snooze = await promptId();
  await send(callback(2, `r|${snooze}|yes`));
  assert.ok(calls.some(c => c.method === 'editMessageText' && /گل برای گل/.test(c.body.text ?? '')));
  assert.ok(calls.some(c => /confirmed taking قرص جدید \(4 PM\)/.test(c.body.text ?? '')));
  const prompt = await store().prompt(daily);
  await beginEdit(2, 'pills', prompt!.schedule_key); await send(message(2, 'نام بعدی')); await saveEdit(2);
  calls = []; await send(message(1, '/stats')); await send(message(1, '/logs'));
  assert.ok(calls.some(c => /قرص جدید/.test(c.body.text ?? '') && /4 PM/.test(c.body.text)));
  assert.ok(calls.every(c => !/نام بعدی/.test(c.body.text ?? '')));
});

test('two concurrent saves apply one revision and preserve the daily notification limit', async () => {
  await send(message(2, '/start')); await beginEdit(2, 'pills'); await send(message(2, 'قرص ویرایش‌شده'));
  const draft = (await rows('SELECT * FROM schedule_edits'))[0];
  await Promise.all([send(callback(2, `cfg|save|${draft.token}`)), send(callback(2, `cfg|save|${draft.token}`))]);
  assert.equal((await store().schedule(2, 'afternoon'))!.revision, 2);
  calls = []; await runCron(); await runCron();
  assert.equal(calls.filter(c => c.method === 'sendMessage').length, 1);
});

test('a queued reminder is canceled when its pills change before delivery', async () => {
  await send(message(2, '/start')); failure = { code: 429, retry: 120 };
  await runCron();
  const queued = (await rows("SELECT * FROM outbox WHERE prompt_id LIKE 'd:%'"))[0];
  assert.equal(queued.sent_at, null);
  failure = null;
  await beginEdit(2, 'pills'); await send(message(2, 'قرص تازه')); await saveEdit(2);
  assert.equal((await rows(`SELECT last_error FROM outbox WHERE id = '${queued.id}'`))[0].last_error, 'schedule_changed');
  calls = []; now += 120_000; await runCron();
  assert.equal(calls.filter(c => c.method === 'sendMessage').length, 0);
});

test('catch-up spans an hour boundary and excludes reminders more than 30 minutes late', async () => {
  await send(message(2, '/start'));
  await addSlot(2, '4:50 PM', 'قرص اول'); await addSlot(2, '5 PM', 'قرص دوم');
  now = Date.parse('2026-10-29T13:50:00Z'); // 5:20 PM Tehran.
  calls = []; await runCron(); await runCron();
  assert.ok(calls.some(c => /قرص دوم/.test(c.body.text ?? '')));
  assert.ok(calls.every(c => !/قرص اول/.test(c.body.text ?? '')));
  now = Date.parse('2026-10-30T13:40:00Z'); // 5:10 PM on the next day.
  calls = []; await runCron();
  assert.ok(calls.some(c => /قرص اول/.test(c.body.text ?? '')));
  assert.ok(calls.some(c => /قرص دوم/.test(c.body.text ?? '')));
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
  assert.ok(texts.some(t => /Yes: 1/.test(t) && /2 PM/.test(t) && /اسنترا/.test(t)));
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
