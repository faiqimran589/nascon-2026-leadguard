// Workspace configuration without code: pipelines, stages, custom fields (F2.2–F2.5),
// assignment & escalation rules (F3.3, F3.5, F3.6), workspace settings. Every change is audited.
import { z } from 'zod';
import { one, query, tx } from '../db/pool.js';
import { Router, parse, HttpError, notFound } from '../lib/http.js';
import { isValidTimeZone } from '../lib/time.js';
import { requireAuth, requirePerm, requireLevel } from '../middleware/auth.js';
import { audit, diff } from '../services/audit.js';
import { addActivity } from '../services/activity.js';
import { emit } from '../services/events.js';
import { BUILTIN_REQUIRABLE } from '../services/crm.js';

const r = Router();
r.use(requireAuth);

// ---------- Pipelines & stages ----------
r.get('/pipelines', async (req, res) => {
  const { rows: pipes } = await query('SELECT * FROM pipelines WHERE workspace_id = $1 ORDER BY position, created_at', [req.ws]);
  const { rows: stages } = await query(
    `SELECT s.*, (SELECT count(*) FROM opportunities o WHERE o.stage_id = s.id AND o.deleted_at IS NULL) AS opp_count
       FROM stages s WHERE s.workspace_id = $1 ORDER BY s.position`, [req.ws]);
  const { rows: fields } = await query("SELECT * FROM custom_fields WHERE workspace_id = $1 ORDER BY position, created_at", [req.ws]);
  res.json({
    pipelines: pipes.map((p) => ({ ...p, stages: stages.filter((s) => s.pipeline_id === p.id) })),
    fields, builtinRequirable: Object.entries(BUILTIN_REQUIRABLE).map(([key, label]) => ({ key, label })),
  });
});

r.post('/pipelines', requirePerm('pipeline.manage'), async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(1).max(60) }), req.body);
  const p = await tx(async (db) => {
    const { rows: [x] } = await db.query(
      'INSERT INTO pipelines (workspace_id, name, position) VALUES ($1,$2,(SELECT COALESCE(max(position),0)+1 FROM pipelines WHERE workspace_id = $1)) RETURNING *', [req.ws, b.name]);
    for (const [i, [name, kind]] of [['New', 'open'], ['In progress', 'open'], ['Won', 'won'], ['Lost', 'lost']].entries()) {
      await db.query('INSERT INTO stages (workspace_id, pipeline_id, name, position, kind) VALUES ($1,$2,$3,$4,$5)', [req.ws, x.id, name, i, kind]);
    }
    await audit(db, { workspaceId: req.ws, actor: req.user, action: 'pipeline.created', targetType: 'pipeline', targetId: x.id, targetLabel: x.name });
    emit(db, req.ws, 'config', {});
    return x;
  });
  res.status(201).json(p);
});

r.patch('/pipelines/:id', requirePerm('pipeline.manage'), async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(1).max(60) }), req.body);
  await tx(async (db) => {
    const { rows: [old] } = await db.query('SELECT * FROM pipelines WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [req.params.id, req.ws]);
    if (!old) throw notFound('Pipeline');
    await db.query('UPDATE pipelines SET name = $2 WHERE id = $1', [old.id, b.name]);
    await audit(db, { workspaceId: req.ws, actor: req.user, action: 'pipeline.renamed', targetType: 'pipeline', targetId: old.id, targetLabel: b.name, before: { name: old.name }, after: { name: b.name } });
    emit(db, req.ws, 'config', {});
  });
  res.json({ ok: true });
});

