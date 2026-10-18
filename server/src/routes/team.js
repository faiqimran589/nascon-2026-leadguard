// Team (users, invitations, availability), roles & permissions, profile, notifications, live events.
import { z } from 'zod';
import { config } from '../config.js';
import { one, query, tx } from '../db/pool.js';
import { Router, parse, HttpError, notFound } from '../lib/http.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { isValidTimeZone } from '../lib/time.js';
import { requireAuth, requirePerm, requireLevel } from '../middleware/auth.js';
import { PERMISSIONS, ALL_PERMISSIONS, can } from '../services/permissions.js';
import { audit, diff } from '../services/audit.js';
import { addClient, emit, kickUser } from '../services/events.js';
import { reassignOnAbsence } from '../services/leads.js';
import { getIntegration } from '../integrations/store.js';
import * as telegram from '../integrations/telegram.js';

const r = Router();
r.use(requireAuth);

// ---------- Live updates (SSE, Q11) ----------
r.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const remove = addClient(req.ws, req.user.id, res);
  req.on('close', remove);
});

// ---------- Team ----------
r.get('/users', async (req, res) => {
  const admin = can(req.user, 'users.manage');
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, u.level, u.availability, u.active, u.role_id, r.name AS role_name, u.timezone, u.created_at,
            (u.password_hash IS NULL) AS invite_pending, u.invite_expires_at,
            (SELECT count(*) FROM leads l WHERE l.owner_id = u.id AND l.status IN ('assigned','acknowledged')) AS open_leads,
            (u.telegram_chat_id IS NOT NULL) AS telegram_linked,
            cc.status AS calendar_status, cc.google_email AS calendar_email
       FROM users u LEFT JOIN roles r ON r.id = u.role_id LEFT JOIN calendar_connections cc ON cc.user_id = u.id
      WHERE u.workspace_id = $1 ORDER BY u.active DESC, u.name`, [req.ws]);
  res.json(rows.map((u) => (admin ? u : {
    id: u.id, name: u.name, level: u.level, availability: u.availability, active: u.active, role_name: u.role_name,
    open_leads: u.open_leads, calendar_status: u.calendar_status, invite_pending: u.invite_pending,
  })));
});

r.post('/users/invite', requirePerm('users.manage'), async (req, res) => {
  const b = parse(z.object({
    email: z.string().trim().email().max(200), name: z.string().trim().min(1).max(80),
    level: z.enum(['admin', 'user']), roleId: z.string().uuid(),
  }), req.body);
  if (b.level === 'admin' && req.user.level !== 'owner') throw new HttpError(403, 'Only the Owner can invite Admins.');
  const role = await one('SELECT * FROM roles WHERE id = $1 AND workspace_id = $2', [b.roleId, req.ws]);
  if (!role) throw notFound('Role');
  if (await one('SELECT 1 FROM users WHERE lower(email) = lower($1)', [b.email])) throw new HttpError(409, 'A user with this email already exists.');
  const token = randomToken(24);
  const u = await tx(async (db) => {
    const { rows: [nu] } = await db.query(
      `INSERT INTO users (workspace_id, email, name, level, role_id, invite_token_hash, invite_expires_at)
       VALUES ($1, lower($2), $3, $4, $5, $6, now() + interval '7 days') RETURNING id, email, name, level`,
      [req.ws, b.email, b.name, b.level, role.id, sha256(token)]);
    await audit(db, { workspaceId: req.ws, actor: req.user, action: 'user.invited', targetType: 'user', targetId: nu.id, targetLabel: nu.email, after: { level: b.level, role: role.name } });
    emit(db, req.ws, 'team', {});
    return nu;
  });
  res.status(201).json({ user: u, inviteUrl: `${config.appUrl}/invite/${token}` });
});

r.post('/users/:id/reinvite', requirePerm('users.manage'), async (req, res) => {
  const token = randomToken(24);
  const u = await one(
    `UPDATE users SET invite_token_hash = $3, invite_expires_at = now() + interval '7 days'
      WHERE id = $1 AND workspace_id = $2 AND password_hash IS NULL RETURNING id`, [req.params.id, req.ws, sha256(token)]);
  if (!u) throw new HttpError(409, 'This user has already joined.');
  res.json({ inviteUrl: `${config.appUrl}/invite/${token}` });
});

r.patch('/users/:id', requirePerm('users.manage'), requireLevel('owner', 'admin'), async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(1).max(80).optional(), level: z.enum(['admin', 'user']).optional(),
    roleId: z.string().uuid().optional(), active: z.boolean().optional(),
  }), req.body);
  const out = await tx(async (db) => {
    const { rows: [t] } = await db.query('SELECT * FROM users WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [req.params.id, req.ws]);
    if (!t) throw notFound('User');
    if (t.level === 'owner') throw new HttpError(403, 'The Owner cannot be modified here.');
    if (req.user.level !== 'owner' && (t.level === 'admin' || b.level === 'admin')) throw new HttpError(403, 'Only the Owner can change Admins or grant the Admin level.');
    if (t.id === req.user.id && (b.active === false || b.level)) throw new HttpError(403, 'You cannot change your own level or deactivate yourself.');
    if (b.roleId && !(await db.query('SELECT 1 FROM roles WHERE id = $1 AND workspace_id = $2', [b.roleId, req.ws])).rows.length) throw notFound('Role');
    const { rows: [u] } = await db.query(
      `UPDATE users SET name = COALESCE($2, name), level = COALESCE($3, level), role_id = COALESCE($4, role_id),
              active = COALESCE($5, active), availability = CASE WHEN $5 = false THEN 'offline' ELSE availability END
        WHERE id = $1 RETURNING *`, [t.id, b.name ?? null, b.level ?? null, b.roleId ?? null, b.active ?? null]);
    const d = diff(t, u, ['name', 'level', 'role_id', 'active']);
    if (d) await audit(db, { workspaceId: req.ws, actor: req.user, action: b.level || b.roleId ? 'user.role_changed' : 'user.updated', targetType: 'user', targetId: t.id, targetLabel: t.email, ...d });
    let moved = null;
    if (b.active === false) {
      await db.query('DELETE FROM sessions WHERE user_id = $1', [t.id]);
      moved = await reassignOnAbsence(db, { workspaceId: req.ws, userId: t.id, actor: req.user, newStatus: 'offline' });
      if (t.availability !== 'offline') { /* forced offline when deactivated */ }
      // Deactivated users are no longer anyone's backup/manager
      await db.query('UPDATE assignment_rules SET backup_user_id = CASE WHEN backup_user_id = $2 THEN NULL ELSE backup_user_id END, manager_user_id = CASE WHEN manager_user_id = $2 THEN NULL ELSE manager_user_id END WHERE workspace_id = $1', [req.ws, t.id]);
    }
    emit(db, req.ws, 'team', {});
    return { user: { id: u.id, name: u.name, level: u.level, active: u.active }, moved };
  });
  if (b.active === false) kickUser(req.ws, req.params.id);
  res.json(out);
});

// Availability (F3.2). Self, or someone with leads.reassign / users.manage.
r.patch('/users/:id/availability', async (req, res) => {
  const b = parse(z.object({ availability: z.enum(['available', 'busy', 'on_leave', 'offline']) }), req.body);
  const self = req.params.id === req.user.id;
  if (!self && !can(req.user, 'leads.reassign') && !can(req.user, 'users.manage')) throw new HttpError(403, 'You can only change your own status.');
  const out = await tx(async (db) => {
    const { rows: [t] } = await db.query('SELECT * FROM users WHERE id = $1 AND workspace_id = $2 AND active FOR UPDATE', [req.params.id, req.ws]);
    if (!t) throw notFound('User');
    if (t.level === 'owner' && !self && req.user.level !== 'owner') throw new HttpError(403, 'Only the Owner can change the Owner’s status.');
    await db.query('UPDATE users SET availability = $2 WHERE id = $1', [t.id, b.availability]);
    await audit(db, { workspaceId: req.ws, actor: req.user, action: 'user.availability_changed', targetType: 'user', targetId: t.id, targetLabel: t.name, before: { availability: t.availability }, after: { availability: b.availability } });
    let moved = null;
    if (['on_leave', 'offline'].includes(b.availability)) {
      moved = await reassignOnAbsence(db, { workspaceId: req.ws, userId: t.id, actor: req.user, newStatus: b.availability });
    }
    emit(db, req.ws, 'team', {});
    emit(db, req.ws, 'dashboard', {});
    return { availability: b.availability, moved };
  });
  res.json(out);
});

// ---------- Roles & permissions (F1.3) ----------
r.get('/permissions', (_req, res) => res.json(PERMISSIONS));

r.get('/roles', async (req, res) => {
  const { rows } = await query(
    `SELECT r.*, (SELECT count(*) FROM users u WHERE u.role_id = r.id AND u.level <> 'owner') AS user_count
       FROM roles r WHERE r.workspace_id = $1 ORDER BY r.created_at`, [req.ws]);
  res.json(rows);
});

const roleBody = z.object({ name: z.string().trim().min(1).max(60), permissions: z.array(z.enum(ALL_PERMISSIONS)).max(50) });

r.post('/roles', requirePerm('users.manage'), requireLevel('owner', 'admin'), async (req, res) => {
  const b = parse(roleBody, req.body);
  const role = await tx(async (db) => {
    const { rows: [x] } = await db.query('INSERT INTO roles (workspace_id, name, permissions) VALUES ($1,$2,$3) RETURNING *', [req.ws, b.name, b.permissions]);
    await audit(db, { workspaceId: req.ws, actor: req.user, action: 'role.created', targetType: 'role', targetId: x.id, targetLabel: x.name, after: { permissions: x.permissions } });
    return x;
  });
  res.status(201).json(role);
});

r.patch('/roles/:id', requirePerm('users.manage'), requireLevel('owner', 'admin'), async (req, res) => {
  const b = parse(roleBody.partial(), req.body);
  const role = await tx(async (db) => {
    const { rows: [old] } = await db.query('SELECT * FROM roles WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [req.params.id, req.ws]);
    if (!old) throw notFound('Role');
    if (req.user.level !== 'owner' && old.id === req.user.role_id) throw new HttpError(403, 'Admins cannot change the permissions of their own role. Ask the Owner.');
    const { rows: [x] } = await db.query('UPDATE roles SET name = COALESCE($2, name), permissions = COALESCE($3, permissions) WHERE id = $1 RETURNING *',
      [old.id, b.name ?? null, b.permissions ?? null]);
    const d = diff(old, x, ['name', 'permissions']);
    if (d) await audit(db, { workspaceId: req.ws, actor: req.user, action: 'role.permissions_changed', targetType: 'role', targetId: x.id, targetLabel: x.name, ...d });
    emit(db, req.ws, 'team', {});
    return x;
  });
  res.json(role);
});

r.delete('/roles/:id', requirePerm('users.manage'), requireLevel('owner', 'admin'), async (req, res) => {
  await tx(async (db) => {
    const { rows: [old] } = await db.query('SELECT * FROM roles WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [req.params.id, req.ws]);
    if (!old) throw notFound('Role');
    const used = await db.query("SELECT count(*) AS n FROM users WHERE role_id = $1 AND level <> 'owner'", [old.id]);
    if (used.rows[0].n > 0) throw new HttpError(409, `This role is used by ${used.rows[0].n} user(s). Move them to another role first.`);
    await db.query('DELETE FROM roles WHERE id = $1', [old.id]);
    await audit(db, { workspaceId: req.ws, actor: req.user, action: 'role.deleted', targetType: 'role', targetId: old.id, targetLabel: old.name, before: { permissions: old.permissions } });
  });
  res.json({ ok: true });
});

// ---------- Profile ----------
r.patch('/me', async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(1).max(80).optional(),
    timezone: z.string().max(64).refine(isValidTimeZone, 'Unknown time zone').nullable().optional(),
    dashboardPrefs: z.object({ hidden: z.array(z.string().max(40)).max(30) }).optional(),
  }), req.body);
  await query(
    `UPDATE users SET name = COALESCE($2, name), timezone = CASE WHEN $3::boolean THEN $4 ELSE timezone END,
            dashboard_prefs = COALESCE($5, dashboard_prefs) WHERE id = $1`,
    [req.user.id, b.name ?? null, b.timezone !== undefined, b.timezone ?? null, b.dashboardPrefs ? JSON.stringify(b.dashboardPrefs) : null]);
  res.json({ ok: true });
});

// Telegram linking (I4.3): user presses Start in the bot with a one-time code, then we look it up.
r.post('/me/telegram/start', async (req, res) => {
  const integ = await getIntegration({ query }, req.ws, 'telegram');
  if (!integ?.config) throw new HttpError(409, 'Telegram is not connected for this workspace yet. Ask an admin to connect it on the Integrations page.');
  const code = randomToken(9).replace(/[^A-Za-z0-9]/g, '').slice(0, 10);
  await query('UPDATE users SET telegram_link_code = $2 WHERE id = $1', [req.user.id, code]);
  res.json({ code, link: `https://t.me/${integ.config.botUsername}?start=${code}`, bot: integ.config.botUsername });
});

