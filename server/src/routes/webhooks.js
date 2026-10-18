// Provider webhooks (I1.1, I1.2, I1.4, I1.8, I2.2–I2.5). Every request is verified with the provider's
// signature before anything changes; forged requests are rejected AND recorded (sync history + audit).
import express from 'express';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { Router } from '../lib/http.js';
import { getIntegration, logEvent } from '../integrations/store.js';
import * as twilio from '../integrations/twilio.js';
import * as stripe from '../integrations/stripe.js';
import { audit } from '../services/audit.js';
import { handleInbound, handleStatus } from '../services/messaging.js';
import { applyStripeEvent } from '../services/payments.js';

const r = Router();
const db0 = { query };

async function workspaceByToken(token) {
  if (!token || token.length < 10) return null;
  return one('SELECT id, name FROM workspaces WHERE webhook_token = $1', [token]);
}

async function reject(ws, provider, kind, reason, req) {
  await logEvent(db0, { workspaceId: ws.id, provider, direction: 'inbound', kind, result: 'rejected', detail: `${reason} (from ${req.ip})` });
  await audit(db0, { workspaceId: ws.id, actor: null, action: 'webhook.rejected', targetType: 'integration', targetId: provider, after: { kind, reason, ip: req.ip } });
}

// ---------- Twilio (application/x-www-form-urlencoded) ----------
const twimlOk = (res) => res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

function twilioVerified(cfg, req) {
  const sig = req.get('x-twilio-signature');
  const candidates = [`${config.appUrl}${req.originalUrl}`, `${req.protocol}://${req.get('host')}${req.originalUrl}`];
  return candidates.some((url) => twilio.validSignature(cfg.authToken, url, req.body || {}, sig));
}

for (const kind of ['inbound', 'status']) {
  r.post(`/twilio/:token/${kind}`, express.urlencoded({ extended: false, limit: '100kb' }), async (req, res) => {
    const ws = await workspaceByToken(req.params.token);
    if (!ws) return res.status(404).send('Unknown endpoint');
    const integ = await getIntegration(db0, ws.id, 'twilio');
    const eventKind = kind === 'inbound' ? 'message.received' : 'message.status';
    if (!integ?.config) { await reject(ws, 'twilio', eventKind, 'Twilio is not connected for this workspace', req); return res.status(403).send('Not connected'); }
    if (!twilioVerified(integ.config, req)) { await reject(ws, 'twilio', eventKind, 'Invalid X-Twilio-Signature (forged or altered request)', req); return res.status(403).send('Invalid signature'); }
    try {
      const out = kind === 'inbound' ? await handleInbound(ws, req.body) : await handleStatus(ws, req.body);
      if (out.result === 'rejected') await reject(ws, 'twilio', eventKind, out.detail, req);
      return twimlOk(res);
    } catch (e) {
      console.error('[twilio webhook]', e);
      await logEvent(db0, { workspaceId: ws.id, provider: 'twilio', direction: 'inbound', kind: eventKind, result: 'error', reference: req.body?.MessageSid, detail: e.message });
      return res.status(500).send('Temporary error'); // Twilio will retry
    }
  });
}

// ---------- Stripe (raw JSON body is required for signature verification) ----------
r.post('/stripe/:token', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const ws = await workspaceByToken(req.params.token);
  if (!ws) return res.status(404).json({ error: 'Unknown endpoint' });
  const integ = await getIntegration(db0, ws.id, 'stripe');
  if (!integ?.config?.webhookSecret) { await reject(ws, 'stripe', 'webhook', 'Stripe webhook signing secret is not configured', req); return res.status(403).json({ error: 'Not configured' }); }
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const v = stripe.verifySignature(raw, req.get('stripe-signature'), integ.config.webhookSecret);
  if (!v.ok) { await reject(ws, 'stripe', 'webhook', v.reason, req); return res.status(400).json({ error: v.reason }); }
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { await reject(ws, 'stripe', 'webhook', 'Body is not JSON', req); return res.status(400).json({ error: 'Bad JSON' }); }
  if (event.livemode) { await reject(ws, 'stripe', event.type, 'Live-mode event refused (test mode only)', req); return res.status(400).json({ error: 'Live mode not accepted' }); }
  try {
    const result = await applyStripeEvent(ws.id, event);
    res.json({ received: true, result });
  } catch (e) {
    console.error('[stripe webhook]', e);
    await logEvent(db0, { workspaceId: ws.id, provider: 'stripe', direction: 'inbound', kind: event.type, result: 'error', reference: event.id, detail: e.message });
    res.status(500).json({ error: 'Temporary error' }); // Stripe retries with backoff
  }
});

export default r;
