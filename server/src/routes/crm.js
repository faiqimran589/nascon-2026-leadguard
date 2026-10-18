// Contacts, companies, notes, saved lists and CSV export (F2.1, F2.6, F2.7, F2.8, F1.4).
import { z } from 'zod';
import { one, query, tx } from '../db/pool.js';
import { Router, parse, HttpError, notFound, paging } from '../lib/http.js';
import { normalizePhone } from '../lib/phone.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { can } from '../services/permissions.js';
import { audit, diff } from '../services/audit.js';
import { addActivity } from '../services/activity.js';
import { emit } from '../services/events.js';
import { recordLeadAction } from '../services/leads.js';
import {
  loadFields, validateCustom, contactScope, oppScope, maskOpp, maskActivity, buildFilters, filterFieldCatalog, normTags, csvCell,
} from '../services/crm.js';

const r = Router();
r.use(requireAuth);

const phone = z.string().trim().max(30).optional().nullable().transform((v, ctx) => {
  if (!v) return null;
  const n = normalizePhone(v);
  if (!n) { ctx.addIssue({ code: 'custom', message: 'Enter the phone in international format, e.g. +923001234567' }); return z.NEVER; }
  return n;
});
const email = z.string().trim().max(200).email().optional().nullable().or(z.literal('').transform(() => null));

function parseFilters(q) {
  if (!q.filters) return [];
  try { return JSON.parse(q.filters); } catch { throw new HttpError(400, 'filters must be JSON'); }
}

// ---------- Contacts ----------
async function contactList(req, { forExport = false } = {}) {
  const params = [req.ws];
  const where = ['c.workspace_id = $1', 'c.deleted_at IS NULL', contactScope(req.user, params)];
  const fields = await loadFields({ query }, req.ws, 'contact');
  where.push(...buildFilters('contacts', parseFilters(req.query), params, { user: req.user, customFields: fields, alias: 'c' }));
  if (req.query.q) {
    params.push(`%${String(req.query.q).slice(0, 100).replace(/[%_\\]/g, '\\$&')}%`);
    where.push(`(c.first_name || ' ' || c.last_name ILIKE $${params.length} OR c.email ILIKE $${params.length} OR c.phone ILIKE $${params.length})`);
  }
  const { limit, offset, page, pageSize } = forExport ? { limit: 5000, offset: 0 } : paging(req.query);
  const sql = `FROM contacts c LEFT JOIN companies co ON co.id = c.company_id LEFT JOIN users u ON u.id = c.owner_id WHERE ${where.join(' AND ')}`;
  const [{ rows }, count] = await Promise.all([
    query(`SELECT c.*, co.name AS company_name, u.name AS owner_name ${sql} ORDER BY c.created_at DESC LIMIT ${limit} OFFSET ${offset}`, params),
    forExport ? null : one(`SELECT count(*) AS n ${sql}`, params),
  ]);
  return { rows, total: count?.n, page, pageSize, fields };
}

r.get('/contacts', async (req, res) => {
  const { rows, total, page, pageSize } = await contactList(req);
  res.json({ items: rows, total, page, pageSize });
});

r.get('/contacts/filter-fields', async (req, res) => {
  res.json(filterFieldCatalog('contacts', await loadFields({ query }, req.ws, 'contact')));
});

const contactBody = z.object({
  firstName: z.string().trim().min(1).max(80), lastName: z.string().trim().max(80).optional().default(''),
  email, phone, companyId: z.string().uuid().nullable().optional(), ownerId: z.string().uuid().nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).optional(), custom: z.record(z.any()).optional(),
});

async function checkRefs(db, ws, { companyId, ownerId }) {
  if (companyId && !(await db.query('SELECT 1 FROM companies WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL', [companyId, ws])).rows.length) throw notFound('Company');
  if (ownerId && !(await db.query('SELECT 1 FROM users WHERE id = $1 AND workspace_id = $2 AND active', [ownerId, ws])).rows.length) throw notFound('Owner');
}

