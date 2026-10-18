// Leads (F3): manual intake, lists/presets, detail with countdown, acknowledge, reassign,
// notes, convert, close, recovery queue, escalation history. Dashboard (F5) and audit log (F4).
import { z } from 'zod';
import { one, query, tx } from '../db/pool.js';
import { Router, parse, HttpError, notFound, paging } from '../lib/http.js';
import { normalizePhone } from '../lib/phone.js';
import { startOfDay, startOfMonth } from '../lib/time.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { can } from '../services/permissions.js';
import { audit } from '../services/audit.js';
import { addActivity } from '../services/activity.js';
import { emit } from '../services/events.js';
import { createLead, acknowledge, reassign, recordLeadAction, getRules, formatSecs } from '../services/leads.js';
import { dashboard, trends, dashboardScope, RECOVERY_REASONS_SQL, RECOVERY_WHERE, leadScope } from '../services/metrics.js';
import { loadFields, validateCustom, missingRequired, maskOpp } from '../services/crm.js';

const r = Router();
r.use(requireAuth);

function needView(req) { if (!can(req.user, 'crm.view')) throw new HttpError(403, 'You do not have permission to view leads.'); }

r.get('/leads', async (req, res) => {
  needView(req);
  const params = [req.ws];
  const where = ['l.workspace_id = $1', leadScope(req.user, params)];
  const add = (v, sql) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (req.query.status === 'open') where.push("l.status IN ('assigned','acknowledged')");
  else if (req.query.status) add(String(req.query.status), 'l.status = ?');
  if (req.query.source) add(String(req.query.source), 'l.source = ?');
  if (req.query.ownerId) add(req.query.ownerId === 'me' ? req.user.id : String(req.query.ownerId), 'l.owner_id = ?');
  if (req.query.preset === 'new_today') add(startOfDay(req.tz), 'l.created_at >= ?');
  if (req.query.q) add(`%${String(req.query.q).slice(0, 100)}%`, '(l.title ILIKE ? )');
  const { limit, offset, page, pageSize } = paging(req.query);
  const from = `FROM leads l JOIN contacts c ON c.id = l.contact_id LEFT JOIN users u ON u.id = l.owner_id WHERE ${where.join(' AND ')}`;
  const [{ rows }, count] = await Promise.all([
    query(`SELECT l.*, u.name AS owner_name, c.first_name || ' ' || c.last_name AS contact_name, c.phone, c.email, now() AS server_now
             ${from} ORDER BY l.created_at DESC LIMIT ${limit} OFFSET ${offset}`, params),
    one(`SELECT count(*) AS n ${from}`, params),
  ]);
  res.json({ items: rows, total: count.n, page, pageSize, serverNow: new Date().toISOString() });
});

// Recovery queue (F3.7) — same definition as the dashboard figure.
r.get('/leads/recovery', async (req, res) => {
  needView(req);
  const params = [req.ws];
  const scope = leadScope(req.user, params);
  const personal = req.query.scope === 'personal' ? (params.push(req.user.id), `AND l.owner_id = $${params.length}`) : '';
  const { rows } = await query(
    `SELECT l.*, ${RECOVERY_REASONS_SQL} AS reasons, u.name AS owner_name, u.availability AS owner_availability,
            c.first_name || ' ' || c.last_name AS contact_name, r.idle_seconds
       FROM leads l JOIN assignment_rules r ON r.workspace_id = l.workspace_id
       JOIN contacts c ON c.id = l.contact_id LEFT JOIN users u ON u.id = l.owner_id
      WHERE l.workspace_id = $1 AND ${RECOVERY_WHERE} AND ${scope} ${personal}
      ORDER BY l.created_at LIMIT 500`, params);
  res.json({ items: rows, serverNow: new Date().toISOString() });
});

// Escalation events (drill-down for "Escalations in the last 24 hours").
r.get('/leads/escalations', async (req, res) => {
  needView(req);
  const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 24 * 90);
  const params = [req.ws, hours];
  let extra = '';
  if (!can(req.user, 'crm.view_all') || req.query.scope === 'personal') { params.push(req.user.id); extra = `AND (a.from_user_id = $${params.length} OR a.to_user_id = $${params.length})`; }
  const { rows } = await query(
    `SELECT a.*, l.title, l.source, l.status AS lead_status, fu.name AS from_name, tu.name AS to_name
       FROM lead_assignments a JOIN leads l ON l.id = a.lead_id
       LEFT JOIN users fu ON fu.id = a.from_user_id LEFT JOIN users tu ON tu.id = a.to_user_id
      WHERE a.workspace_id = $1 AND a.kind = 'escalation' AND a.created_at >= now() - make_interval(hours => $2) ${extra}
      ORDER BY a.created_at DESC LIMIT 500`, params);
  res.json({ items: rows });
});