r.delete('/pipelines/:id', requirePerm('pipeline.manage'), async (req, res) => {
  await tx(async (db) => {
    const { rows: [old] } = await db.query('SELECT * FROM pipelines WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [req.params.id, req.ws]);
    if (!old) throw notFound('Pipeline');
    const n = (await db.query('SELECT count(*) AS n FROM opportunities WHERE pipeline_id = $1', [old.id])).rows[0].n;
    if (n > 0) throw new HttpError(409, `This pipeline still has ${n} opportunit${n === 1 ? 'y' : 'ies'} (including deleted ones kept for history). Pipelines with history cannot be deleted; rename it instead.`);
    const count = (await db.query('SELECT count(*) AS n FROM pipelines WHERE workspace_id = $1', [req.ws])).rows[0].n;
    if (count <= 1) throw new HttpError(409, 'A workspace needs at least one pipeline.');
    await db.query('DELETE FROM pipelines WHERE id = $1', [old.id]);
    await audit(db, { workspaceId: req.ws, actor: req.user, action: 'pipeline.deleted', targetType: 'pipeline', targetId: old.id, targetLabel: old.name });
    emit(db, req.ws, 'config', {});
  });
  res.json({ ok: true });
});

const stageBody = z.object({
  name: z.string().trim().min(1).max(60), kind: z.enum(['open', 'won', 'lost']).default('open'),
  requiredFields: z.array(z.string().max(60)).max(30).optional(),
});

async function checkRequired(db, ws, pipelineId, keys) {
  if (!keys) return;
  const { rows } = await db.query("SELECT key FROM custom_fields WHERE workspace_id = $1 AND entity = 'opportunity' AND (pipeline_id IS NULL OR pipeline_id = $2)", [ws, pipelineId]);
  const ok = new Set([...Object.keys(BUILTIN_REQUIRABLE), ...rows.map((x) => x.key)]);
  const bad = keys.filter((k) => !ok.has(k));
  if (bad.length) throw new HttpError(400, `Unknown field(s) for this pipeline: ${bad.join(', ')}`);
}

r.post('/pipelines/:id/stages', requirePerm('pipeline.manage'), async (req, res) => {
  const b = parse(stageBody, req.body);
  const s = await tx(async (db) => {
    const { rows: [p] } = await db.query('SELECT * FROM pipelines WHERE id = $1 AND workspace_id = $2', [req.params.id, req.ws]);
    if (!p) throw notFound('Pipeline');
    await checkRequired(db, req.ws, p.id, b.requiredFields);
    const { rows: [x] } = await db.query(
      `INSERT INTO stages (workspace_id, pipeline_id, name, kind, required_fields, position)
       VALUES ($1,$2,$3,$4,$5,(SELECT COALESCE(max(position),0)+1 FROM stages WHERE pipeline_id = $2)) RETURNING *`,
      [req.ws, p.id, b.name, b.kind, b.requiredFields || []]);
    await audit(db, { workspaceId: req.ws, actor: req.user, action: 'stage.created', targetType: 'stage', targetId: x.id, targetLabel: `${p.name} / ${x.name}`, after: { kind: x.kind, required_fields: x.required_fields } });
    emit(db, req.ws, 'config', {});
    return x;
  });
  res.status(201).json(s);
});

r.patch('/stages/:id', requirePerm('pipeline.manage'), async (req, res) => {
  const b = parse(stageBody.partial(), req.body);
  const s = await tx(async (db) => {
    const { rows: [old] } = await db.query('SELECT * FROM stages WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [req.params.id, req.ws]);
    if (!old) throw notFound('Stage');
    await checkRequired(db, req.ws, old.pipeline_id, b.requiredFields);
    if (b.kind && b.kind !== 'open' && old.kind === 'open') {
      const open = (await db.query("SELECT count(*) AS n FROM stages WHERE pipeline_id = $1 AND kind = 'open'", [old.pipeline_id])).rows[0].n;
      if (open <= 1) throw new HttpError(409, 'A pipeline needs at least one open stage.');
    }
    const { rows: [x] } = await db.query('UPDATE stages SET name = COALESCE($2, name), kind = COALESCE($3, kind), required_fields = COALESCE($4, required_fields) WHERE id = $1 RETURNING *',
      [old.id, b.name ?? null, b.kind ?? null, b.requiredFields ?? null]);
    const d = diff(old, x, ['name', 'kind', 'required_fields']);
    if (d) await audit(db, { workspaceId: req.ws, actor: req.user, action: 'stage.updated', targetType: 'stage', targetId: x.id, targetLabel: x.name, ...d });
    emit(db, req.ws, 'config', {});
    return x;
  });
  res.json(s);
});

r.put('/pipelines/:id/stage-order', requirePerm('pipeline.manage'), async (req, res) => {
  const b = parse(z.object({ stageIds: z.array(z.string().uuid()).min(1).max(50) }), req.body);
  await tx(async (db) => {
    const { rows } = await db.query('SELECT id, name, position FROM stages WHERE pipeline_id = $1 AND workspace_id = $2 ORDER BY position FOR UPDATE', [req.params.id, req.ws]);
    if (!rows.length) throw notFound('Pipeline');
    const ids = new Set(rows.map((x) => x.id));
    if (b.stageIds.length !== rows.length || !b.stageIds.every((id) => ids.has(id))) throw new HttpError(400, 'Send every stage of the pipeline exactly once.');
    for (const [i, id] of b.stageIds.entries()) await db.query('UPDATE stages SET position = $2 WHERE id = $1', [id, i]);
    await audit(db, { workspaceId: req.ws, actor: req.user, action: 'stage.reordered', targetType: 'pipeline', targetId: req.params.id, before: { order: rows.map((x) => x.name) }, after: { order: b.stageIds.map((id) => rows.find((x) => x.id === id).name) } });
    emit(db, req.ws, 'config', {});
  });
  res.json({ ok: true });
});

// Deleting a stage that still holds opportunities requires choosing where they go (F2.5, Q4).
r.delete('/stages/:id', requirePerm('pipeline.manage'), async (req, res) => {
  const moveTo = req.query.moveTo || null;
  const out = await tx(async (db) => {
    const { rows: [old] } = await db.query('SELECT * FROM stages WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [req.params.id, req.ws]);
    if (!old) throw notFound('Stage');
    const { rows: siblings } = await db.query('SELECT * FROM stages WHERE pipeline_id = $1 AND id <> $2', [old.pipeline_id, old.id]);
    if (!siblings.some((s) => s.kind === 'open')) throw new HttpError(409, 'A pipeline needs at least one open stage.');
    const { rows: opps } = await db.query('SELECT id, contact_id FROM opportunities WHERE stage_id = $1 FOR UPDATE', [old.id]);
    let target = null;
    if (opps.length) {
      if (!moveTo) throw new HttpError(409, `This stage contains ${opps.length} opportunit${opps.length === 1 ? 'y' : 'ies'}. Choose a stage to move them to.`, { count: opps.length, needsMoveTo: true });
      target = siblings.find((s) => s.id === moveTo);
      if (!target) throw new HttpError(400, 'Target stage must be another stage of the same pipeline.');
      await db.query('UPDATE opportunities SET stage_id = $2, stage_changed_at = now(), version = version + 1, updated_at = now() WHERE stage_id = $1', [old.id, target.id]);
      for (const o of opps) {
        await addActivity(db, { workspaceId: req.ws, contactId: o.contact_id, opportunityId: o.id, type: 'stage_change', actorId: req.user.id, body: `Stage "${old.name}" was deleted — moved to "${target.name}"` });
      }
    }
    await db.query('DELETE FROM stages WHERE id = $1', [old.id]);
    await audit(db, { workspaceId: req.ws, actor: req.user, action: 'stage.deleted', targetType: 'stage', targetId: old.id, targetLabel: old.name, before: { name: old.name, kind: old.kind }, after: { moved: opps.length, moved_to: target?.name || null } });
    emit(db, req.ws, 'config', {}); emit(db, req.ws, 'crm', {});
    return { moved: opps.length };
  });
  res.json(out);
});

// ---------- Custom fields (F2.2, F2.3) ----------
const fieldBody = z.object({
  entity: z.enum(['contact', 'company', 'opportunity']), label: z.string().trim().min(1).max(60),
  type: z.enum(['text', 'number', 'date', 'dropdown', 'checkbox']), options: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  pipelineId: z.string().uuid().nullable().optional(),
});

r.post('/fields', requirePerm('pipeline.manage'), async (req, res) => {
  const b = parse(fieldBody, req.body);
  if (b.type === 'dropdown' && !(b.options?.length)) throw new HttpError(400, 'A dropdown needs at least one option.');
  if (b.pipelineId && b.entity !== 'opportunity') throw new HttpError(400, 'Only opportunity fields can be limited to a pipeline.');
  const f = await tx(async (db) => {
    if (b.pipelineId && !(await db.query('SELECT 1 FROM pipelines WHERE id = $1 AND workspace_id = $2', [b.pipelineId, req.ws])).rows.length) throw notFound('Pipeline');
    let base = b.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'field';
    if (/^\d/.test(base)) base = `f_${base}`;
    if (BUILTIN_REQUIRABLE[base]) base = `custom_${base}`;
    let key = base;
    for (let i = 2; (await db.query('SELECT 1 FROM custom_fields WHERE workspace_id = $1 AND entity = $2 AND key = $3', [req.ws, b.entity, key])).rows.length; i++) key = `${base}_${i}`;
    const { rows: [x] } = await db.query(
      `INSERT INTO custom_fields (workspace_id, entity, pipeline_id, key, label, type, options, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT COALESCE(max(position),0)+1 FROM custom_fields WHERE workspace_id = $1 AND entity = $2)) RETURNING *`,
      [req.ws, b.entity, b.pipelineId || null, key, b.label, b.type, b.type === 'dropdown' ? b.options : []]);
    await audit(db, { workspaceId: req.ws, actor: req.user, action: 'field.created', targetType: 'custom_field', targetId: x.id, targetLabel: `${b.entity}.${x.label}`, after: { type: x.type, options: x.options, pipeline_id: x.pipeline_id } });
    emit(db, req.ws, 'config', {});
    return x;
  });
  res.status(201).json(f);
});

r.patch('/fields/:id', requirePerm('pipeline.manage'), async (req, res) => {
  const b = parse(z.object({ label: z.string().trim().min(1).max(60).optional(), options: z.array(z.string().trim().min(1).max(60)).max(50).optional() }), req.body);
  const f = await tx(async (db) => {
    const { rows: [old] } = await db.query('SELECT * FROM custom_fields WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [req.params.id, req.ws]);
    if (!old) throw notFound('Field');
    if (b.options && old.type !== 'dropdown') throw new HttpError(400, 'Only dropdown fields have options.');
    if (b.options) {
      const table = { contact: 'contacts', company: 'companies', opportunity: 'opportunities' }[old.entity];
      const used = (await db.query(`SELECT DISTINCT custom->>$2 AS v FROM ${table} WHERE workspace_id = $1 AND custom ? $2`, [req.ws, old.key])).rows.map((x) => x.v);
      const removed = used.filter((v) => !b.options.includes(v));
      if (removed.length) throw new HttpError(409, `These options are still used by records: ${removed.join(', ')}. Change those records first.`);
    }
    const { rows: [x] } = await db.query('UPDATE custom_fields SET label = COALESCE($2, label), options = COALESCE($3, options) WHERE id = $1 RETURNING *', [old.id, b.label ?? null, b.options ?? null]);
    const d = diff(old, x, ['label', 'options']);
    if (d) await audit(db, { workspaceId: req.ws, actor: req.user, action: 'field.updated', targetType: 'custom_field', targetId: x.id, targetLabel: x.label, ...d });
    emit(db, req.ws, 'config', {});
    return x;
  });
  res.json(f);
});

// Deleting a field removes its stored values and any stage requirement on it (no orphans, Q4).
r.delete('/fields/:id', requirePerm('pipeline.manage'), async (req, res) => {
  await tx(async (db) => {
    const { rows: [old] } = await db.query('SELECT * FROM custom_fields WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [req.params.id, req.ws]);
    if (!old) throw notFound('Field');
    const table = { contact: 'contacts', company: 'companies', opportunity: 'opportunities' }[old.entity];
    const { rowCount } = await db.query(`UPDATE ${table} SET custom = custom - $2 WHERE workspace_id = $1 AND custom ? $2`, [req.ws, old.key]);
    if (old.entity === 'opportunity') await db.query('UPDATE stages SET required_fields = array_remove(required_fields, $2) WHERE workspace_id = $1', [req.ws, old.key]);
    await db.query('DELETE FROM custom_fields WHERE id = $1', [old.id]);
    await audit(db, { workspaceId: req.ws, actor: req.user, action: 'field.deleted', targetType: 'custom_field', targetId: old.id, targetLabel: `${old.entity}.${old.label}`, before: { type: old.type, key: old.key }, after: { values_removed: rowCount } });
    emit(db, req.ws, 'config', {});
  });
  res.json({ ok: true });
});

// ---------- Assignment & escalation rules ----------
r.get('/rules', async (req, res) => {
  res.json(await one('SELECT * FROM assignment_rules WHERE workspace_id = $1', [req.ws]));
});

r.put('/rules', requirePerm('rules.manage'), async (req, res) => {
  const b = parse(z.object({
    maxOpenLeads: z.number().int().min(1).max(1000),
    ackWindowSeconds: z.number().int().min(3).max(7 * 86400),
    escalationLevels: z.array(z.object({ type: z.enum(['next_available', 'backup', 'manager']), seconds: z.number().int().min(3).max(7 * 86400) })).min(1).max(6),
    backupUserId: z.string().uuid().nullable(), managerUserId: z.string().uuid().nullable(),
    idleSeconds: z.number().int().min(10).max(30 * 86400),
    acknowledgedOnAbsence: z.enum(['reassign', 'keep']),
  }), req.body);
  const out = await tx(async (db) => {
    for (const id of [b.backupUserId, b.managerUserId].filter(Boolean)) {
      if (!(await db.query('SELECT 1 FROM users WHERE id = $1 AND workspace_id = $2 AND active', [id, req.ws])).rows.length) throw notFound('Employee');
    }
    const { rows: [old] } = await db.query('SELECT * FROM assignment_rules WHERE workspace_id = $1 FOR UPDATE', [req.ws]);
    const { rows: [x] } = await db.query(
      `UPDATE assignment_rules SET max_open_leads=$2, ack_window_seconds=$3, escalation_levels=$4, backup_user_id=$5, manager_user_id=$6,
              idle_seconds=$7, acknowledged_on_absence=$8, updated_at=now() WHERE workspace_id=$1 RETURNING *`,
      [req.ws, b.maxOpenLeads, b.ackWindowSeconds, JSON.stringify(b.escalationLevels), b.backupUserId, b.managerUserId, b.idleSeconds, b.acknowledgedOnAbsence]);
    const d = diff(old, x, ['max_open_leads', 'ack_window_seconds', 'escalation_levels', 'backup_user_id', 'manager_user_id', 'idle_seconds', 'acknowledged_on_absence']);
    if (d) await audit(db, { workspaceId: req.ws, actor: req.user, action: 'rules.updated', targetType: 'assignment_rules', targetId: req.ws, ...d });
    emit(db, req.ws, 'config', {});
    return x;
  });
  res.json(out);
});

// ---------- Workspace settings ----------
r.patch('/workspace', requireLevel('owner', 'admin'), async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(2).max(80).optional(),
    timezone: z.string().max(64).refine(isValidTimeZone, 'Unknown time zone').optional(),
    defaultCurrency: z.string().length(3).toLowerCase().optional(),
  }), req.body);
  await tx(async (db) => {
    const { rows: [old] } = await db.query('SELECT * FROM workspaces WHERE id = $1 FOR UPDATE', [req.ws]);
    if (b.defaultCurrency && b.defaultCurrency !== old.default_currency) {
      const n = (await db.query('SELECT count(*) AS n FROM opportunities WHERE workspace_id = $1 AND value IS NOT NULL AND deleted_at IS NULL', [req.ws])).rows[0].n;
      if (n > 0) throw new HttpError(409, `The currency cannot change while ${n} opportunit${n === 1 ? 'y has' : 'ies have'} values in ${old.default_currency.toUpperCase()} (pipeline totals would mix currencies).`);
    }
    const { rows: [x] } = await db.query('UPDATE workspaces SET name = COALESCE($2,name), timezone = COALESCE($3,timezone), default_currency = COALESCE($4, default_currency) WHERE id = $1 RETURNING *',
      [req.ws, b.name ?? null, b.timezone ?? null, b.defaultCurrency ?? null]);
    const d = diff(old, x, ['name', 'timezone', 'default_currency']);
    if (d) await audit(db, { workspaceId: req.ws, actor: req.user, action: 'workspace.updated', targetType: 'workspace', targetId: req.ws, ...d });
  });
  res.json({ ok: true });
});

export default r;