r.post('/contacts', requirePerm('crm.create'), async (req, res) => {
  const b = parse(contactBody, req.body);
  const c = await tx(async (db) => {
    await checkRefs(db, req.ws, b);
    const custom = validateCustom(b.custom, await loadFields(db, req.ws, 'contact'));
    const { rows: [x] } = await db.query(
      `INSERT INTO contacts (workspace_id, first_name, last_name, email, phone, company_id, owner_id, tags, custom, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual') RETURNING *`,
      [req.ws, b.firstName, b.lastName, b.email, b.phone, b.companyId || null, b.ownerId || req.user.id, normTags(b.tags), custom]);
    await addActivity(db, { workspaceId: req.ws, contactId: x.id, type: 'contact_created', actorId: req.user.id, body: `Contact created by ${req.user.name}` });
    emit(db, req.ws, 'crm', {});
    return x;
  });
  res.status(201).json(c);
});

async function visibleContact(req, id, db = { query }) {
  const params = [id, req.ws];
  const scope = contactScope(req.user, params);
  const { rows: [c] } = await db.query(
    `SELECT c.*, co.name AS company_name, u.name AS owner_name, u.availability AS owner_availability
       FROM contacts c LEFT JOIN companies co ON co.id = c.company_id LEFT JOIN users u ON u.id = c.owner_id
      WHERE c.id = $1 AND c.workspace_id = $2 AND c.deleted_at IS NULL AND ${scope}`, params);
  if (!c) throw notFound('Contact');
  return c;
}

// Complete customer view (F2.8)
r.get('/contacts/:id', async (req, res) => {
  const c = await visibleContact(req, req.params.id);
  const ws = req.ws;
  const [fields, opps, convs, payments, appts, leads, acts] = await Promise.all([
    loadFields({ query }, ws, 'contact'),
    query(`SELECT o.*, s.name AS stage_name, s.kind AS stage_kind, p.name AS pipeline_name, u.name AS owner_name
             FROM opportunities o JOIN stages s ON s.id = o.stage_id JOIN pipelines p ON p.id = o.pipeline_id LEFT JOIN users u ON u.id = o.owner_id
            WHERE o.contact_id = $1 AND o.workspace_id = $2 AND o.deleted_at IS NULL ORDER BY o.created_at DESC`, [c.id, ws]),
    query(`SELECT cv.*, (SELECT json_agg(m ORDER BY m.created_at) FROM (SELECT * FROM messages WHERE conversation_id = cv.id ORDER BY created_at DESC LIMIT 50) m) AS messages
             FROM conversations cv WHERE cv.contact_id = $1 AND cv.workspace_id = $2`, [c.id, ws]),
    query(`SELECT p.*, u.name AS requested_by_name, o.title AS opportunity_title FROM payments p LEFT JOIN users u ON u.id = p.requested_by
             JOIN opportunities o ON o.id = p.opportunity_id WHERE p.contact_id = $1 AND p.workspace_id = $2 ORDER BY p.created_at DESC`, [c.id, ws]),
    query(`SELECT a.*, u.name AS employee FROM appointments a JOIN users u ON u.id = a.user_id
            WHERE a.contact_id = $1 AND a.workspace_id = $2 ORDER BY a.start_at DESC`, [c.id, ws]),
    query(`SELECT l.*, u.name AS owner_name FROM leads l LEFT JOIN users u ON u.id = l.owner_id
            WHERE l.contact_id = $1 AND l.workspace_id = $2 ORDER BY l.created_at DESC`, [c.id, ws]),
    query(`SELECT a.*, u.name AS actor_name FROM activities a LEFT JOIN users u ON u.id = a.actor_user_id
            WHERE a.contact_id = $1 AND a.workspace_id = $2 ORDER BY a.created_at DESC, a.id DESC LIMIT 200`, [c.id, ws]),
  ]);
  res.json({
    contact: c, fields,
    opportunities: opps.rows.map((o) => maskOpp(req.user, o)),
    conversations: convs.rows.map((cv) => ({ ...cv, messages: cv.messages || [] })),
    payments: payments.rows, appointments: appts.rows, leads: leads.rows,
    activities: acts.rows.map((a) => maskActivity(req.user, a)),
    canMessage: !c.opted_out && !!c.phone,
  });
});

