// Sign-up, login, logout, invites, password change (F1.1, Q1).
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { one, query, tx } from '../db/pool.js';
import { Router, parse, HttpError } from '../lib/http.js';
import { hashPassword, verifyPassword, sha256 } from '../lib/crypto.js';
import { isValidTimeZone } from '../lib/time.js';
import { createSession, destroySession, requireAuth } from '../middleware/auth.js';
import { createWorkspace } from '../services/bootstrap.js';
import { effectivePermissions } from '../services/permissions.js';
import { audit } from '../services/audit.js';
import { kickUser } from '../services/events.js';

const r = Router();
const MAX_FAILED = 5;
const LOCK_MINUTES = 5;

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many login attempts from this network. Try again in 15 minutes.' } });
const signupLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many sign-ups from this network. Try again later.' } });

const password = z.string().min(8, 'Password must be at least 8 characters').max(200);
const tz = z.string().max(64).refine(isValidTimeZone, 'Unknown time zone').optional();

r.post('/signup', signupLimiter, async (req, res) => {
  const b = parse(z.object({
    workspaceName: z.string().trim().min(2).max(80), name: z.string().trim().min(1).max(80),
    email: z.string().trim().email().max(200), password, timezone: tz,
  }), req.body);
  const exists = await one('SELECT 1 FROM users WHERE lower(email) = lower($1)', [b.email]);
  if (exists) throw new HttpError(409, 'An account with this email already exists. Log in instead.');
  const passwordHash = await hashPassword(b.password);
  const { owner } = await tx((db) => createWorkspace(db, {
    workspaceName: b.workspaceName, ownerName: b.name, email: b.email, passwordHash, timezone: b.timezone,
  }));
  await createSession(res, owner, req);
  res.status(201).json({ ok: true });
});

r.post('/login', loginLimiter, async (req, res) => {
  const b = parse(z.object({ email: z.string().trim().email().max(200), password: z.string().min(1).max(200) }), req.body);
  const u = await one('SELECT * FROM users WHERE lower(email) = lower($1)', [b.email]);
  const generic = new HttpError(401, 'Email or password is incorrect.');
  if (!u || !u.password_hash) { await verifyPassword(b.password, 'scrypt$16384$8$1$AAAA$AAAA').catch(() => {}); throw generic; }
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    throw new HttpError(429, `Too many failed attempts. This account is locked until ${new Date(u.locked_until).toLocaleTimeString('en-GB')} (UTC server time). Try again in a few minutes.`);
  }
  if (!u.active) throw new HttpError(403, 'This account has been deactivated. Contact your workspace admin.');
  const ok = await verifyPassword(b.password, u.password_hash);
  if (!ok) {
    const fails = u.failed_logins + 1;
    await query(
      `UPDATE users SET failed_logins = $2, locked_until = CASE WHEN $2 >= $3 THEN now() + make_interval(mins => $4) ELSE locked_until END WHERE id = $1`,
      [u.id, fails >= MAX_FAILED ? 0 : fails, MAX_FAILED, LOCK_MINUTES]);
    if (fails >= MAX_FAILED) {
      await audit({ query }, { workspaceId: u.workspace_id, actor: null, action: 'auth.locked', targetType: 'user', targetId: u.id, targetLabel: u.email, after: { minutes: LOCK_MINUTES } });
    }
    throw generic;
  }
  await query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [u.id]);
  await createSession(res, u, req);
  res.json({ ok: true });
});

r.post('/logout', async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
});

r.post('/logout-all', requireAuth, async (req, res) => {
  await query('DELETE FROM sessions WHERE user_id = $1', [req.user.id]);
  await destroySession(req, res);
  kickUser(req.ws, req.user.id);
  res.json({ ok: true });
});

r.get('/me', async (req, res) => {
  if (!req.user) return res.json({ user: null });
  const u = req.user;
  const extra = await one('SELECT dashboard_prefs, telegram_chat_id IS NOT NULL AS telegram_linked FROM users WHERE id = $1', [u.id]);
  const cal = await one('SELECT status, google_email FROM calendar_connections WHERE user_id = $1', [u.id]);
  const ws = await one('SELECT id, name, timezone, default_currency, webhook_token FROM workspaces WHERE id = $1', [u.workspace_id]);
  res.json({
    user: {
      id: u.id, name: u.name, email: u.email, level: u.level, availability: u.availability,
      timezone: u.timezone, effectiveTimezone: req.tz, roleId: u.role_id, roleName: u.level === 'owner' ? 'Owner (all permissions)' : u.role_name,
      permissions: effectivePermissions(u), dashboardPrefs: extra.dashboard_prefs, telegramLinked: extra.telegram_linked,
      calendar: cal ? { status: cal.status, email: cal.google_email } : null,
    },
    workspace: { id: ws.id, name: ws.name, timezone: ws.timezone, defaultCurrency: ws.default_currency, formToken: ws.webhook_token },
  });
});

r.post('/change-password', requireAuth, async (req, res) => {
  const b = parse(z.object({ current: z.string().min(1), next: password }), req.body);
  const u = await one('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await verifyPassword(b.current, u.password_hash))) throw new HttpError(400, 'Current password is incorrect.');
  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, await hashPassword(b.next)]);
  await query('DELETE FROM sessions WHERE user_id = $1', [req.user.id]); // end all other sessions
  await createSession(res, req.user, req);
  await audit({ query }, { workspaceId: req.ws, actor: req.user, action: 'auth.password_changed', targetType: 'user', targetId: req.user.id, targetLabel: req.user.email });
  res.json({ ok: true });
});

r.get('/invite/:token', async (req, res) => {
  const u = await one(
    `SELECT u.email, u.name, w.name AS workspace FROM users u JOIN workspaces w ON w.id = u.workspace_id
      WHERE u.invite_token_hash = $1 AND u.invite_expires_at > now() AND u.password_hash IS NULL`, [sha256(req.params.token)]);
  if (!u) throw new HttpError(404, 'This invitation link is invalid or has expired. Ask your admin for a new one.');
  res.json(u);
});

r.post('/accept-invite', async (req, res) => {
  const b = parse(z.object({ token: z.string().min(10).max(200), name: z.string().trim().min(1).max(80), password, timezone: tz }), req.body);
  const u = await one(
    `UPDATE users SET password_hash = $2, name = $3, timezone = COALESCE($4, timezone), invite_token_hash = NULL, invite_expires_at = NULL
      WHERE invite_token_hash = $1 AND invite_expires_at > now() AND password_hash IS NULL RETURNING *`,
    [sha256(b.token), await hashPassword(b.password), b.name, b.timezone || null]);
  if (!u) throw new HttpError(404, 'This invitation link is invalid or has expired.');
  await audit({ query }, { workspaceId: u.workspace_id, actor: u, action: 'user.joined', targetType: 'user', targetId: u.id, targetLabel: u.email });
  await createSession(res, u, req);
  res.json({ ok: true });
});

export default r;
