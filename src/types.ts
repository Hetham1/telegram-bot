export interface Env {
  DB: D1Database;
  BOT_TOKEN?: string;
  WEBHOOK_SECRET?: string;
  ADMIN_IDS?: string;
  TIMEZONE?: string;
}

export type Period = 'afternoon' | 'evening';
export interface TelegramUser { id: number; username?: string; first_name?: string; is_bot?: boolean }
export interface Message {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string };
  text?: string;
}
export interface Update {
  update_id: number;
  message?: Message;
  callback_query?: { id: string; from: TelegramUser; message?: Message; data?: string };
}
export interface User {
  id: number; username: string; first_name: string; is_admin: number; active: number;
  pending_action: string | null; pending_until: number | null;
}
export interface Prompt {
  id: string; user_id: number; date: string; period: Period;
  answer: 'yes' | 'no' | null; answer_update_id: number | null;
}
export interface Outgoing {
  id: string; chat_id: number; method: string; payload: string;
  prompt_id: string | null; attempts: number;
}
export type Keyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
export type Fetcher = typeof fetch;