r.patch('/contacts/:id', requirePerm('crm.edit'), async (req, res) => {
  const b = parse(contactBody.partial().extend({ version: z.number().int(), optedOut: z.boolean().optional() }), req.body);
  const out = await tx(async (db) => {
    const old = await visibleContact(req, req.params.id, db);
    await checkRefs(db, req.ws, b);
    const fields = await loadFields(db, req.ws, 'contact');
    const custom = b.custom ? validateCustom(b.custom, fields, { partialBase: old.custom }) : old.custom;
    if (b.ownerId !== undefined && b.ownerId !== old.owner_id && !can(req.user, 'leads.reassign')) throw new HttpError(403, 'Only users who can reassign leads may change the owner.');
    const next = {
      first_name: b.firstName ?? old.first_name, last_name: b.lastName ?? old.last_name,
      email: b.email !== undefined ? b.email : old.email, phone: b.phone !== undefined ? b.phone : old.phone,
      company_id: b.companyId !== undefined ? b.companyId : old.company_id, owner_id: b.ownerId !== undefined ? b.ownerId : old.owner_id,
      tags: b.tags ? normTags(b.tags) : old.tags, custom, opted_out: b.optedOut ?? old.opted_out,
    };
    const { rows: [x] } = await db.query(
      `UPDATE contacts SET first_name=$3, last_name=$4, email=$5, phone=$6, company_id=$7, owner_id=$8, tags=$9, custom=$10,
              opted_out=$11, opted_out_at = CASE WHEN $11 AND NOT opted_out THEN now() WHEN NOT $11 THEN NULL ELSE opted_out_at END,
              version = version + 1, updated_at = now()
        WHERE id = $1 AND workspace_id = $2 AND version = $12 RETURNING *`,
      [old.id, req.ws, next.first_name, next.last_name, next.email, next.phone, next.company_id, next.owner_id, next.tags, next.custom, next.opted_out, b.version]);
    if (!x) throw new HttpError(409, 'Someone else changed this contact while you were editing. Reload to see the latest version, then re-apply your change.');
    const d = diff(old, x, ['first_name', 'last_name', 'email', 'phone', 'company_id', 'owner_id', 'tags', 'custom', 'opted_out']);
    if (d) {
      await addActivity(db, { workspaceId: req.ws, contactId: x.id, type: 'field_edit', actorId: req.user.id, body: `Edited ${Object.keys(d.after).join(', ').replace(/_/g, ' ')}`, data: d });
      if (d.after.opted_out !== undefined) await audit(db, { workspaceId: req.ws, actor: req.user, action: x.opted_out ? 'contact.opted_out' : 'contact.opted_in', targetType: 'contact', targetId: x.id, targetLabel: `${x.first_name} ${x.last_name}` });
      await recordLeadAction(db, { workspaceId: req.ws, user: req.user, contactId: x.id, via: 'edited the contact' });
    }
    emit(db, req.ws, 'crm', { contactId: x.id });
    return x;
  });
  res.json(out);
});

r.delete('/contacts/:id', requirePerm('crm.delete'), async (req, res) => {
  await tx(async (db) => {
    const c = await visibleContact(req, req.params.id, db);
    const { rows: opps } = await db.query("UPDATE opportunities SET deleted_at = now() WHERE contact_id = $1 AND deleted_at IS NULL RETURNING id", [c.id]);
    const { rows: leads } = await db.query("UPDATE leads SET status = 'closed', ack_deadline = NULL, version = version + 1 WHERE contact_id = $1 AND status IN ('assigned','acknowledged') RETURNING id", [c.id]);
    await db.query('UPDATE contacts SET deleted_at = now(), version = version + 1 WHERE id = $1', [c.id]);
    await audit(db, {
      workspaceId: req.ws, actor: req.user, action: 'contact.deleted', targetType: 'contact', targetId: c.id, targetLabel: `${c.first_name} ${c.last_name}`,
      before: { email: c.email, phone: c.phone, owner_id: c.owner_id }, after: { opportunities_deleted: opps.length, leads_closed: leads.length },
    });
    emit(db, req.ws, 'crm', {}); emit(db, req.ws, 'leads', {});
  });
  res.json({ ok: true });
});

