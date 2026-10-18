// Session loading, authentication, permission checks and CSRF defence. All enforced on the server.
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { sha256, randomToken } from '../lib/crypto.js';
import { HttpError } from '../lib/http.js';
import { can } from '../services/permissions.js';

export const COOKIE = 'lg_sid';

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export async function createSession(res, user, req) {
  const token = randomToken(32);
  await query(
    `INSERT INTO sessions (token_hash, user_id, workspace_id, expires_at, user_agent)
     VALUES ($1,$2,$3, now() + make_interval(days => $4), $5)`,
    [sha256(token), user.id, user.workspace_id, config.sessionMaxDays, (req.headers['user-agent'] || '').slice(0, 200)],
  );
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: config.isProd, path: '/', maxAge: config.sessionMaxDays * 86400_000,
  });
}

export async function destroySession(req, res) {
  const token = readCookie(req, COOKIE);
  if (token) await query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  res.clearCookie(COOKIE, { path: '/' });
}

// Attaches req.user (with permissions) when a valid session cookie is present.
export async function loadSession(req, _res, next) {
  try {
    const token = readCookie(req, COOKIE);
    if (!token) return next();
    const hash = sha256(token);
    const row = await one(
      `SELECT s.token_hash, s.last_seen_at, u.id, u.workspace_id, u.email, u.name, u.level, u.availability,
              u.timezone, u.active, u.role_id, r.name AS role_name, COALESCE(r.permissions, '{}') AS permissions,
              w.name AS workspace_name, w.timezone AS workspace_timezone
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         JOIN workspaces w ON w.id = u.workspace_id
         LEFT JOIN roles r ON r.id = u.role_id
        WHERE s.token_hash = $1 AND s.expires_at > now()
          AND s.last_seen_at > now() - make_interval(hours => $2)`,
      [hash, config.sessionIdleHours],
    );
    if (row && row.active) {
      req.user = row;
      req.ws = row.workspace_id;
      req.tz = row.timezone || row.workspace_timezone;
      if (Date.now() - new Date(row.last_seen_at).getTime() > 60_000) {
        query('UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1', [hash]).catch(() => {});
      }
    }
    next();
  } catch (e) { next(e); }
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please log in to continue.'));
  next();
}

export const requirePerm = (...perms) => (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'Please log in to continue.'));
  if (!perms.every((p) => can(req.user, p))) {
    return next(new HttpError(403, `You do not have permission to do this (requires: ${perms.join(', ')}).`));
  }
  next();
};

export const requireLevel = (...levels) => (req, _res, next) => {
  if (!req.user || !levels.includes(req.user.level)) return next(new HttpError(403, 'Only the workspace Owner or an Admin can do this.'));
  next();
};

// CSRF: state-changing API calls must carry a custom header (cannot be sent cross-site without CORS,
// which we never enable) and, when present, an Origin matching our own host. Cookies are SameSite=Lax.
export function csrfGuard(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') !== 'LeadGuard') {
    return next(new HttpError(403, 'Request blocked (missing CSRF header).'));
  }
  const origin = req.get('origin');
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { host = null; }
    if (host !== req.get('host')) return next(new HttpError(403, 'Request blocked (cross-site origin).'));
  }
  next();
}
