import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('Telegram transport works inside the actual Workers runtime with native fetch', async () => {
  const source = await readFile(new URL('../src/telegram.ts', import.meta.url), 'utf8');
  const compiled = stripTypeScriptTypes(source, { mode: 'transform' });
  const requests: Array<{ url: string; body: unknown }> = [];
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-10-01',
    script: compiled + `\nexport default { async fetch() {
      await new Telegram('test-token').call('sendMessage', { chat_id: 123, text: 'test' });
      return new Response('sent');
    } };`,
    outboundService: async request => {
      requests.push({ url: request.url, body: await request.json() });
      return Response.json({ ok: true, result: { message_id: 1 } });
    },
  }));
  try {
    const response = await runtime.dispatchFetch('http://localhost/');
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(requests, [{ url: 'https://api.telegram.org/bottest-token/sendMessage', body: { chat_id: 123, text: 'test' } }]);
  } finally { await runtime.dispose(); }
});