async function visibleLead(req, id, db = { query }) {
  needView(req);
  const params = [id, req.ws];
  const scope = leadScope(req.user, params);
  const { rows: [l] } = await db.query(
    `SELECT l.*, u.name AS owner_name, u.availability AS owner_availability, c.first_name, c.last_name, c.email, c.phone, c.opted_out
       FROM leads l JOIN contacts c ON c.id = l.contact_id LEFT JOIN users u ON u.id = l.owner_id
      WHERE l.id = $1 AND l.workspace_id = $2 AND ${scope}`, params);
  if (!l) throw notFound('Lead');
  return l;
}

r.get('/leads/:id', async (req, res) => {
  const l = await visibleLead(req, req.params.id);
  const [assignments, acts, rules] = await Promise.all([
    query(`SELECT a.*, fu.name AS from_name, tu.name AS to_name, au.name AS actor_name FROM lead_assignments a
             LEFT JOIN users fu ON fu.id = a.from_user_id LEFT JOIN users tu ON tu.id = a.to_user_id LEFT JOIN users au ON au.id = a.actor_user_id
            WHERE a.lead_id = $1 ORDER BY a.created_at`, [l.id]),
    query(`SELECT a.*, u.name AS actor_name FROM activities a LEFT JOIN users u ON u.id = a.actor_user_id
            WHERE a.workspace_id = $2 AND (a.lead_id = $1 OR (a.contact_id = $3 AND a.created_at >= $4)) ORDER BY a.created_at DESC, a.id DESC LIMIT 100`,
    [l.id, req.ws, l.contact_id, l.created_at]),
    getRules({ query }, req.ws),
  ]);
  res.json({
    lead: l, assignments: assignments.rows, activities: acts.rows, serverNow: new Date().toISOString(),
    rules: { acknowledgedOnAbsence: rules.acknowledged_on_absence, escalationLevels: rules.escalation_levels, ackWindowSeconds: rules.ack_window_seconds },
  });
});

r.post('/leads', requirePerm('crm.create'), async (req, res) => {
  const b = parse(z.object({
    contactId: z.string().uuid().optional(),
    firstName: z.string().trim().max(80).optional(), lastName: z.string().trim().max(80).optional(),
    email: z.string().trim().email().max(200).optional().or(z.literal('')), phone: z.string().trim().max(30).optional(),
    title: z.string().trim().max(160).optional(), message: z.string().trim().max(5000).optional(),
  }).refine((v) => v.contactId || v.firstName, 'Choose an existing contact or enter a name'), req.body);
  if (b.phone && !normalizePhone(b.phone)) throw new HttpError(400, 'Enter the phone in international format, e.g. +923001234567');
  const lead = await tx((db) => createLead(db, {
    workspaceId: req.ws, source: 'manual', contactId: b.contactId,
    contact: { firstName: b.firstName, lastName: b.lastName, email: b.email || null, phone: b.phone || null },
    title: b.title, message: b.message, actor: req.user,
  }));
  res.status(201).json(lead);
});

r.post('/leads/:id/ack', async (req, res) => {
  const l = await visibleLead(req, req.params.id);
  const out = await tx((db) => acknowledge(db, { workspaceId: req.ws, leadId: l.id, user: req.user }));
  if (!out) {
    const cur = await visibleLead(req, req.params.id).catch(() => null);
    if (cur?.status === 'acknowledged') throw new HttpError(409, 'This lead is already acknowledged.');
    if (cur && cur.owner_id !== req.user.id) throw new HttpError(409, `Too late — this lead now belongs to ${cur.owner_name}. Only the current owner can acknowledge it.`);
    throw new HttpError(409, 'This lead can no longer be acknowledged.');
  }
  res.json(out);
});

r.post('/leads/:id/reassign', requirePerm('leads.reassign'), async (req, res) => {
  const b = parse(z.object({ userId: z.string().uuid(), reason: z.string().trim().max(300).optional() }), req.body);
  await visibleLead(req, req.params.id);
  const out = await tx((db) => reassign(db, { workspaceId: req.ws, leadId: req.params.id, toUserId: b.userId, actor: req.user, reason: b.reason }));
  res.json(out);
});

