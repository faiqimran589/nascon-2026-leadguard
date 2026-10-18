// Lead engine (F3): intake, round-robin assignment, acknowledgement, escalation chain,
// reassignment on absence and manual reassignment.
//
// Concurrency rules (F3.8 / Q5):
//  * A lead has exactly one owner column -> never two owners.
//  * Every change to a lead's ownership locks the lead row first (SELECT ... FOR UPDATE),
//    then the workspace's assignment_rules row. Same order everywhere -> no deadlocks.
//  * The escalation worker claims due leads with FOR UPDATE SKIP LOCKED and re-checks the
//    deadline under the lock, so two timers / two workers can never escalate the same lead twice.
//  * Deadlines live in the database, so a server restart loses nothing; the worker catches up.
import { query, tx } from '../db/pool.js';
import { audit } from './audit.js';
import { addActivity } from './activity.js';
import { emit } from './events.js';
import { notifyUser, enqueueEscalationAlert, sourceLabel } from './notify.js';
import { normalizePhone } from '../lib/phone.js';

export { emit };

const OPEN = "('assigned','acknowledged')";

export async function getRules(db, workspaceId, { lock = false } = {}) {
  const { rows: [r] } = await db.query(
    `SELECT * FROM assignment_rules WHERE workspace_id = $1 ${lock ? 'FOR UPDATE' : ''}`, [workspaceId]);
  return r;
}

async function userById(db, workspaceId, id) {
  if (!id) return null;
  const { rows: [u] } = await db.query(
    'SELECT id, name, email, level, availability, active FROM users WHERE id = $1 AND workspace_id = $2', [id, workspaceId]);
  return u || null;
}

