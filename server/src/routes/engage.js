// Customer engagement: conversations & messages (I1), payment requests (I2), appointments & calendar (I3).
import { z } from 'zod';
import { config } from '../config.js';
import { one, query, tx } from '../db/pool.js';
import { Router, parse, HttpError, notFound, paging } from '../lib/http.js';
import { encryptJson, decryptJson, randomToken } from '../lib/crypto.js';
import { isValidTimeZone, zonedToUtc } from '../lib/time.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { can } from '../services/permissions.js';
import { audit } from '../services/audit.js';
import { addActivity } from '../services/activity.js';
import { emit } from '../services/events.js';
import { recordLeadAction } from '../services/leads.js';
import { sendMessage, retryMessage } from '../services/messaging.js';
import { createPaymentRequest, expirePayment, formatMoney } from '../services/payments.js';
import { googleConfig, googleCall, busyIntervals } from '../services/calendar.js';
import { contactScope, oppScope } from '../services/crm.js';
import { logEvent } from '../integrations/store.js';
import * as google from '../integrations/google.js';

const r = Router();
const db0 = { query };

// ---------- Google OAuth callback (browser redirect, outside /api) ----------
export const oauthRouter = Router();
oauthRouter.get('/google/callback', async (req, res) => {
  const back = (q) => res.redirect(`/profile?${new URLSearchParams(q)}`);
  if (!req.user) return res.redirect('/login');
  if (req.query.error) return back({ calendar: 'error', reason: `Google: ${req.query.error}` });
  const st = await one('DELETE FROM oauth_states WHERE state = $1 RETURNING *', [String(req.query.state || '')]);
  if (!st || st.user_id !== req.user.id || new Date(st.expires_at) < new Date()) return back({ calendar: 'error', reason: 'The sign-in attempt expired or was not started from this session. Try again.' });
  let cfg;
  try { cfg = await googleConfig(req.ws); } catch (e) { return back({ calendar: 'error', reason: e.message }); }
  const t = await google.exchangeCode(cfg, String(req.query.code || ''));
  if (!t.ok) {
    await logEvent(db0, { workspaceId: req.ws, provider: 'google', direction: 'outbound', kind: 'oauth.exchange', result: 'error', reference: req.user.id, httpStatus: t.status, detail: t.networkError || t.json?.error_description || t.json?.error });
    return back({ calendar: 'error', reason: t.json?.error_description || 'Google refused the sign-in. Check the client ID/secret and redirect URI.' });
  }
  const scopes = String(t.json.scope || '');
  if (!scopes.includes('calendar.events')) return back({ calendar: 'error', reason: 'Calendar permission was not granted. Tick the calendar checkbox on the consent screen.' });
  const email = google.emailFromIdToken(t.json.id_token || '');
  const prev = await one('SELECT tokens_enc FROM calendar_connections WHERE user_id = $1', [req.user.id]);
  let refresh = t.json.refresh_token;
  if (!refresh && prev) { try { refresh = decryptJson(prev.tokens_enc).refresh_token; } catch { /* ignore */ } }
  await tx(async (db) => {
    await db.query(
      `INSERT INTO calendar_connections (user_id, workspace_id, google_email, tokens_enc, expires_at, status, connected_at)
       VALUES ($1,$2,$3,$4, now() + make_interval(secs => $5), 'connected', now())
       ON CONFLICT (user_id) DO UPDATE SET google_email = EXCLUDED.google_email, tokens_enc = EXCLUDED.tokens_enc,
         expires_at = EXCLUDED.expires_at, status = 'connected', last_error = NULL, connected_at = now()`,
      [req.user.id, req.ws, email, encryptJson({ access_token: t.json.access_token, refresh_token: refresh }), Number(t.json.expires_in || 3600)]);
    await logEvent(db, { workspaceId: req.ws, provider: 'google', direction: 'outbound', kind: 'oauth.exchange', result: 'ok', reference: email || req.user.id });
    await audit(db, { workspaceId: req.ws, actor: req.user, action: 'calendar.connected', targetType: 'user', targetId: req.user.id, targetLabel: email });
    emit(db, req.ws, 'team', {});
  });
  back({ calendar: 'connected' });
});

r.use(requireAuth);