r.post('/me/telegram/check', async (req, res) => {
  const integ = await getIntegration({ query }, req.ws, 'telegram');
  if (!integ?.config) throw new HttpError(409, 'Telegram is not connected.');
  const u = await one('SELECT telegram_link_code FROM users WHERE id = $1', [req.user.id]);
  if (!u.telegram_link_code) throw new HttpError(400, 'Start linking first.');
  const r2 = await telegram.findStartCode(integ.config, u.telegram_link_code);
  if (!r2.ok) throw new HttpError(502, `Telegram error: ${r2.detail}`);
  if (!r2.chatId) throw new HttpError(404, 'We have not received your Start message yet. Open the bot link, press Start, then try again.');
  await query('UPDATE users SET telegram_chat_id = $2, telegram_link_code = NULL WHERE id = $1', [req.user.id, r2.chatId]);
  await telegram.sendMessage(integ.config, r2.chatId, `✅ Linked! You will receive LeadGuard escalation alerts here, ${req.user.name}.`);
  await audit({ query }, { workspaceId: req.ws, actor: req.user, action: 'user.telegram_linked', targetType: 'user', targetId: req.user.id, targetLabel: req.user.email });
  res.json({ ok: true });
});

r.put('/me/telegram', async (req, res) => {
  const b = parse(z.object({ chatId: z.string().trim().regex(/^-?\d{3,20}$/, 'Chat ID must be digits') }), req.body);
  await query('UPDATE users SET telegram_chat_id = $2 WHERE id = $1', [req.user.id, b.chatId]);
  await audit({ query }, { workspaceId: req.ws, actor: req.user, action: 'user.telegram_linked', targetType: 'user', targetId: req.user.id, targetLabel: req.user.email, after: { manual: true } });
  res.json({ ok: true });
});

r.delete('/me/telegram', async (req, res) => {
  await query('UPDATE users SET telegram_chat_id = NULL, telegram_link_code = NULL WHERE id = $1', [req.user.id]);
  res.json({ ok: true });
});

r.post('/me/telegram/test', async (req, res) => {
  const integ = await getIntegration({ query }, req.ws, 'telegram');
  const u = await one('SELECT telegram_chat_id FROM users WHERE id = $1', [req.user.id]);
  if (!integ?.config || !u.telegram_chat_id) throw new HttpError(409, 'Link Telegram first.');
  const s = await telegram.sendMessage(integ.config, u.telegram_chat_id, '🔔 Test alert from LeadGuard. Escalations will look like this.');
  if (!s.ok) throw new HttpError(502, `Telegram refused the message: ${s.detail}`);
  res.json({ ok: true });
});

// ---------- In-app notifications ----------
r.get('/notifications', async (req, res) => {
  const { rows } = await query('SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30', [req.user.id]);
  const unread = await one('SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  res.json({ items: rows, unread: unread.n });
});
r.post('/notifications/read-all', async (req, res) => {
  await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  res.json({ ok: true });
});

export default r;