// "Available employee" (Glossary): status Available and open-lead count below the limit.
export async function availableEmployees(db, workspaceId, maxOpen, excludeIds = []) {
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.email,
            (SELECT count(*) FROM leads l WHERE l.owner_id = u.id AND l.status IN ${OPEN}) AS open_leads
       FROM users u
      WHERE u.workspace_id = $1 AND u.active AND u.availability = 'available'
        AND u.password_hash IS NOT NULL AND NOT (u.id = ANY($2::uuid[]))
      ORDER BY u.created_at, u.id`,
    [workspaceId, excludeIds],
  );
  return rows.filter((u) => u.open_leads < maxOpen);
}

// Round-robin among available employees; remembers the last pick in assignment_rules.
async function pickRoundRobin(db, workspaceId, rules, excludeIds = []) {
  const candidates = await availableEmployees(db, workspaceId, rules.max_open_leads, excludeIds);
  if (!candidates.length) return null;
  const { rows: all } = await db.query(
    'SELECT id FROM users WHERE workspace_id = $1 ORDER BY created_at, id', [workspaceId]);
  const order = all.map((u) => u.id);
  const lastIdx = order.indexOf(rules.rr_last_user_id);
  let pick = null;
  for (let step = 1; step <= order.length && !pick; step++) {
    const id = order[(lastIdx + step + order.length) % order.length];
    pick = candidates.find((c) => c.id === id) || null;
  }
  pick = pick || candidates[0];
  await db.query('UPDATE assignment_rules SET rr_last_user_id = $2 WHERE workspace_id = $1', [workspaceId, pick.id]);
  rules.rr_last_user_id = pick.id;
  return pick;
}

async function ownerOf(db, workspaceId) {
  const { rows: [o] } = await db.query(
    "SELECT id, name, email FROM users WHERE workspace_id = $1 AND level = 'owner' AND active LIMIT 1", [workspaceId]);
  return o;
}

const reachable = (u) => u && u.active && !['on_leave', 'offline'].includes(u.availability);

// Fallback when nobody is Available: backup -> manager -> owner (a lead is never left without an owner).
async function fallbackTarget(db, workspaceId, rules, excludeIds) {
  for (const [id, label] of [[rules.backup_user_id, 'backup'], [rules.manager_user_id, 'manager']]) {
    const u = await userById(db, workspaceId, id);
    if (reachable(u) && !excludeIds.includes(u.id)) return { user: u, label };
  }
  return { user: await ownerOf(db, workspaceId), label: 'owner' };
}

// Core ownership change. Caller must hold the lead row lock.
async function setOwner(db, lead, toUser, { kind, level, reason, actor, deadlineSeconds, exhausted = false }) {
  const fromUserId = lead.owner_id;
  const { rows: [updated] } = await db.query(
    `UPDATE leads SET owner_id = $2, status = 'assigned', assigned_at = now(),
            first_assigned_at = COALESCE(first_assigned_at, now()),
            ack_deadline = CASE WHEN $3::int IS NULL THEN ack_deadline ELSE now() + make_interval(secs => $3::int) END,
            escalation_level = $4, escalation_count = escalation_count + $5,
            chain_exhausted = $6, acknowledged_at = NULL, version = version + 1
      WHERE id = $1 RETURNING *`,
    [lead.id, toUser.id, deadlineSeconds, level, kind === 'escalation' ? 1 : 0, exhausted],
  );
  await db.query(
    `INSERT INTO lead_assignments (workspace_id, lead_id, from_user_id, to_user_id, kind, level, reason, actor_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [lead.workspace_id, lead.id, fromUserId, toUser.id, kind, level, reason, actor?.id || null],
  );
  // The contact (and therefore its conversations) follows the accountable lead owner.
  await db.query('UPDATE contacts SET owner_id = $2, updated_at = now() WHERE id = $1', [lead.contact_id, toUser.id]);

  const verb = { initial: 'assigned', fallback: 'assigned (fallback)', escalation: 'escalated', manual: 'reassigned', absence: 'reassigned (absence)' }[kind];
  await addActivity(db, {
    workspaceId: lead.workspace_id, contactId: lead.contact_id, opportunityId: lead.opportunity_id, leadId: lead.id,
    type: kind === 'escalation' ? 'escalation' : 'assignment', actorId: actor?.id,
    body: `Lead ${verb} to ${toUser.name}${reason ? ` — ${reason}` : ''}`,
    data: { from: fromUserId, to: toUser.id, kind, level },
  });
  await audit(db, {
    workspaceId: lead.workspace_id, actor,
    action: kind === 'escalation' ? 'lead.escalated' : (kind === 'initial' || kind === 'fallback') ? 'lead.assigned' : 'lead.reassigned',
    targetType: 'lead', targetId: lead.id, targetLabel: lead.title,
    before: fromUserId ? { owner_id: fromUserId, status: lead.status, level: lead.escalation_level } : null,
    after: { owner_id: toUser.id, owner: toUser.name, kind, level, reason },
  });
  await notifyUser(db, {
    workspaceId: lead.workspace_id, userId: toUser.id,
    title: kind === 'escalation' ? `Escalated lead: ${lead.title}` : `New lead assigned: ${lead.title}`,
    body: deadlineSeconds ? `Acknowledge within ${formatSecs(deadlineSeconds)}. ${reason || ''}`.trim() : reason,
    link: `/leads/${lead.id}`,
  });
  if (kind === 'escalation') {
    await enqueueEscalationAlert(db, { workspaceId: lead.workspace_id, userId: toUser.id, lead: updated, reason });
  }
  emit(db, lead.workspace_id, 'leads', { id: lead.id });
  return updated;
}

export function formatSecs(s) {
  if (s < 120) return `${s} seconds`;
  if (s < 7200) return `${Math.round(s / 60)} minutes`;
  return `${Math.round(s / 3600)} hours`;
}

// Initial assignment of a freshly created lead (lead row already inserted in this transaction).
async function assignNew(db, lead, actor) {
  const rules = await getRules(db, lead.workspace_id, { lock: true });
  let target = await pickRoundRobin(db, lead.workspace_id, rules);
  let kind = 'initial';
  let reason = 'Round-robin among available employees';
  if (!target) {
    const fb = await fallbackTarget(db, lead.workspace_id, rules, []);
    target = fb.user; kind = 'fallback';
    reason = `No available employee (all busy, on leave, offline or at the ${rules.max_open_leads}-lead limit) — assigned to ${fb.label}`;
  }
  return setOwner(db, lead, target, { kind, level: 0, reason, actor, deadlineSeconds: rules.ack_window_seconds });
}

