import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

const vars = { ...parseEnv(await readFile(new URL('../.dev.vars', import.meta.url), 'utf8').catch(() => '')), ...process.env };
const token = vars.BOT_TOKEN;
const secret = vars.WEBHOOK_SECRET;
const mode = process.argv[2];

async function telegram(method, body = {}) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
  } catch { throw new Error(`Telegram ${method} network request failed`); }
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(`Telegram ${method} failed (${data.error_code ?? response.status})`);
  return data.result;
}

try {
  if (!token) throw new Error('Set BOT_TOKEN in .dev.vars or the environment first.');
  const me = await telegram('getMe');
  if (mode === '--inspect') {
    const info = await telegram('getWebhookInfo');
    console.log(JSON.stringify({ username: me.username, webhook_host: info.url ? new URL(info.url).hostname : null,
      pending_updates: info.pending_update_count, last_error_date: info.last_error_date ?? null }, null, 2));
  } else {
    if (!mode) throw new Error('Usage: npm run telegram:setup -- https://YOUR-WORKER.workers.dev [--verify]');
    const worker = new URL(mode);
    if (worker.protocol !== 'https:' || worker.username || worker.password || worker.search || worker.hash || !['', '/'].includes(worker.pathname)) {
      throw new Error('Provide the Worker HTTPS origin without a path, query, or credentials.');
    }
    const expected = `${worker.origin}/webhook`;
    if (process.argv[3] !== '--verify') {
      if (!secret || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw new Error('Set WEBHOOK_SECRET to a random 32–256 character value.');
      const health = await fetch(`${worker.origin}/health`, { signal: AbortSignal.timeout(15000) });
      const status = await health.json();
      if (!health.ok || status.service !== 'saripill-telegram-bot' || status.status !== 'ok') throw new Error('The deployed Worker health check must pass before switching Telegram.');
      const previous = await telegram('getWebhookInfo');
      await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
      await writeFile(new URL('../.local/previous-webhook.json', import.meta.url), JSON.stringify(previous, null, 2), { flag: 'wx', mode: 0o600 }).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
      await telegram('setWebhook', { url: expected, secret_token: secret, max_connections: 1,
        allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
      await telegram('setMyCommands', { commands: [
        { command: 'start', description: 'Start pill reminders' }, { command: 'stop', description: 'Pause reminders' },
        { command: 'id', description: 'Show your Telegram user ID' }, { command: 'help', description: 'Help and daily schedule' },
        { command: 'schedule', description: 'قرص‌ها و ساعت‌ها 💊' },
      ] });
    }
    const info = await telegram('getWebhookInfo');
    if (info.url !== expected) throw new Error('Telegram is not connected to the expected Worker.');
    console.log(JSON.stringify({ bot: `https://t.me/${me.username}`, webhook: expected, pending_updates: info.pending_update_count,
      last_error_date: info.last_error_date ?? null, max_connections: info.max_connections }, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error && !error.cause ? error.message : 'Telegram setup failed. Check connectivity and credentials.');
  process.exitCode = 1;
}