r.post('/calendar/connect', async (req, res) => {
  const cfg = await googleConfig(req.ws);
  const state = randomToken(24);
  await query("INSERT INTO oauth_states (state, user_id, workspace_id, expires_at) VALUES ($1,$2,$3, now() + interval '10 minutes')", [state, req.user.id, req.ws]);
  res.json({ url: google.authUrl(cfg, state) });
});

r.post('/calendar/disconnect', async (req, res) => {
  const conn = await one('SELECT * FROM calendar_connections WHERE user_id = $1', [req.user.id]);
  if (!conn) throw new HttpError(404, 'Calendar is not connected');
  try {
    const tok = decryptJson(conn.tokens_enc);
    const rv = await google.revoke(tok.refresh_token || tok.access_token);
    await logEvent(db0, { workspaceId: req.ws, provider: 'google', direction: 'outbound', kind: 'oauth.revoke', result: rv.ok || rv.status === 400 ? 'ok' : 'error', reference: conn.google_email, httpStatus: rv.status });
  } catch { /* token unreadable: still remove locally */ }
  await query('DELETE FROM calendar_connections WHERE user_id = $1', [req.user.id]);
  await audit(db0, { workspaceId: req.ws, actor: req.user, action: 'calendar.disconnected', targetType: 'user', targetId: req.user.id, targetLabel: conn.google_email });
  emit(db0, req.ws, 'team', {});
  res.json({ ok: true });
});

// ---------- Conversations (I1.1, I1.6) ----------
async function visibleConversation(req, id) {
  const params = [id, req.ws];
  const scope = contactScope(req.user, params);
  const cv = await one(
    `SELECT cv.*, c.first_name, c.last_name, c.phone, c.opted_out, c.owner_id, u.name AS owner_name
       FROM conversations cv JOIN contacts c ON c.id = cv.contact_id LEFT JOIN users u ON u.id = c.owner_id
      WHERE cv.id = $1 AND cv.workspace_id = $2 AND c.deleted_at IS NULL AND ${scope}`, params);
  if (!cv) throw notFound('Conversation');
  return cv;
}

r.get('/conversations', async (req, res) => {
  const params = [req.ws];
  const scope = contactScope(req.user, params);
  const { limit, offset, page, pageSize } = paging(req.query);
  const from = `FROM conversations cv JOIN contacts c ON c.id = cv.contact_id LEFT JOIN users u ON u.id = c.owner_id
                WHERE cv.workspace_id = $1 AND c.deleted_at IS NULL AND ${scope}`;
  const [{ rows }, count] = await Promise.all([
    query(`SELECT cv.*, c.first_name, c.last_name, c.phone, c.opted_out, u.name AS owner_name,
                  (SELECT row_to_json(m) FROM (SELECT body, direction, status, created_at FROM messages WHERE conversation_id = cv.id ORDER BY created_at DESC LIMIT 1) m) AS last_message
             ${from} ORDER BY cv.last_message_at DESC LIMIT ${limit} OFFSET ${offset}`, params),
    one(`SELECT count(*) AS n ${from}`, params),
  ]);
  res.json({ items: rows, total: count.n, page, pageSize });
});

r.get('/conversations/:id', async (req, res) => {
  const cv = await visibleConversation(req, req.params.id);
  const { rows } = await query(
    `SELECT m.*, u.name AS sent_by_name FROM messages m LEFT JOIN users u ON u.id = m.sent_by
      WHERE m.conversation_id = $1 ORDER BY m.created_at DESC LIMIT 200`, [cv.id]);
  if (cv.unread_count > 0 && cv.owner_id === req.user.id) await query('UPDATE conversations SET unread_count = 0 WHERE id = $1', [cv.id]);
  res.json({ conversation: cv, messages: rows.reverse() });
});

r.post('/contacts/:id/messages', requirePerm('crm.edit'), async (req, res) => {
  const b = parse(z.object({ body: z.string().trim().min(1, 'Message cannot be empty').max(1600) }), req.body);
  const params = [req.params.id, req.ws];
  const scope = contactScope(req.user, params);
  if (!(await one(`SELECT 1 FROM contacts c WHERE c.id = $1 AND c.workspace_id = $2 AND c.deleted_at IS NULL AND ${scope}`, params))) throw notFound('Contact');
  const m = await sendMessage({ workspaceId: req.ws, contactId: req.params.id, body: b.body, user: req.user });
  res.status(201).json(m);
});