// ---------- Intake (F3.1) ----------
export async function findOrCreateContact(db, workspaceId, { firstName, lastName, email, phone, source, companyId }) {
  const nPhone = normalizePhone(phone);
  const nEmail = email ? String(email).trim().toLowerCase() : null;
  if (nPhone || nEmail) {
    const { rows: [c] } = await db.query(
      `SELECT * FROM contacts WHERE workspace_id = $1 AND deleted_at IS NULL
         AND (($2::text IS NOT NULL AND phone = $2) OR ($3::text IS NOT NULL AND lower(email) = $3))
       ORDER BY created_at LIMIT 1`,
      [workspaceId, nPhone, nEmail]);
    if (c) return { contact: c, created: false };
  }
  const { rows: [c] } = await db.query(
    `INSERT INTO contacts (workspace_id, first_name, last_name, email, phone, source, company_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [workspaceId, firstName || nPhone || nEmail || 'Unknown', lastName || '', nEmail, nPhone, source, companyId || null]);
  await addActivity(db, { workspaceId, contactId: c.id, type: 'contact_created', body: `Contact created from ${sourceLabel(source)}` });
  return { contact: c, created: true };
}

export async function createLead(db, { workspaceId, source, contactId, contact, title, message, actor }) {
  let c;
  if (contactId) {
    const { rows: [row] } = await db.query(
      'SELECT * FROM contacts WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL', [contactId, workspaceId]);
    if (!row) throw Object.assign(new Error('Contact not found'), { status: 404 });
    c = row;
  } else {
    c = (await findOrCreateContact(db, workspaceId, { ...contact, source })).contact;
  }
  const leadTitle = title || `${[c.first_name, c.last_name].filter(Boolean).join(' ')} via ${sourceLabel(source)}`;
  const { rows: [lead] } = await db.query(
    `INSERT INTO leads (workspace_id, contact_id, source, title, message) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [workspaceId, c.id, source, leadTitle, message || null]);
  await addActivity(db, {
    workspaceId, contactId: c.id, leadId: lead.id, type: 'lead_created', actorId: actor?.id,
    body: `Lead captured from ${sourceLabel(source)}${message ? `: “${String(message).slice(0, 200)}”` : ''}`,
  });
  await audit(db, { workspaceId, actor, action: 'lead.created', targetType: 'lead', targetId: lead.id, targetLabel: leadTitle, after: { source, contact_id: c.id } });
  const assigned = await assignNew(db, lead, actor);
  emit(db, workspaceId, 'dashboard', {});
  return assigned;
}

// ---------- Acknowledgement (F3.4) ----------
export async function acknowledge(db, { workspaceId, leadId, user, via = 'Acknowledge button' }) {
  const { rows: [lead] } = await db.query(
    `UPDATE leads SET status = 'acknowledged', acknowledged_at = now(),
            first_acknowledged_at = COALESCE(first_acknowledged_at, now()),
            first_acknowledged_by = COALESCE(first_acknowledged_by, $3),
            ack_deadline = NULL, chain_exhausted = false, last_action_at = now(), version = version + 1
      WHERE id = $1 AND workspace_id = $2 AND owner_id = $3 AND status = 'assigned'
      RETURNING *`,
    [leadId, workspaceId, user.id]);
  if (!lead) return null;
  await addActivity(db, { workspaceId, contactId: lead.contact_id, opportunityId: lead.opportunity_id, leadId, type: 'acknowledged', actorId: user.id, body: `Lead acknowledged by ${user.name} (${via})` });
  await audit(db, { workspaceId, actor: user, action: 'lead.acknowledged', targetType: 'lead', targetId: leadId, targetLabel: lead.title, before: { status: 'assigned' }, after: { status: 'acknowledged', via } });
  emit(db, workspaceId, 'leads', { id: leadId });
  return lead;
}

