// Integrations page API (I5): status, per-workspace credentials (encrypted, masked), test,
// disconnect, synchronization history and alert delivery log. Changes require integrations.manage + audit.
import { z } from 'zod';
import { config } from '../config.js';
import { one, query, tx } from '../db/pool.js';
import { Router, parse, HttpError, paging } from '../lib/http.js';
import { maskSecret } from '../lib/crypto.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { can } from '../services/permissions.js';
import { audit } from '../services/audit.js';
import { emit } from '../services/events.js';
import { getIntegration, saveIntegration, logEvent, statusOf, PROVIDERS } from '../integrations/store.js';
import * as twilio from '../integrations/twilio.js';
import * as stripe from '../integrations/stripe.js';
import * as google from '../integrations/google.js';
import * as telegram from '../integrations/telegram.js';

const r = Router();
r.use(requireAuth);

const META = {
  twilio: { name: 'Messaging — Twilio WhatsApp / SMS', purpose: 'Talk to customers and capture leads from incoming messages.', limits: twilio.LIMITS,
    can: ['Receive WhatsApp/SMS messages and create contacts + leads', 'Reply from the conversation view', 'Show sent / delivered / read / failed status', 'Retry failed messages'] },
  stripe: { name: 'Payments — Stripe (test mode)', purpose: 'Collect payments for opportunities.', limits: stripe.LIMITS,
    can: ['Create hosted payment links for an opportunity', 'Update status automatically from Stripe webhooks (paid, failed, expired, refunded)'] },
  google: { name: 'Calendar — Google Calendar (OAuth 2.0)', purpose: 'Book appointments on employees’ real calendars.', limits: google.LIMITS,
    can: ['Each employee connects their own Google account', 'Create, reschedule and cancel events', 'Warn about busy times before booking'] },
  telegram: { name: 'Notifications — Telegram bot', purpose: 'Alert employees outside the app when a lead escalates.', limits: telegram.LIMITS,
    can: ['Send escalation alerts to each employee’s own Telegram chat', 'Retry failed alerts up to 3 times'] },
};

const SECRET_FIELDS = { twilio: ['authToken'], stripe: ['secretKey', 'webhookSecret'], google: ['clientSecret'], telegram: ['botToken'] };
const REQUIRED = { twilio: ['authToken'], stripe: ['secretKey'], google: ['clientSecret'], telegram: ['botToken'] };

function publicView(provider, cfg) {
  if (!cfg) return {};
  const out = {};
  for (const [k, v] of Object.entries(cfg)) out[k] = SECRET_FIELDS[provider].includes(k) ? maskSecret(v) : v;
  return out;
}

function urlsFor(provider, token) {
  if (provider === 'twilio') return { 'Incoming message webhook (When a message comes in, HTTP POST)': `${config.appUrl}/webhooks/twilio/${token}/inbound`, 'Status callback (set automatically on each send)': `${config.appUrl}/webhooks/twilio/${token}/status` };
  if (provider === 'stripe') return { 'Webhook endpoint URL': `${config.appUrl}/webhooks/stripe/${token}`, 'Events to send': stripe.WEBHOOK_EVENTS.join(', ') };
  if (provider === 'google') return { 'Authorized redirect URI (Google Cloud → Credentials)': google.redirectUri(), 'Authorized JavaScript origin': config.appUrl };
  return {};
}

r.get('/integrations', async (req, res) => {
  const manage = can(req.user, 'integrations.manage');
  const ws = await one('SELECT webhook_token FROM workspaces WHERE id = $1', [req.ws]);
  const out = [];
  for (const p of PROVIDERS) {
    const integ = await getIntegration({ query }, req.ws, p);
    const base = { provider: p, ...META[p], status: integ?.error ? 'error' : statusOf(integ?.row), lastSuccessAt: integ?.row.last_success_at || null };
    if (!manage) { out.push(base); continue; }
    const { rows: errors } = await query(
      `SELECT created_at, kind, detail, http_status FROM integration_events WHERE workspace_id = $1 AND provider = $2 AND result IN ('error','rejected','retrying')
        ORDER BY created_at DESC LIMIT 5`, [req.ws, p]);
    out.push({
      ...base, config: publicView(p, integ?.config), lastError: integ?.error || integ?.row.last_error || null, lastErrorAt: integ?.row.last_error_at || null,
      connectedAt: integ?.row.updated_at || null, recentErrors: errors, urls: urlsFor(p, ws.webhook_token),
    });
  }
  res.json({ items: out, canManage: manage });
});

const schemas = {
  twilio: z.object({
    accountSid: z.string().trim().regex(/^AC[0-9a-fA-F]{32}$/, 'Account SID starts with AC and has 34 characters'),
    authToken: z.string().trim().min(16).max(64).optional(),
    fromNumber: z.string().trim().regex(/^(whatsapp:)?\+\d{6,16}$/, 'Use international format, e.g. +14155238886'),
    channel: z.enum(['whatsapp', 'sms']),
  }),
  stripe: z.object({
    secretKey: z.string().trim().regex(/^(sk|rk)_test_/, 'Use a TEST mode key (starts with sk_test_ or rk_test_)').optional(),
    webhookSecret: z.string().trim().regex(/^whsec_/, 'Webhook signing secret starts with whsec_').optional(),
  }),
  google: z.object({
    clientId: z.string().trim().regex(/\.apps\.googleusercontent\.com$/, 'Client ID ends with .apps.googleusercontent.com'),
    clientSecret: z.string().trim().min(10).max(200).optional(),
  }),
  telegram: z.object({ botToken: z.string().trim().regex(/^\d+:[A-Za-z0-9_-]{30,}$/, 'Bot token looks like 123456789:ABC...').optional() }),
};

