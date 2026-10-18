// Opportunities: list/board, detail, create, edit, stage moves with required fields, export (F2.1, F2.4, F2.5, F1.4).
import { z } from 'zod';
import { one, query, tx } from '../db/pool.js';
import { Router, parse, HttpError, notFound, paging } from '../lib/http.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { can } from '../services/permissions.js';
import { audit, diff } from '../services/audit.js';
import { addActivity } from '../services/activity.js';
import { emit } from '../services/events.js';
import { recordLeadAction } from '../services/leads.js';
import {
  loadFields, validateCustom, oppScope, contactScope, maskOpp, maskActivity, missingRequired, buildFilters, filterFieldCatalog, normTags, csvCell,
} from '../services/crm.js';

const r = Router();
r.use(requireAuth);

const parseFilters = (q) => { if (!q.filters) return []; try { return JSON.parse(q.filters); } catch { throw new HttpError(400, 'filters must be JSON'); } };

async function oppList(req, { forExport = false, board = false } = {}) {
  const params = [req.ws];
  const where = ['o.workspace_id = $1', 'o.deleted_at IS NULL', oppScope(req.user, params)];
  if (req.query.pipelineId) { params.push(req.query.pipelineId); where.push(`o.pipeline_id = $${params.length}`); }
  if (req.query.stageId) { params.push(req.query.stageId); where.push(`o.stage_id = $${params.length}`); }
  const fields = await loadFields({ query }, req.ws, 'opportunity', req.query.pipelineId);
  where.push(...buildFilters('opportunities', parseFilters(req.query), params, { user: req.user, customFields: fields, alias: 'o' }));
  if (req.query.q) {
    params.push(`%${String(req.query.q).slice(0, 100).replace(/[%_\\]/g, '\\$&')}%`);
    where.push(`(o.title ILIKE $${params.length} OR c.first_name || ' ' || c.last_name ILIKE $${params.length})`);
  }
  const { limit, offset, page, pageSize } = forExport ? { limit: 5000, offset: 0 } : board ? { limit: 500, offset: 0, page: 1, pageSize: 500 } : paging(req.query);
  const from = `FROM opportunities o JOIN contacts c ON c.id = o.contact_id JOIN stages s ON s.id = o.stage_id
                JOIN pipelines p ON p.id = o.pipeline_id LEFT JOIN users u ON u.id = o.owner_id WHERE ${where.join(' AND ')}`;
  const [{ rows }, count] = await Promise.all([
    query(`SELECT o.*, s.name AS stage_name, s.kind AS stage_kind, p.name AS pipeline_name, u.name AS owner_name,
                  c.first_name || ' ' || c.last_name AS contact_name,
                  (SELECT status FROM payments pm WHERE pm.opportunity_id = o.id ORDER BY pm.created_at DESC LIMIT 1) AS payment_status
             ${from} ORDER BY o.updated_at DESC LIMIT ${limit} OFFSET ${offset}`, params),
    forExport ? null : one(`SELECT count(*) AS n ${from}`, params),
  ]);
  return { rows: rows.map((o) => maskOpp(req.user, o)), total: count?.n, page, pageSize, fields };
}

r.get('/opportunities', async (req, res) => {
  const { rows, total, page, pageSize } = await oppList(req, { board: req.query.view === 'board' });
  res.json({ items: rows, total, page, pageSize, valuesMasked: !can(req.user, 'values.view') });
});

r.get('/opportunities/filter-fields', async (req, res) => {
  const cat = filterFieldCatalog('opportunities', await loadFields({ query }, req.ws, 'opportunity', req.query.pipelineId));
  res.json(can(req.user, 'values.view') ? cat : cat.filter((f) => f.key !== 'value'));
});

const oppBody = z.object({
  title: z.string().trim().min(1).max(160), contactId: z.string().uuid(), pipelineId: z.string().uuid(),
  stageId: z.string().uuid().optional(), value: z.number().nonnegative().max(1e12).nullable().optional(),
  currency: z.string().length(3).toLowerCase().optional(), ownerId: z.string().uuid().nullable().optional(),
  closeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), tags: z.array(z.string().max(40)).max(20).optional(),
  custom: z.record(z.any()).optional(),
});

