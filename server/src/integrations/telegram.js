// Telegram bot notifications (I4). Docs: https://core.telegram.org/bots/api
import { providerFetch } from './http.js';

export const LIMITS = [
  'Each employee must link their own Telegram chat (Profile → Telegram) by pressing Start in the bot once.',
  'Bots cannot message a user who has never started a chat with the bot.',
  'Telegram rate-limits bots (about 30 messages per second overall); failed alerts are retried up to 3 times.',
];

const api = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

export async function getMe(cfg) {
  const r = await providerFetch(api(cfg.botToken, 'getMe'));
  if (r.ok && r.json?.ok) return { ok: true, username: r.json.result.username, detail: `Bot @${r.json.result.username}` };
  return { ok: false, detail: r.networkError || r.json?.description || `HTTP ${r.status}` };
}

export async function sendMessage(cfg, chatId, text) {
  const r = await providerFetch(api(cfg.botToken, 'sendMessage'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  }, { retries: 0 });
  return { ok: !!(r.ok && r.json?.ok), status: r.status, transient: r.transient, detail: r.networkError || r.json?.description || (r.ok ? 'sent' : `HTTP ${r.status}`), messageId: r.json?.result?.message_id };
}

// Finds a "/start <code>" message sent to the bot and returns the chat id (used for linking).
export async function findStartCode(cfg, code) {
  const r = await providerFetch(api(cfg.botToken, 'getUpdates'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowed_updates: ['message'], limit: 100 }),
  });
  if (!r.ok || !r.json?.ok) return { ok: false, detail: r.networkError || r.json?.description || `HTTP ${r.status}` };
  const hit = [...r.json.result].reverse().find((u) => u.message?.text?.trim() === `/start ${code}`);
  return { ok: true, chatId: hit ? String(hit.message.chat.id) : null, name: hit?.message?.from?.first_name };
}