// Notes & call logs on a contact (count as lead acknowledgement)
r.post('/contacts/:id/notes', requirePerm('crm.edit'), async (req, res) => {
  const b = parse(z.object({ body: z.string().trim().min(1).max(5000), type: z.enum(['note', 'call']).default('note'), opportunityId: z.string().uuid().optional() }), req.body);
  await tx(async (db) => {
    const c = await visibleContact(req, req.params.id, db);
    if (b.opportunityId && !(await db.query('SELECT 1 FROM opportunities WHERE id = $1 AND contact_id = $2 AND deleted_at IS NULL', [b.opportunityId, c.id])).rows.length) throw notFound('Opportunity');
    await addActivity(db, { workspaceId: req.ws, contactId: c.id, opportunityId: b.opportunityId, type: b.type, actorId: req.user.id, body: b.body });
    await recordLeadAction(db, { workspaceId: req.ws, user: req.user, contactId: c.id, opportunityId: b.opportunityId, via: b.type === 'call' ? 'logged a call' : 'added a note' });
    emit(db, req.ws, 'crm', { contactId: c.id });
  });
  res.status(201).json({ ok: true });
});

// ---------- Companies ----------
r.get('/companies', async (req, res) => {
  if (!can(req.user, 'crm.view')) throw new HttpError(403, 'You do not have permission to view CRM records.');
  const params = [req.ws];
  let where = 'co.workspace_id = $1 AND co.deleted_at IS NULL';
  if (req.query.q) { params.push(`%${String(req.query.q).slice(0, 100)}%`); where += ` AND co.name ILIKE $${params.length}`; }
  const { limit, offset, page, pageSize } = paging(req.query);
  const [{ rows }, count] = await Promise.all([
    query(`SELECT co.*, (SELECT count(*) FROM contacts c WHERE c.company_id = co.id AND c.deleted_at IS NULL) AS contact_count
             FROM companies co WHERE ${where} ORDER BY co.name LIMIT ${limit} OFFSET ${offset}`, params),
    one(`SELECT count(*) AS n FROM companies co WHERE ${where}`, params),
  ]);
  res.json({ items: rows, total: count.n, page, pageSize });
});

const companyBody = z.object({ name: z.string().trim().min(1).max(120), domain: z.string().trim().max(120).optional().nullable(), phone: z.string().trim().max(30).optional().nullable(), custom: z.record(z.any()).optional() });