r.post('/messages/:id/retry', requirePerm('crm.edit'), async (req, res) => {
  const m = await one('SELECT conversation_id FROM messages WHERE id = $1 AND workspace_id = $2', [req.params.id, req.ws]);
  if (!m) throw notFound('Message');
  await visibleConversation(req, m.conversation_id);
  res.json(await retryMessage({ workspaceId: req.ws, messageId: req.params.id }));
});

// ---------- Payments (I2) ----------
async function visibleOppRow(req, id) {
  const params = [id, req.ws];
  const scope = oppScope(req.user, params);
  const o = await one(`SELECT o.* FROM opportunities o JOIN contacts c ON c.id = o.contact_id WHERE o.id = $1 AND o.workspace_id = $2 AND o.deleted_at IS NULL AND ${scope}`, params);
  if (!o) throw notFound('Opportunity');
  return o;
}

r.post('/opportunities/:id/payments', requirePerm('crm.edit'), async (req, res) => {
  const b = parse(z.object({
    amount: z.number().positive().max(999999), currency: z.string().length(3), description: z.string().trim().max(200).optional(),
    expiresInMinutes: z.number().int().min(30).max(1440).optional(),
  }), req.body);
  await visibleOppRow(req, req.params.id);
  const p = await createPaymentRequest({ workspaceId: req.ws, opportunityId: req.params.id, ...b, user: req.user });
  res.status(201).json(p);
});

async function visiblePayment(req, id) {
  const p = await one('SELECT * FROM payments WHERE id = $1 AND workspace_id = $2', [id, req.ws]);
  if (!p) throw notFound('Payment');
  await visibleOppRow(req, p.opportunity_id);
  return p;
}

r.post('/payments/:id/expire', requirePerm('crm.edit'), async (req, res) => {
  await visiblePayment(req, req.params.id);
  res.json(await expirePayment({ workspaceId: req.ws, paymentId: req.params.id, user: req.user }));
});

// Send the payment link to the customer over the messaging channel.
r.post('/payments/:id/send', requirePerm('crm.edit'), async (req, res) => {
  const p = await visiblePayment(req, req.params.id);
  if (p.status !== 'pending' || !p.checkout_url) throw new HttpError(409, 'Only pending payment links can be sent.');
  const body = `Hi! Here is your secure payment link for ${formatMoney(p.amount_cents, p.currency)}${p.description ? ` (${p.description})` : ''}: ${p.checkout_url}`;
  res.status(201).json(await sendMessage({ workspaceId: req.ws, contactId: p.contact_id, body, user: req.user }));
});

// ---------- Appointments (I3) ----------
const apptBody = z.object({
  contactId: z.string().uuid(), opportunityId: z.string().uuid().nullable().optional(), userId: z.string().uuid(),
  title: z.string().trim().min(1).max(160), notes: z.string().trim().max(2000).optional(),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Start must be a local date-time'),
  durationMinutes: z.number().int().min(5).max(600), timezone: z.string().refine(isValidTimeZone, 'Unknown time zone'),
  force: z.boolean().optional(),
});

function overlaps(busy, start, end) {
  return busy.filter((b) => new Date(b.start) < end && new Date(b.end) > start);
}

r.get('/appointments', async (req, res) => {
  if (!can(req.user, 'crm.view')) throw new HttpError(403, 'You do not have permission to view appointments.');
  const params = [req.ws];
  const where = ['a.workspace_id = $1'];
  if (!can(req.user, 'crm.view_all')) { params.push(req.user.id); where.push(`(a.user_id = $${params.length} OR c.owner_id = $${params.length})`); }
  if (req.query.range === 'past') where.push('a.start_at < now()');
  else if (req.query.range === 'week') where.push("a.start_at >= now() AND a.start_at < now() + interval '7 days' AND a.status = 'scheduled'");
  else where.push('a.start_at >= now()');
  if (req.query.scope === 'personal') { params.push(req.user.id); where.push(`a.user_id = $${params.length}`); }
  const { rows } = await query(
    `SELECT a.*, u.name AS employee, c.first_name || ' ' || c.last_name AS contact_name, o.title AS opportunity_title
       FROM appointments a JOIN users u ON u.id = a.user_id JOIN contacts c ON c.id = a.contact_id LEFT JOIN opportunities o ON o.id = a.opportunity_id
      WHERE ${where.join(' AND ')} ORDER BY a.start_at ${req.query.range === 'past' ? 'DESC' : 'ASC'} LIMIT 200`, params);
  res.json({ items: rows });
});