// Any recorded action (note, message, call, stage change, appointment) acknowledges the actor's
// pending leads for that contact/opportunity and refreshes "last action" for idle detection.
export async function recordLeadAction(db, { workspaceId, user, contactId, opportunityId, leadId, via }) {
  const conds = []; const params = [workspaceId];
  if (leadId) { params.push(leadId); conds.push(`id = $${params.length}`); }
  if (contactId) { params.push(contactId); conds.push(`contact_id = $${params.length}`); }
  if (opportunityId) { params.push(opportunityId); conds.push(`opportunity_id = $${params.length}`); }
  if (!conds.length) return;
  const { rows } = await db.query(
    `UPDATE leads SET last_action_at = now() WHERE workspace_id = $1 AND status IN ${OPEN} AND (${conds.join(' OR ')})
     RETURNING id, owner_id, status`, params);
  for (const l of rows) {
    if (user && l.status === 'assigned' && l.owner_id === user.id) {
      await acknowledge(db, { workspaceId, leadId: l.id, user, via });
    }
  }
  if (rows.length) emit(db, workspaceId, 'leads', {});
}

// ---------- Escalation (F3.5) ----------
// Escalates one due lead. Must be called inside a transaction holding the lead's row lock.
async function escalateLocked(db, lead) {
  const rules = await getRules(db, lead.workspace_id, { lock: true });
  const levels = Array.isArray(rules.escalation_levels) ? rules.escalation_levels : [];
  const { rows: prev } = await db.query(
    'SELECT DISTINCT to_user_id FROM lead_assignments WHERE lead_id = $1 AND to_user_id IS NOT NULL', [lead.id]);
  const tried = prev.map((r) => r.to_user_id);
  const current = await userById(db, lead.workspace_id, lead.owner_id);
  const missedBy = current ? current.name : 'previous owner';

  for (let idx = lead.escalation_level; idx < levels.length; idx++) {
    const lvl = levels[idx];
    let target = null;
    if (lvl.type === 'next_available') {
      target = await pickRoundRobin(db, lead.workspace_id, rules, tried);
    } else if (lvl.type === 'backup') {
      const u = await userById(db, lead.workspace_id, rules.backup_user_id);
      if (reachable(u) && u.id !== lead.owner_id) target = u;
    } else if (lvl.type === 'manager') {
      let u = await userById(db, lead.workspace_id, rules.manager_user_id);
      if (!u || !u.active || ['on_leave', 'offline'].includes(u.availability)) u = await ownerOf(db, lead.workspace_id);
      if (u && u.id !== lead.owner_id) target = u;
    }
    if (target) {
      const label = { next_available: 'next available employee', backup: 'designated backup', manager: 'manager' }[lvl.type];
      return setOwner(db, lead, target, {
        kind: 'escalation', level: idx + 1, actor: null, deadlineSeconds: Number(lvl.seconds) || 60,
        reason: `Not acknowledged by ${missedBy} within the window — escalated to ${label} (level ${idx + 1} of ${levels.length})`,
      });
    }
  }
  // Chain exhausted: the lead stays with its current owner, flagged for the recovery queue.
  await db.query('UPDATE leads SET chain_exhausted = true, version = version + 1 WHERE id = $1', [lead.id]);
  await audit(db, { workspaceId: lead.workspace_id, actor: null, action: 'lead.escalation_exhausted', targetType: 'lead', targetId: lead.id, targetLabel: lead.title, after: { owner_id: lead.owner_id, level: lead.escalation_level } });
  const notifyIds = new Set([rules.manager_user_id, (await ownerOf(db, lead.workspace_id))?.id, lead.owner_id].filter(Boolean));
  for (const uid of notifyIds) {
    await notifyUser(db, { workspaceId: lead.workspace_id, userId: uid, title: `Lead still unacknowledged: ${lead.title}`, body: 'Escalation chain finished — the lead is in the recovery queue.', link: `/leads/${lead.id}` });
  }
  emit(db, lead.workspace_id, 'leads', { id: lead.id });
  return null;
}

