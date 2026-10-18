// Twilio messaging (I1): WhatsApp Sandbox or SMS. Uses Twilio's REST API directly.
// Docs: https://www.twilio.com/docs/messaging/api/message-resource
//       https://www.twilio.com/docs/usage/webhooks/webhooks-security
import crypto from 'node:crypto';
import { providerFetch } from './http.js';
import { safeEqual } from '../lib/crypto.js';

const API = 'https://api.twilio.com/2010-04-01';

export const LIMITS = [
  'WhatsApp Sandbox: only phones that have sent the sandbox join phrase (e.g. "join <two-words>") to the sandbox number can send or receive messages.',
  'WhatsApp: you can send free-form replies only within 24 hours of the customer’s last message.',
  'Sandbox and trial messages are for testing; trial SMS can only reach verified numbers.',
  'Media (images, voice notes) is not shown — text only.',
];

function auth(cfg) {
  return `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')}`;
}

export function addressFor(cfg, phone) {
  return cfg.channel === 'whatsapp' ? `whatsapp:${phone}` : phone;
}

export function fromAddress(cfg) {
  const f = String(cfg.fromNumber).trim();
  if (cfg.channel === 'whatsapp' && !f.startsWith('whatsapp:')) return `whatsapp:${f}`;
  return f;
}

// X-Twilio-Signature = Base64(HMAC-SHA1(authToken, fullUrl + sorted(key+value of POST params)))
export function validSignature(authToken, url, params, signature) {
  if (!signature) return false;
  const data = Object.keys(params).sort().reduce((acc, k) => {
    const v = params[k];
    return acc + (Array.isArray(v) ? v.map((x) => k + x).join('') : k + v);
  }, url);
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
  return safeEqual(expected, signature);
}

export async function testConnection(cfg) {
  const r = await providerFetch(`${API}/Accounts/${encodeURIComponent(cfg.accountSid)}.json`, { headers: { Authorization: auth(cfg) } });
  if (r.ok) return { ok: true, detail: `Account "${r.json?.friendly_name}" (${r.json?.status})` };
  return { ok: false, detail: r.networkError || explain(r.json?.code, r.json?.message) || `HTTP ${r.status}` };
}

export async function send(cfg, { to, body, statusCallback }) {
  const params = new URLSearchParams({ To: addressFor(cfg, to), From: fromAddress(cfg), Body: body });
  if (statusCallback) params.set('StatusCallback', statusCallback);
  const r = await providerFetch(`${API}/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: auth(cfg), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  }, { retries: 0 }); // retries are scheduled by the worker so the employee is not kept waiting
  return r;
}

const EXPLAIN = {
  20003: 'Twilio rejected the credentials (check Account SID and Auth Token).',
  20404: 'Twilio resource not found (check the Account SID).',
  21211: 'The customer’s phone number is not valid. Use international format, e.g. +923001234567.',
  21408: 'Your Twilio account is not allowed to send to this country (Messaging Geographic Permissions).',
  21606: 'The "From" number is not a valid Twilio number for this account/channel.',
  21608: 'Trial accounts can only send SMS to verified numbers. Verify the number in the Twilio console.',
  21610: 'The customer replied STOP and has unsubscribed from messages.',
  21614: 'The number is not a mobile number that can receive messages.',
  63007: 'The WhatsApp sender ("From") is not set up for this account. Use the sandbox number, e.g. whatsapp:+14155238886.',
  63015: 'This phone has not joined the WhatsApp Sandbox. Ask the customer to send the join phrase first.',
  63016: 'WhatsApp only allows free-form replies within 24 hours of the customer’s last message.',
  30003: 'The phone is unreachable (switched off or out of coverage).',
  30005: 'Unknown destination number.',
  30006: 'The destination is a landline or cannot receive messages.',
  30007: 'The carrier filtered this message as spam.',
  30008: 'Unknown delivery error reported by the carrier.',
};

export function explain(code, message) {
  if (code && EXPLAIN[code]) return `${EXPLAIN[code]} (Twilio error ${code})`;
  if (code || message) return `${message || 'Twilio error'}${code ? ` (Twilio error ${code})` : ''}`;
  return null;
}