r.get('/calendar/busy', async (req, res) => {
  const b = parse(z.object({ userId: z.string().uuid(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), timezone: z.string().refine(isValidTimeZone), excludeAppointmentId: z.string().uuid().optional() }), req.query);
  const u = await one('SELECT id FROM users WHERE id = $1 AND workspace_id = $2', [b.userId, req.ws]);
  if (!u) throw notFound('Employee');
  const from = zonedToUtc(`${b.date}T00:00`, b.timezone);
  const to = new Date(from.getTime() + 24 * 3600_000);
  res.json({ busy: await busyIntervals(req.ws, b.userId, from, to, { excludeAppointmentId: b.excludeAppointmentId }) });
});

function eventBody(a, contact, tz) {
  return {
    summary: a.title,
    description: [a.notes, `Customer: ${contact.first_name} ${contact.last_name}`.trim(), contact.phone ? `Phone: ${contact.phone}` : null, contact.email ? `Email: ${contact.email}` : null, `Open in LeadGuard: ${config.appUrl}/contacts/${contact.id}`].filter(Boolean).join('\n'),
    start: { dateTime: a.start.toISOString(), timeZone: tz },
    end: { dateTime: a.end.toISOString(), timeZone: tz },
  };
}

r.post('/appointments', requirePerm('crm.edit'), async (req, res) => {
  const b = parse(apptBody, req.body);
  const cp = [b.contactId, req.ws];
  const contact = await one(`SELECT c.* FROM contacts c WHERE c.id = $1 AND c.workspace_id = $2 AND c.deleted_at IS NULL AND ${contactScope(req.user, cp)}`, cp);
  if (!contact) throw notFound('Contact');
  if (b.opportunityId && !(await one('SELECT 1 FROM opportunities WHERE id = $1 AND contact_id = $2 AND deleted_at IS NULL', [b.opportunityId, contact.id]))) throw notFound('Opportunity');
  const emp = await one('SELECT id, name, active FROM users WHERE id = $1 AND workspace_id = $2', [b.userId, req.ws]);
  if (!emp?.active) throw notFound('Employee');
  if (emp.id !== req.user.id && !can(req.user, 'leads.reassign') && contact.owner_id !== req.user.id) throw new HttpError(403, 'You can only book on your own calendar or for contacts you own.');
  const start = zonedToUtc(b.start, b.timezone);
  const end = new Date(start.getTime() + b.durationMinutes * 60_000);
  if (start < new Date(Date.now() - 5 * 60_000)) throw new HttpError(400, 'The appointment time is in the past.');
  const busy = await busyIntervals(req.ws, emp.id, new Date(start.getTime() - 60_000), new Date(end.getTime() + 60_000));
  const conflicts = overlaps(busy, start, end);
  if (conflicts.length && !b.force) throw new HttpError(409, `${emp.name} is busy at that time (${conflicts.length} overlapping event${conflicts.length > 1 ? 's' : ''}). Pick another time or confirm to double-book.`, { conflicts, code: 'conflict' });
  const ev = await googleCall(req.ws, emp.id, 'calendar.event.create', (t) => google.createEvent(t, eventBody({ title: b.title, notes: b.notes, start, end }, contact, b.timezone)));
  const appt = await tx(async (db) => {
    const { rows: [a] } = await db.query(
      `INSERT INTO appointments (workspace_id, contact_id, opportunity_id, user_id, title, notes, start_at, end_at, timezone, google_event_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.ws, contact.id, b.opportunityId || null, emp.id, b.title, b.notes || null, start, end, b.timezone, ev.id, req.user.id]);
    await addActivity(db, { workspaceId: req.ws, contactId: contact.id, opportunityId: b.opportunityId, type: 'appointment', actorId: req.user.id, body: `Appointment booked with ${emp.name}: ${b.title} on ${b.start.replace('T', ' ')} (${b.timezone})${conflicts.length ? ' — double-booked after warning' : ''}`, data: { appointment_id: a.id } });
    await recordLeadAction(db, { workspaceId: req.ws, user: req.user, contactId: contact.id, opportunityId: b.opportunityId, via: 'booked an appointment' });
    emit(db, req.ws, 'appointments', {}); emit(db, req.ws, 'dashboard', {});
    return a;
  });
  res.status(201).json(appt);
});

async function visibleAppt(req, id) {
  const a = await one(`SELECT a.*, c.owner_id AS contact_owner FROM appointments a JOIN contacts c ON c.id = a.contact_id WHERE a.id = $1 AND a.workspace_id = $2`, [id, req.ws]);
  if (!a) throw notFound('Appointment');
  if (!can(req.user, 'crm.view_all') && a.user_id !== req.user.id && a.contact_owner !== req.user.id) throw notFound('Appointment');
  return a;
}

r.patch('/appointments/:id', requirePerm('crm.edit'), async (req, res) => {
  const b = parse(apptBody.pick({ title: true, notes: true, start: true, durationMinutes: true, timezone: true, force: true }).extend({ version: z.number().int() }), req.body);
  const a = await visibleAppt(req, req.params.id);
  if (a.status !== 'scheduled') throw new HttpError(409, 'Cancelled appointments cannot be changed.');
  if (a.version !== b.version) throw new HttpError(409, 'This appointment was changed by someone else. Reload and try again.');
  const start = zonedToUtc(b.start, b.timezone);
  const end = new Date(start.getTime() + b.durationMinutes * 60_000);
  const busy = await busyIntervals(req.ws, a.user_id, start, end, { excludeAppointmentId: a.id });
  const conflicts = overlaps(busy, start, end);
  if (conflicts.length && !b.force) throw new HttpError(409, `The employee is busy at the new time (${conflicts.length} overlapping event${conflicts.length > 1 ? 's' : ''}). Pick another time or confirm to double-book.`, { conflicts, code: 'conflict' });
  const contact = await one('SELECT * FROM contacts WHERE id = $1', [a.contact_id]);
  if (a.google_event_id) await googleCall(req.ws, a.user_id, 'calendar.event.update', (t) => google.patchEvent(t, a.google_event_id, eventBody({ title: b.title, notes: b.notes, start, end }, contact, b.timezone)));
  const out = await tx(async (db) => {
    const { rows: [x] } = await db.query(
      `UPDATE appointments SET title=$3, notes=$4, start_at=$5, end_at=$6, timezone=$7, version = version + 1, updated_at = now()
        WHERE id = $1 AND workspace_id = $2 AND version = $8 RETURNING *`, [a.id, req.ws, b.title, b.notes || null, start, end, b.timezone, b.version]);
    if (!x) throw new HttpError(409, 'This appointment was changed by someone else. Reload and try again.');
    await addActivity(db, { workspaceId: req.ws, contactId: a.contact_id, opportunityId: a.opportunity_id, type: 'appointment', actorId: req.user.id, body: `Appointment rescheduled: ${a.start_at.toISOString()} → ${start.toISOString()} (UTC)`, data: { appointment_id: a.id, from: a.start_at, to: start } });
    emit(db, req.ws, 'appointments', {});
    return x;
  });
  res.json(out);
});

r.post('/appointments/:id/cancel', requirePerm('crm.edit'), async (req, res) => {
  const a = await visibleAppt(req, req.params.id);
  if (a.status === 'cancelled') throw new HttpError(409, 'Already cancelled.');
  if (a.google_event_id) await googleCall(req.ws, a.user_id, 'calendar.event.delete', (t) => google.deleteEvent(t, a.google_event_id));
  await tx(async (db) => {
    await db.query("UPDATE appointments SET status = 'cancelled', version = version + 1, updated_at = now() WHERE id = $1", [a.id]);
    await addActivity(db, { workspaceId: req.ws, contactId: a.contact_id, opportunityId: a.opportunity_id, type: 'appointment', actorId: req.user.id, body: `Appointment cancelled: ${a.title}`, data: { appointment_id: a.id } });
    await audit(db, { workspaceId: req.ws, actor: req.user, action: 'appointment.cancelled', targetType: 'appointment', targetId: a.id, targetLabel: a.title, before: { status: a.status, start_at: a.start_at } , after: { status: 'cancelled' } });
    emit(db, req.ws, 'appointments', {}); emit(db, req.ws, 'dashboard', {});
  });
  res.json({ ok: true });
});

export default r;