// Called by the worker every few seconds. Each lead is escalated in its own transaction and
// re-checked under a row lock (SKIP LOCKED) so concurrent timers/workers cannot double-escalate.
export async function processDueEscalations() {
  const { rows } = await query(
    `SELECT id FROM leads WHERE status = 'assigned' AND NOT chain_exhausted AND ack_deadline <= now()
      ORDER BY ack_deadline LIMIT 50`);
  let n = 0;
  for (const { id } of rows) {
    try {
      const done = await tx(async (db) => {
        const { rows: [lead] } = await db.query(
          `SELECT * FROM leads WHERE id = $1 AND status = 'assigned' AND NOT chain_exhausted AND ack_deadline <= now()
            FOR UPDATE SKIP LOCKED`, [id]);
        if (!lead) return false;
        await escalateLocked(db, lead);
        return true;
      });
      if (done) n++;
    } catch (e) {
      console.error('[escalation] lead', id, e.message);
    }
  }
  return n;
}

// ---------- Manual reassignment ----------
export async function reassign(db, { workspaceId, leadId, toUserId, actor, reason }) {
  const { rows: [lead] } = await db.query(
    `SELECT * FROM leads WHERE id = $1 AND workspace_id = $2 AND status IN ${OPEN} FOR UPDATE`, [leadId, workspaceId]);
  if (!lead) throw Object.assign(new Error('Open lead not found'), { status: 404 });
  const to = await userById(db, workspaceId, toUserId);
  if (!to || !to.active) throw Object.assign(new Error('Employee not found'), { status: 404 });
  if (['on_leave', 'offline'].includes(to.availability)) {
    throw Object.assign(new Error(`${to.name} is ${to.availability.replace('_', ' ')} and cannot receive leads`), { status: 409 });
  }
  if (to.id === lead.owner_id) throw Object.assign(new Error(`${to.name} already owns this lead`), { status: 409 });
  const rules = await getRules(db, workspaceId, { lock: true });
  return setOwner(db, lead, to, {
    kind: 'manual', level: 0, actor, deadlineSeconds: rules.ack_window_seconds,
    reason: reason || `Manually reassigned by ${actor.name}`,
  });
}

// ---------- Absence (F3.6) ----------
// When an employee goes On leave / Offline: unacknowledged leads move immediately;
// acknowledged leads follow the workspace rule ('reassign' or 'keep').
export async function reassignOnAbsence(db, { workspaceId, userId, actor, newStatus }) {
  const { rows: leads } = await db.query(
    `SELECT * FROM leads WHERE workspace_id = $1 AND owner_id = $2 AND status IN ${OPEN} ORDER BY created_at FOR UPDATE`,
    [workspaceId, userId]);
  const rules = await getRules(db, workspaceId, { lock: true });
  const out = { unacknowledged: 0, acknowledgedMoved: 0, acknowledgedKept: 0 };
  const statusLabel = newStatus.replace('_', ' ');
  for (const lead of leads) {
    if (lead.status === 'acknowledged' && rules.acknowledged_on_absence === 'keep') { out.acknowledgedKept++; continue; }
    let target = await pickRoundRobin(db, workspaceId, rules, [userId]);
    let label = 'next available employee';
    if (!target) {
      const fb = await fallbackTarget(db, workspaceId, rules, [userId]);
      target = fb.user; label = fb.label;
    }
    if (!target || target.id === userId) continue;
    await setOwner(db, lead, target, {
      kind: 'absence', level: 0, actor, deadlineSeconds: rules.ack_window_seconds,
      reason: `Previous owner went ${statusLabel} — moved to ${label}`,
    });
    if (lead.status === 'acknowledged') out.acknowledgedMoved++; else out.unacknowledged++;
  }
  return out;
}