r.post('/opportunities', requirePerm('crm.create'), async (req, res) => {
  const b = parse(oppBody, req.body);
  if (b.value != null && !can(req.user, 'values.view')) throw new HttpError(403, 'You do not have permission to set opportunity values.');
  const opp = await tx(async (db) => {
    const p = [b.contactId, req.ws];
    const { rows: [c] } = await db.query(`SELECT c.* FROM contacts c WHERE c.id = $1 AND c.workspace_id = $2 AND c.deleted_at IS NULL AND ${contactScope(req.user, p)}`, p);
    if (!c) throw notFound('Contact');
    const { rows: [pipe] } = await db.query('SELECT * FROM pipelines WHERE id = $1 AND workspace_id = $2', [b.pipelineId, req.ws]);
    if (!pipe) throw notFound('Pipeline');
    const { rows: [stage] } = b.stageId
      ? await db.query('SELECT * FROM stages WHERE id = $1 AND pipeline_id = $2', [b.stageId, pipe.id])
      : await db.query("SELECT * FROM stages WHERE pipeline_id = $1 AND kind = 'open' ORDER BY position LIMIT 1", [pipe.id]);
    if (!stage) throw notFound('Stage');
    const fields = await loadFields(db, req.ws, 'opportunity', pipe.id);
    const custom = validateCustom(b.custom, fields);
    const draft = { value: b.value ?? null, close_date: b.closeDate ?? null, custom };
    const missing = missingRequired(stage, draft, fields);
    if (missing.length) throw new HttpError(422, `The stage "${stage.name}" requires: ${missing.map((m) => m.label).join(', ')}.`, { missing });
    const ownerId = b.ownerId || c.owner_id || req.user.id;
    if (!(await db.query('SELECT 1 FROM users WHERE id = $1 AND workspace_id = $2', [ownerId, req.ws])).rows.length) throw notFound('Owner');
    const ws = await db.query('SELECT default_currency FROM workspaces WHERE id = $1', [req.ws]);
    const { rows: [o] } = await db.query(
      `INSERT INTO opportunities (workspace_id, pipeline_id, stage_id, contact_id, title, value, currency, owner_id, close_date, tags, custom)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.ws, pipe.id, stage.id, c.id, b.title, b.value ?? null, ws.rows[0].default_currency, ownerId, b.closeDate || null, normTags(b.tags), custom]);
    await addActivity(db, { workspaceId: req.ws, contactId: c.id, opportunityId: o.id, type: 'opportunity_created', actorId: req.user.id, body: `Opportunity "${o.title}" created in ${pipe.name} → ${stage.name}` });
    await recordLeadAction(db, { workspaceId: req.ws, user: req.user, contactId: c.id, via: 'created an opportunity' });
    emit(db, req.ws, 'crm', {}); emit(db, req.ws, 'dashboard', {});
    return o;
  });
  res.status(201).json(maskOpp(req.user, opp));
});

async function visibleOpp(req, id, db = { query }) {
  const params = [id, req.ws];
  const scope = oppScope(req.user, params);
  const { rows: [o] } = await db.query(
    `SELECT o.*, s.name AS stage_name, s.kind AS stage_kind, p.name AS pipeline_name, u.name AS owner_name,
            c.first_name, c.last_name, c.email AS contact_email, c.phone AS contact_phone, c.owner_id AS contact_owner_id
       FROM opportunities o JOIN contacts c ON c.id = o.contact_id JOIN stages s ON s.id = o.stage_id
       JOIN pipelines p ON p.id = o.pipeline_id LEFT JOIN users u ON u.id = o.owner_id
      WHERE o.id = $1 AND o.workspace_id = $2 AND o.deleted_at IS NULL AND ${scope}`, params);
  if (!o) throw notFound('Opportunity');
  return o;
}

r.get('/opportunities/:id', async (req, res) => {
  const o = await visibleOpp(req, req.params.id);
  const [fields, stages, payments, appts, acts] = await Promise.all([
    loadFields({ query }, req.ws, 'opportunity', o.pipeline_id),
    query('SELECT * FROM stages WHERE pipeline_id = $1 ORDER BY position', [o.pipeline_id]),
    query(`SELECT p.*, u.name AS requested_by_name FROM payments p LEFT JOIN users u ON u.id = p.requested_by WHERE p.opportunity_id = $1 ORDER BY p.created_at DESC`, [o.id]),
    query(`SELECT a.*, u.name AS employee FROM appointments a JOIN users u ON u.id = a.user_id WHERE a.opportunity_id = $1 ORDER BY a.start_at DESC`, [o.id]),
    query(`SELECT a.*, u.name AS actor_name FROM activities a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.opportunity_id = $1 ORDER BY a.created_at DESC, a.id DESC LIMIT 200`, [o.id]),
  ]);
  res.json({
    opportunity: maskOpp(req.user, o), fields, stages: stages.rows, payments: payments.rows, appointments: appts.rows,
    activities: acts.rows.map((a) => maskActivity(req.user, a)),
  });
});

r.patch('/opportunities/:id', requirePerm('crm.edit'), async (req, res) => {
  const b = parse(oppBody.omit({ contactId: true, pipelineId: true }).partial().extend({ version: z.number().int() }), req.body);
  const out = await tx(async (db) => {
    const old = await visibleOpp(req, req.params.id, db);
    if (b.value !== undefined && !can(req.user, 'values.view')) throw new HttpError(403, 'You do not have permission to change opportunity values.');
    if (b.ownerId !== undefined && b.ownerId !== old.owner_id && !can(req.user, 'leads.reassign')) throw new HttpError(403, 'Only users who can reassign may change the owner.');
    if (b.ownerId && !(await db.query('SELECT 1 FROM users WHERE id = $1 AND workspace_id = $2 AND active', [b.ownerId, req.ws])).rows.length) throw notFound('Owner');
    const fields = await loadFields(db, req.ws, 'opportunity', old.pipeline_id);
    const custom = b.custom ? validateCustom(b.custom, fields, { partialBase: old.custom }) : old.custom;
    let stage = { id: old.stage_id, name: old.stage_name };
    if (b.stageId && b.stageId !== old.stage_id) {
      const { rows: [s] } = await db.query('SELECT * FROM stages WHERE id = $1 AND pipeline_id = $2', [b.stageId, old.pipeline_id]);
      if (!s) throw notFound('Stage');
      stage = s;
    } else {
      stage = (await db.query('SELECT * FROM stages WHERE id = $1', [old.stage_id])).rows[0];
    }
    const next = {
      title: b.title ?? old.title, value: b.value !== undefined ? b.value : old.value, currency: old.currency, // values stay in the workspace currency
      owner_id: b.ownerId !== undefined ? b.ownerId : old.owner_id, close_date: b.closeDate !== undefined ? b.closeDate : old.close_date,
      tags: b.tags ? normTags(b.tags) : old.tags, custom, stage_id: stage.id,
    };
    // The record must still satisfy its (possibly new) stage's required fields.
    const missing = missingRequired(stage, next, fields);
    if (missing.length) throw new HttpError(422, `The stage "${stage.name}" requires: ${missing.map((m) => m.label).join(', ')}.`, { missing });
    const { rows: [x] } = await db.query(
      `UPDATE opportunities SET title=$3, value=$4, currency=$5, owner_id=$6, close_date=$7, tags=$8, custom=$9, stage_id=$10,
              stage_changed_at = CASE WHEN stage_id <> $10 THEN now() ELSE stage_changed_at END, version = version + 1, updated_at = now()
        WHERE id = $1 AND workspace_id = $2 AND version = $11 RETURNING *`,
      [old.id, req.ws, next.title, next.value, next.currency, next.owner_id, next.close_date, next.tags, next.custom, next.stage_id, b.version]);
    if (!x) throw new HttpError(409, 'Someone else changed this opportunity while you were editing. Reload to see the latest version, then re-apply your change.');
    const d = diff(old, x, ['title', 'currency', 'owner_id', 'close_date', 'tags', 'custom']);
    if (d) await addActivity(db, { workspaceId: req.ws, contactId: x.contact_id, opportunityId: x.id, type: 'field_edit', actorId: req.user.id, body: `Edited ${Object.keys(d.after).join(', ').replace(/_/g, ' ')}`, data: d });
    if (Number(old.value ?? -1) !== Number(x.value ?? -1)) {
      await addActivity(db, { workspaceId: req.ws, contactId: x.contact_id, opportunityId: x.id, type: 'field_edit', actorId: req.user.id, body: `Value changed from ${old.value ?? '—'} to ${x.value ?? '—'} ${x.currency.toUpperCase()}`, data: { sensitive: 'value' } });
    }
    if (old.stage_id !== x.stage_id) {
      await addActivity(db, { workspaceId: req.ws, contactId: x.contact_id, opportunityId: x.id, type: 'stage_change', actorId: req.user.id, body: `Stage changed: ${old.stage_name} → ${stage.name}`, data: { from: old.stage_id, to: x.stage_id } });
    }
    await recordLeadAction(db, { workspaceId: req.ws, user: req.user, contactId: x.contact_id, opportunityId: x.id, via: old.stage_id !== x.stage_id ? 'changed the stage' : 'edited the opportunity' });
    emit(db, req.ws, 'crm', { opportunityId: x.id }); emit(db, req.ws, 'dashboard', {});
    return x;
  });
  res.json(maskOpp(req.user, out));
});

// Board move (F2.5) — same rules as PATCH, optimised for drag-and-drop.
r.post('/opportunities/:id/move', requirePerm('crm.edit'), async (req, res) => {
  const b = parse(z.object({ stageId: z.string().uuid(), version: z.number().int() }), req.body);
  const out = await tx(async (db) => {
    const old = await visibleOpp(req, req.params.id, db);
    const { rows: [s] } = await db.query('SELECT * FROM stages WHERE id = $1 AND pipeline_id = $2', [b.stageId, old.pipeline_id]);
    if (!s) throw notFound('Stage');
    if (s.id === old.stage_id) return old;
    const fields = await loadFields(db, req.ws, 'opportunity', old.pipeline_id);
    const missing = missingRequired(s, old, fields);
    if (missing.length) throw new HttpError(422, `Cannot move to "${s.name}" yet. Fill in: ${missing.map((m) => m.label).join(', ')}.`, { missing, stage: s.name });
    const { rows: [x] } = await db.query(
      'UPDATE opportunities SET stage_id = $3, stage_changed_at = now(), version = version + 1, updated_at = now() WHERE id = $1 AND workspace_id = $2 AND version = $4 RETURNING *',
      [old.id, req.ws, s.id, b.version]);
    if (!x) throw new HttpError(409, 'This opportunity was changed by someone else. The board has been refreshed — try again.');
    await addActivity(db, { workspaceId: req.ws, contactId: x.contact_id, opportunityId: x.id, type: 'stage_change', actorId: req.user.id, body: `Stage changed: ${old.stage_name} → ${s.name}`, data: { from: old.stage_id, to: s.id } });
    await recordLeadAction(db, { workspaceId: req.ws, user: req.user, contactId: x.contact_id, opportunityId: x.id, via: 'changed the stage' });
    emit(db, req.ws, 'crm', { opportunityId: x.id }); emit(db, req.ws, 'dashboard', {});
    return x;
  });
  res.json(maskOpp(req.user, out));
});

r.delete('/opportunities/:id', requirePerm('crm.delete'), async (req, res) => {
  await tx(async (db) => {
    const o = await visibleOpp(req, req.params.id, db);
    await db.query('UPDATE opportunities SET deleted_at = now(), version = version + 1 WHERE id = $1', [o.id]);
    await audit(db, { workspaceId: req.ws, actor: req.user, action: 'opportunity.deleted', targetType: 'opportunity', targetId: o.id, targetLabel: o.title, before: { stage: o.stage_name, value: o.value, owner_id: o.owner_id } });
    emit(db, req.ws, 'crm', {}); emit(db, req.ws, 'dashboard', {});
  });
  res.json({ ok: true });
});

r.get('/export/opportunities.csv', requirePerm('crm.export'), async (req, res) => {
  const { rows, fields } = await oppList(req, { forExport: true });
  const masked = !can(req.user, 'values.view');
  const head = ['id', 'title', 'pipeline', 'stage', 'contact', 'owner', 'value', 'currency', 'close_date', 'tags', 'payment_status', 'created_at', ...fields.map((f) => f.label)];
  const lines = rows.map((o) => [o.id, o.title, o.pipeline_name, o.stage_name, o.contact_name, o.owner_name, masked ? '***' : o.value, o.currency, o.close_date, o.tags, o.payment_status, o.created_at?.toISOString(), ...fields.map((f) => o.custom?.[f.key])].map(csvCell).join(','));
  await audit({ query }, { workspaceId: req.ws, actor: req.user, action: 'export.opportunities', targetType: 'export', after: { rows: rows.length, values_masked: masked } });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="opportunities.csv"' });
  res.send(`﻿${[head.map(csvCell).join(','), ...lines].join('\r\n')}`);
});

export default r;