async function test(provider, cfg) {
  if (provider === 'twilio') return twilio.testConnection(cfg);
  if (provider === 'stripe') return stripe.testConnection(cfg);
  if (provider === 'telegram') return telegram.getMe(cfg);
  if (provider === 'google') return { ok: true, detail: 'Client saved. Each employee completes the Google consent screen to verify it.' };
  return { ok: false, detail: 'Unknown provider' };
}

r.put('/integrations/:provider', requirePerm('integrations.manage'), async (req, res) => {
  const p = req.params.provider;
  if (!PROVIDERS.includes(p)) throw new HttpError(404, 'Unknown integration');
  const b = parse(schemas[p], req.body);
  const existing = await getIntegration({ query }, req.ws, p);
  const cfg = { ...(existing?.config || {}) };
  for (const [k, v] of Object.entries(b)) if (v !== undefined && v !== '') cfg[k] = v;
  for (const k of REQUIRED[p]) if (!cfg[k]) throw new HttpError(400, `${k} is required`);
  const t = await test(p, cfg);
  await logEvent({ query }, { workspaceId: req.ws, provider: p, direction: 'outbound', kind: 'connection.test', result: t.ok ? 'ok' : 'error', detail: t.detail });
  if (!t.ok) throw new HttpError(400, `Could not connect: ${t.detail}. Nothing was saved.`);
  if (p === 'telegram') cfg.botUsername = t.username;
  await tx(async (db) => {
    await saveIntegration(db, req.ws, p, cfg, {}, req.user.id);
    const changed = Object.keys(b).filter((k) => b[k] !== undefined && b[k] !== existing?.config?.[k]);
    await audit(db, { workspaceId: req.ws, actor: req.user, action: existing ? 'integration.updated' : 'integration.connected', targetType: 'integration', targetId: p, targetLabel: META[p].name,
      after: { fields_changed: changed.map((k) => (SECRET_FIELDS[p].includes(k) ? `${k} (secret)` : k)), check: t.detail } });
    emit(db, req.ws, 'integrations', {});
  });
  res.json({ ok: true, detail: t.detail });
});

r.post('/integrations/:provider/test', requirePerm('integrations.manage'), async (req, res) => {
  const p = req.params.provider;
  const integ = await getIntegration({ query }, req.ws, p);
  if (!integ?.config) throw new HttpError(409, integ?.error || 'Not connected');
  const t = await test(p, integ.config);
  await logEvent({ query }, { workspaceId: req.ws, provider: p, direction: 'outbound', kind: 'connection.test', result: t.ok ? 'ok' : 'error', detail: t.detail });
  res.json(t);
});

r.delete('/integrations/:provider', requirePerm('integrations.manage'), async (req, res) => {
  const p = req.params.provider;
  if (!PROVIDERS.includes(p)) throw new HttpError(404, 'Unknown integration');
  await tx(async (db) => {
    const { rowCount } = await db.query('DELETE FROM integrations WHERE workspace_id = $1 AND provider = $2', [req.ws, p]);
    if (!rowCount) throw new HttpError(404, 'Not connected');
    if (p === 'google') await db.query("UPDATE calendar_connections SET status = 'needs_reconnect', last_error = 'Workspace Google app was disconnected' WHERE workspace_id = $1", [req.ws]);
    await audit(db, { workspaceId: req.ws, actor: req.user, action: 'integration.disconnected', targetType: 'integration', targetId: p, targetLabel: META[p].name });
    emit(db, req.ws, 'integrations', {});
  });
  res.json({ ok: true });
});

// Synchronization history (I5.4)
r.get('/integration-events', requirePerm('integrations.manage'), async (req, res) => {
  const params = [req.ws];
  const where = ['workspace_id = $1'];
  if (req.query.provider) { params.push(String(req.query.provider)); where.push(`provider = $${params.length}`); }
  if (req.query.result) { params.push(String(req.query.result)); where.push(`result = $${params.length}`); }
  if (req.query.direction) { params.push(String(req.query.direction)); where.push(`direction = $${params.length}`); }
  const { limit, offset, page, pageSize } = paging(req.query);
  const [{ rows }, count] = await Promise.all([
    query(`SELECT * FROM integration_events WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`, params),
    one(`SELECT count(*) AS n FROM integration_events WHERE ${where.join(' AND ')}`, params),
  ]);
  res.json({ items: rows, total: count.n, page, pageSize });
});

// Escalation alert deliveries (I4.4 — failed alerts visible to admins)
r.get('/alerts', requirePerm('integrations.manage'), async (req, res) => {
  const { rows } = await query(
    `SELECT a.id, a.status, a.attempts, a.last_error, a.created_at, a.sent_at, u.name AS user_name, l.title AS lead_title, a.lead_id
       FROM alert_outbox a JOIN users u ON u.id = a.user_id LEFT JOIN leads l ON l.id = a.lead_id
      WHERE a.workspace_id = $1 ORDER BY a.created_at DESC LIMIT 100`, [req.ws]);
  res.json({ items: rows });
});

r.post('/alerts/:id/retry', requirePerm('integrations.manage'), async (req, res) => {
  const { rowCount } = await query(
    "UPDATE alert_outbox SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL WHERE id = $1 AND workspace_id = $2 AND status IN ('failed','skipped')",
    [req.params.id, req.ws]);
  if (!rowCount) throw new HttpError(409, 'Only failed or skipped alerts can be retried.');
  res.json({ ok: true });
});

export default r;
