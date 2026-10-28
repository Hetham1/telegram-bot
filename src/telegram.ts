import type { Fetcher } from './types';

export class TelegramError extends Error {
  constructor(public code: number, public retryAfter = 0, public unchanged = false) {
    // Never include Telegram request URLs, tokens, or message bodies in errors/logs.
    super(`Telegram API error ${code}`);
  }
}

export class Telegram {
  constructor(private token: string, private fetcher: Fetcher = fetch) {}

  async call(method: string, payload: Record<string, unknown>): Promise<void> {
    let response: Response;
    try {
      response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(8000),
      });
    } catch { throw new TelegramError(503); }
    let data: { ok: boolean; error_code?: number; description?: string; parameters?: { retry_after?: number } };
    try { data = await response.json(); } catch { throw new TelegramError(502); }
    if (!response.ok || !data.ok) {
      throw new TelegramError(data.error_code ?? response.status, data.parameters?.retry_after,
        data.description?.toLowerCase().includes('message is not modified'));
    }
  }
}
