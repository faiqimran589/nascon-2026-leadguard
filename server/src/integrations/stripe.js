// Stripe payments in TEST mode (I2), via Stripe's REST API.
// Docs: https://docs.stripe.com/api/checkout/sessions/create
//       https://docs.stripe.com/webhooks#verify-manually
import crypto from 'node:crypto';
import { providerFetch, formBody } from './http.js';
import { safeEqual } from '../lib/crypto.js';

const API = 'https://api.stripe.com/v1';

export const LIMITS = [
  'Test mode only: use Stripe test cards such as 4242 4242 4242 4242 (any future date, any CVC). No real money moves.',
  'Card details are typed only on Stripe’s hosted Checkout page; this platform never sees or stores them.',
  'Payment links (Checkout Sessions) expire after the time you choose (30 minutes to 24 hours) if not paid.',
  'Refunds are made in the Stripe Dashboard and are reflected here automatically via webhook.',
];

export const WEBHOOK_EVENTS = [
  'checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed', 'payment_intent.payment_failed', 'charge.refunded',
];

const headers = (cfg) => ({ Authorization: `Bearer ${cfg.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' });

export async function testConnection(cfg) {
  const r = await providerFetch(`${API}/balance`, { headers: headers(cfg) });
  if (r.ok) return { ok: true, detail: `Test mode: ${r.json?.livemode === false ? 'yes' : 'no'}` };
  return { ok: false, detail: r.networkError || r.json?.error?.message || `HTTP ${r.status}` };
}

export async function createCheckout(cfg, { paymentId, workspaceId, amountCents, currency, name, description, customerEmail, successUrl, cancelUrl, expiresInMinutes }) {
  const body = formBody({
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer_email: customerEmail || undefined,
    expires_at: Math.floor(Date.now() / 1000) + Math.max(30, Math.min(1440, expiresInMinutes || 60)) * 60,
    client_reference_id: paymentId,
    metadata: { payment_id: paymentId, workspace_id: workspaceId },
    payment_intent_data: { metadata: { payment_id: paymentId, workspace_id: workspaceId }, description: description || name },
    line_items: [{ quantity: 1, price_data: { currency, unit_amount: amountCents, product_data: { name } } }],
  });
  return providerFetch(`${API}/checkout/sessions`, {
    method: 'POST', headers: { ...headers(cfg), 'Idempotency-Key': `checkout-${paymentId}` }, body,
  });
}

export async function expireCheckout(cfg, sessionId) {
  return providerFetch(`${API}/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, { method: 'POST', headers: headers(cfg) });
}

// Stripe-Signature: t=timestamp,v1=hex(HMAC-SHA256(secret, `${t}.${rawBody}`)); reject if older than 5 min.
export function verifySignature(rawBody, header, secret, toleranceSec = 300) {
  if (!header || !secret) return { ok: false, reason: 'Missing Stripe-Signature header or webhook secret' };
  let t = null; const v1 = [];
  for (const item of header.split(',')) {
    const [k, v] = item.split('=');
    if (k === 't') t = v; else if (k === 'v1') v1.push(v);
  }
  if (!t || !v1.length) return { ok: false, reason: 'Malformed Stripe-Signature header' };
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody.toString('utf8')}`).digest('hex');
  if (!v1.some((sig) => safeEqual(sig, expected))) return { ok: false, reason: 'Signature does not match (wrong webhook secret or altered body)' };
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return { ok: false, reason: 'Timestamp outside tolerance (possible replay)' };
  return { ok: true };
}

export const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
export const toMinor = (amount, currency) => Math.round(Number(amount) * (ZERO_DECIMAL.has(currency) ? 1 : 100));
export const fromMinor = (cents, currency) => Number(cents) / (ZERO_DECIMAL.has(currency) ? 1 : 100);
