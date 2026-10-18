// Meta WhatsApp Cloud API messaging (alternative to Twilio for I1).
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
//   Send:     POST https://graph.facebook.com/{version}/{phone-number-id}/messages
//   Webhooks: GET  verification (hub.mode / hub.verify_token / hub.challenge)
//             POST events signed with X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body)
import crypto from 'node:crypto';
import { providerFetch } from './http.js';
import { safeEqual } from '../lib/crypto.js';

export const DEFAULT_GRAPH_VERSION = 'v23.0';

export const LIMITS = [
  'Meta test phone number: you can only message phone numbers added to the recipient list (up to 5) on WhatsApp → API Setup.',
  'Free-form replies are allowed only within 24 hours of the customer’s last message. Outside that window WhatsApp requires an approved template.',
  'The temporary access token from API Setup expires after about 24 hours — paste a new one (or use a permanent System User token).',
  'Media (images, voice notes) is not shown — text only.',
];

const graph = (cfg) => `https://graph.facebook.com/${cfg.graphVersion || DEFAULT_GRAPH_VERSION}`;
const bearer = (cfg) => ({ Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' });

// Verify token used for the webhook handshake. Derived from the workspace's secret webhook token,
// so nothing extra has to be stored; it is shown to admins on the Integrations page.
export function verifyTokenFor(webhookToken) {
  return `lg_${crypto.createHash('sha256').update(`meta-verify:${webhookToken}`).digest('hex').slice(0, 24)}`;
}

export function validSignature(appSecret, rawBody, header) {
  if (!header || !appSecret) return false;
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  return safeEqual(expected, header);
}

export async function testConnection(cfg) {
  const r = await providerFetch(`${graph(cfg)}/${encodeURIComponent(cfg.phoneNumberId)}?fields=display_phone_number,verified_name`, { headers: bearer(cfg) });
  if (r.ok) return { ok: true, detail: `Number ${r.json?.display_phone_number || ''} (${r.json?.verified_name || 'WhatsApp Business'})`.trim() };
  return { ok: false, detail: r.networkError || explain(r.json?.error?.code, r.json?.error?.message) || `HTTP ${r.status}` };
}

// "+923001234567" -> "923001234567" (Meta wants digits only)
export const toWaId = (phone) => String(phone).replace(/[^\d]/g, '');

export async function send(cfg, { to, body }) {
  return providerFetch(`${graph(cfg)}/${encodeURIComponent(cfg.phoneNumberId)}/messages`, {
    method: 'POST', headers: bearer(cfg),
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: toWaId(to), type: 'text', text: { preview_url: false, body } }),
  }, { retries: 0 }); // retries are scheduled by the worker
}

const EXPLAIN = {
  190: 'Meta access token expired or is invalid. Paste a new token on the Integrations page (WhatsApp → API Setup → Generate access token).',
  10: 'The access token does not have WhatsApp permissions for this app.',
  100: 'Meta rejected a parameter (check the Phone number ID and the customer’s number).',
  131030: 'This phone number is not in the test recipient list. Add it on Meta → WhatsApp → API Setup → To → Manage phone number list.',
  131047: 'More than 24 hours have passed since the customer’s last message, so WhatsApp only allows an approved template. Ask the customer to message you first.',
  131026: 'The message could not be delivered (the number may not have WhatsApp, or has not accepted the latest terms).',
  131021: 'The recipient is the same as the sender number.',
  131056: 'Too many messages to this number in a short time. Wait a moment and retry.',
  130429: 'Meta rate limit reached. Wait a moment and retry.',
  133010: 'The sender phone number is not registered with the WhatsApp Cloud API.',
  368: 'The WhatsApp account is temporarily blocked for policy reasons.',
};

export function explain(code, message) {
  if (code && EXPLAIN[code]) return `${EXPLAIN[code]} (Meta error ${code})`;
  if (code || message) return `${message || 'Meta error'}${code ? ` (Meta error ${code})` : ''}`;
  return null;
}

// Text shown for non-text inbound messages
export function bodyOf(msg) {
  switch (msg.type) {
    case 'text': return msg.text?.body || '';
    case 'button': return msg.button?.text || '[button reply]';
    case 'interactive': return msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '[interactive reply]';
    case 'reaction': return `[reaction ${msg.reaction?.emoji || ''}]`.trim();
    default: return `[${msg.type || 'media'} message — not displayed]`;
  }
}