r.post('/companies', requirePerm('crm.create'), async (req, res) => {
  const b = parse(companyBody, req.body);
  const custom = validateCustom(b.custom, await loadFields({ query }, req.ws, 'company'));
  const co = await one('INSERT INTO companies (workspace_id, name, domain, phone, custom) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [req.ws, b.name, b.domain || null, b.phone || null, custom]);
  res.status(201).json(co);
});

r.get('/companies/:id', async (req, res) => {
  if (!can(req.user, 'crm.view')) throw new HttpError(403, 'You do not have permission to view CRM records.');
  const co = await one('SELECT * FROM companies WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL', [req.params.id, req.ws]);
  if (!co) throw notFound('Company');
  const params = [co.id, req.ws];
  const scope = contactScope(req.user, params);
  const { rows: contacts } = await query(`SELECT c.*, u.name AS owner_name FROM contacts c LEFT JOIN users u ON u.id = c.owner_id WHERE c.company_id = $1 AND c.workspace_id = $2 AND c.deleted_at IS NULL AND ${scope} ORDER BY c.first_name`, params);
  const p2 = [co.id, req.ws];
  const oscope = oppScope(req.user, p2);
  const { rows: opps } = await query(`SELECT o.*, s.name AS stage_name, c.first_name || ' ' || c.last_name AS contact_name FROM opportunities o JOIN contacts c ON c.id = o.contact_id JOIN stages s ON s.id = o.stage_id WHERE c.company_id = $1 AND o.workspace_id = $2 AND o.deleted_at IS NULL AND ${oscope}`, p2);
  res.json({ company: co, fields: await loadFields({ query }, req.ws, 'company'), contacts, opportunities: opps.map((o) => maskOpp(req.user, o)) });
});

r.patch('/companies/:id', requirePerm('crm.edit'), async (req, res) => {
  const b = parse(companyBody.partial().extend({ version: z.number().int() }), req.body);
  const out = await tx(async (db) => {
    const { rows: [old] } = await db.query('SELECT * FROM companies WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL FOR UPDATE', [req.params.id, req.ws]);
    if (!old) throw notFound('Company');
    if (old.version !== b.version) throw new HttpError(409, 'Someone else changed this company. Reload and try again.');
    const custom = b.custom ? validateCustom(b.custom, await loadFields(db, req.ws, 'company'), { partialBase: old.custom }) : old.custom;
    const { rows: [x] } = await db.query('UPDATE companies SET name=$2, domain=$3, phone=$4, custom=$5, version=version+1, updated_at=now() WHERE id=$1 RETURNING *',
      [old.id, b.name ?? old.name, b.domain !== undefined ? b.domain : old.domain, b.phone !== undefined ? b.phone : old.phone, custom]);
    return x;
  });
  res.json(out);
});

r.delete('/companies/:id', requirePerm('crm.delete'), async (req, res) => {
  await tx(async (db) => {
    const { rows: [co] } = await db.query('UPDATE companies SET deleted_at = now() WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL RETURNING *', [req.params.id, req.ws]);
    if (!co) throw notFound('Company');
    const { rowCount } = await db.query('UPDATE contacts SET company_id = NULL WHERE company_id = $1', [co.id]);
    await audit(db, { workspaceId: req.ws, actor: req.user, action: 'company.deleted', targetType: 'company', targetId: co.id, targetLabel: co.name, after: { contacts_unlinked: rowCount } });
  });
  res.json({ ok: true });
});

// ---------- Saved lists (F2.6): store criteria, re-evaluate on every open ----------
r.get('/lists', async (req, res) => {
  const { rows } = await query('SELECT * FROM saved_lists WHERE workspace_id = $1 AND user_id = $2 ORDER BY created_at', [req.ws, req.user.id]);
  res.json(rows);
});
r.post('/lists', async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(1).max(80), entity: z.enum(['contacts', 'opportunities']), filters: z.array(z.object({ field: z.string().max(80), op: z.string().max(20), value: z.any().optional() })).max(15) }), req.body);
  const fields = await loadFields({ query }, req.ws, b.entity === 'contacts' ? 'contact' : 'opportunity');
  buildFilters(b.entity, b.filters, [req.ws], { user: req.user, customFields: fields, alias: b.entity === 'contacts' ? 'c' : 'o' }); // validate
  const row = await one('INSERT INTO saved_lists (workspace_id, user_id, name, entity, filters) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [req.ws, req.user.id, b.name, b.entity, JSON.stringify(b.filters)]);
  res.status(201).json(row);
});
r.delete('/lists/:id', async (req, res) => {
  await query('DELETE FROM saved_lists WHERE id = $1 AND workspace_id = $2 AND user_id = $3', [req.params.id, req.ws, req.user.id]);
  res.json({ ok: true });
});

// ---------- CSV export (respects scope and value masking) ----------
r.get('/export/contacts.csv', requirePerm('crm.export'), async (req, res) => {
  const { rows, fields } = await contactList(req, { forExport: true });
  const head = ['id', 'first_name', 'last_name', 'email', 'phone', 'company', 'owner', 'tags', 'source', 'opted_out', 'created_at', ...fields.map((f) => f.label)];
  const lines = rows.map((c) => [c.id, c.first_name, c.last_name, c.email, c.phone, c.company_name, c.owner_name, c.tags, c.source, c.opted_out, c.created_at?.toISOString(), ...fields.map((f) => c.custom?.[f.key])].map(csvCell).join(','));
  await audit({ query }, { workspaceId: req.ws, actor: req.user, action: 'export.contacts', targetType: 'export', after: { rows: rows.length } });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="contacts.csv"' });
  res.send(`﻿${[head.map(csvCell).join(','), ...lines].join('\r\n')}`);
});

export default r;