r.post('/leads/:id/notes', requirePerm('crm.edit'), async (req, res) => {
  const b = parse(z.object({ body: z.string().trim().min(1).max(5000), type: z.enum(['note', 'call']).default('note') }), req.body);
  const l = await visibleLead(req, req.params.id);
  await tx(async (db) => {
    await addActivity(db, { workspaceId: req.ws, contactId: l.contact_id, opportunityId: l.opportunity_id, leadId: l.id, type: b.type, actorId: req.user.id, body: b.body });
    await recordLeadAction(db, { workspaceId: req.ws, user: req.user, leadId: l.id, via: b.type === 'call' ? 'logged a call' : 'added a note' });
  });
  res.status(201).json({ ok: true });
});

r.post('/leads/:id/convert', requirePerm('crm.create'), async (req, res) => {
  const b = parse(z.object({
    pipelineId: z.string().uuid(), title: z.string().trim().min(1).max(160), value: z.number().nonnegative().nullable().optional(),
    currency: z.string().length(3).toLowerCase().optional(), custom: z.record(z.any()).optional(),
  }), req.body);
  if (b.value != null && !can(req.user, 'values.view')) throw new HttpError(403, 'You do not have permission to set values.');
  const l = await visibleLead(req, req.params.id);
  if (!['assigned', 'acknowledged'].includes(l.status)) throw new HttpError(409, 'Only open leads can be converted.');
  const opp = await tx(async (db) => {
    const { rows: [pipe] } = await db.query('SELECT * FROM pipelines WHERE id = $1 AND workspace_id = $2', [b.pipelineId, req.ws]);
    if (!pipe) throw notFound('Pipeline');
    const { rows: [stage] } = await db.query("SELECT * FROM stages WHERE pipeline_id = $1 AND kind = 'open' ORDER BY position LIMIT 1", [pipe.id]);
    const fields = await loadFields(db, req.ws, 'opportunity', pipe.id);
    const custom = validateCustom(b.custom, fields);
    const missing = missingRequired(stage, { value: b.value ?? null, close_date: null, custom }, fields);
    if (missing.length) throw new HttpError(422, `The first stage requires: ${missing.map((m) => m.label).join(', ')}`, { missing });
    const ws = await db.query('SELECT default_currency FROM workspaces WHERE id = $1', [req.ws]);
    const { rows: [o] } = await db.query(
      `INSERT INTO opportunities (workspace_id, pipeline_id, stage_id, contact_id, title, value, currency, owner_id, custom)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.ws, pipe.id, stage.id, l.contact_id, b.title, b.value ?? null, ws.rows[0].default_currency, l.owner_id || req.user.id, custom]);
    await recordLeadAction(db, { workspaceId: req.ws, user: req.user, leadId: l.id, via: 'converted to opportunity' });
    await db.query("UPDATE leads SET status = 'converted', opportunity_id = $2, ack_deadline = NULL, version = version + 1 WHERE id = $1", [l.id, o.id]);
    await db.query('UPDATE conversations SET opportunity_id = COALESCE(opportunity_id, $2) WHERE contact_id = $1', [l.contact_id, o.id]);
    await addActivity(db, { workspaceId: req.ws, contactId: l.contact_id, opportunityId: o.id, leadId: l.id, type: 'opportunity_created', actorId: req.user.id, body: `Lead converted to opportunity "${o.title}" (${pipe.name})` });
    await audit(db, { workspaceId: req.ws, actor: req.user, action: 'lead.converted', targetType: 'lead', targetId: l.id, targetLabel: l.title, after: { opportunity_id: o.id } });
    emit(db, req.ws, 'leads', { id: l.id }); emit(db, req.ws, 'crm', {}); emit(db, req.ws, 'dashboard', {});
    return o;
  });
  res.status(201).json(maskOpp(req.user, opp));
});

r.post('/leads/:id/close', requirePerm('crm.edit'), async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(1).max(300) }), req.body);
  const l = await visibleLead(req, req.params.id);
  await tx(async (db) => {
    await recordLeadAction(db, { workspaceId: req.ws, user: req.user, leadId: l.id, via: 'closed the lead' });
    const { rowCount } = await db.query("UPDATE leads SET status = 'closed', ack_deadline = NULL, version = version + 1 WHERE id = $1 AND status IN ('assigned','acknowledged')", [l.id]);
    if (!rowCount) throw new HttpError(409, 'This lead is already closed or converted.');
    await addActivity(db, { workspaceId: req.ws, contactId: l.contact_id, leadId: l.id, type: 'lead_closed', actorId: req.user.id, body: `Lead closed: ${b.reason}` });
    await audit(db, { workspaceId: req.ws, actor: req.user, action: 'lead.closed', targetType: 'lead', targetId: l.id, targetLabel: l.title, before: { status: l.status }, after: { status: 'closed', reason: b.reason } });
    emit(db, req.ws, 'leads', { id: l.id });
  });
  res.json({ ok: true });
});

// ---------- Dashboard (F5) ----------
r.get('/dashboard/trends', async (req, res) => {
  const scope = dashboardScope(req.user, req.query.scope !== 'personal');
  res.json(await trends(req.user, { scope, tz: req.tz, days: parseInt(req.query.days, 10) || 14 }));
});

r.get('/dashboard', async (req, res) => {
  const scope = dashboardScope(req.user, req.query.scope !== 'personal');
  res.json({ ...(await dashboard(req.user, { scope, tz: req.tz })), canCompany: can(req.user, 'dashboard.company'), timezone: req.tz });
});

// ---------- Audit log (F4.2) — read-only; no update/delete endpoint exists ----------
r.get('/audit', requirePerm('audit.view'), async (req, res) => {
  const params = [req.ws];
  const where = ['a.workspace_id = $1'];
  const add = (v, sql) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (req.query.action) add(`${String(req.query.action)}%`, 'a.action LIKE ?');
  if (req.query.userId === 'system') where.push('a.actor_user_id IS NULL');
  else if (req.query.userId) add(String(req.query.userId), 'a.actor_user_id = ?');
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v)) && !Number.isNaN(Date.parse(String(v)));
  for (const k of ['from', 'to']) if (req.query[k] && !isDate(req.query[k])) throw new HttpError(400, `"${k}" must be a date (YYYY-MM-DD).`);
  if (req.query.userId && req.query.userId !== 'system' && !/^[0-9a-f-]{36}$/i.test(String(req.query.userId))) throw new HttpError(400, 'Unknown user filter.');
  if (req.query.from) add(String(req.query.from), 'a.created_at >= ?::date');
  if (req.query.to) add(String(req.query.to), "a.created_at < (?::date + interval '1 day')");
  if (req.query.targetId) add(String(req.query.targetId), 'a.target_id = ?');
  const { limit, offset, page, pageSize } = paging(req.query);
  const [{ rows }, count, actions] = await Promise.all([
    query(`SELECT a.* FROM audit_log a WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC, a.id DESC LIMIT ${limit} OFFSET ${offset}`, params),
    one(`SELECT count(*) AS n FROM audit_log a WHERE ${where.join(' AND ')}`, params),
    query('SELECT DISTINCT split_part(action, \'.\', 1) AS g FROM audit_log WHERE workspace_id = $1 ORDER BY 1', [req.ws]),
  ]);
  // F1.4: opportunity values stay hidden in the history for users who may not see values.
  const strip = (o) => (o && typeof o === 'object' && 'value' in o ? (({ value, ...rest }) => ({ ...rest, value: '•••' }))(o) : o);
  const items = can(req.user, 'values.view') ? rows : rows.map((a) => ({ ...a, before: strip(a.before), after: strip(a.after) }));
  res.json({ items, total: count.n, page, pageSize, groups: actions.rows.map((x) => x.g) });
});

// Payments list (drill-down for "payments received this month")
r.get('/payments', async (req, res) => {
  needView(req);
  const params = [req.ws];
  const where = ['p.workspace_id = $1'];
  if (!can(req.user, 'crm.view_all')) { params.push(req.user.id); where.push(`(p.requested_by = $${params.length} OR o.owner_id = $${params.length})`); }
  if (req.query.preset === 'collected_month') {
    params.push(startOfMonth(req.tz)); where.push(`p.paid_at >= $${params.length} AND p.status IN ('paid','refunded','partially_refunded')`);
    if (req.query.scope === 'personal') { params.push(req.user.id); where.push(`p.requested_by = $${params.length}`); }
  } else if (req.query.status) { params.push(String(req.query.status)); where.push(`p.status = $${params.length}`); }
  const { limit, offset, page, pageSize } = paging(req.query);
  const from = `FROM payments p JOIN opportunities o ON o.id = p.opportunity_id JOIN contacts c ON c.id = p.contact_id LEFT JOIN users u ON u.id = p.requested_by WHERE ${where.join(' AND ')}`;
  const [{ rows }, count] = await Promise.all([
    query(`SELECT p.*, o.title AS opportunity_title, c.first_name || ' ' || c.last_name AS contact_name, u.name AS requested_by_name ${from} ORDER BY p.created_at DESC LIMIT ${limit} OFFSET ${offset}`, params),
    one(`SELECT count(*) AS n ${from}`, params),
  ]);
  res.json({ items: rows, total: count.n, page, pageSize });
});

export default r;
export { formatSecs };
