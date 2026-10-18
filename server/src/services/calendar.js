// Google Calendar connection handling (I3): server-side tokens, automatic refresh,
// detection of revoked/expired connections, busy-time lookup.
import { query } from '../db/pool.js';
import { HttpError } from '../lib/http.js';
import { encryptJson, decryptJson } from '../lib/crypto.js';
import { getIntegration, logEvent } from '../integrations/store.js';
import * as google from '../integrations/google.js';
import { emit } from './events.js';

const db0 = { query };

export async function googleConfig(workspaceId) {
  const integ = await getIntegration(db0, workspaceId, 'google');
  if (!integ?.config) throw new HttpError(409, integ?.error || 'Google Calendar is not set up for this workspace. An admin can add the Google OAuth client on the Integrations page.');
  return integ.config;
}

async function markNeedsReconnect(workspaceId, userId, reason) {
  await query("UPDATE calendar_connections SET status = 'needs_reconnect', last_error = $2 WHERE user_id = $1", [userId, reason]);
  await logEvent(db0, { workspaceId, provider: 'google', direction: 'outbound', kind: 'token.refresh', result: 'error', reference: userId, detail: reason });
  emit(db0, workspaceId, 'team', {});
}

// Returns a valid access token for the employee, refreshing it when needed.
export async function accessTokenFor(workspaceId, userId) {
  const cfg = await googleConfig(workspaceId);
  const { rows: [conn] } = await query(
    `SELECT cc.*, u.name FROM users u LEFT JOIN calendar_connections cc ON cc.user_id = u.id
      WHERE u.id = $1 AND u.workspace_id = $2`, [userId, workspaceId]);
  if (!conn) throw new HttpError(404, 'Employee not found');
  if (!conn.tokens_enc) throw new HttpError(409, `${conn.name} has not connected Google Calendar, so appointments cannot be booked for them. They can connect it from their Profile page.`, { code: 'calendar_not_connected' });
  if (conn.status === 'needs_reconnect') throw new HttpError(409, `${conn.name}'s Google Calendar connection expired or was revoked. They need to reconnect it from their Profile page.`, { code: 'calendar_needs_reconnect' });
  let tokens;
  try { tokens = decryptJson(conn.tokens_enc); } catch { await markNeedsReconnect(workspaceId, userId, 'Stored tokens unreadable'); throw new HttpError(409, 'Calendar connection must be reconnected.'); }
  if (conn.expires_at && new Date(conn.expires_at).getTime() > Date.now() + 60_000) return tokens.access_token;
  if (!tokens.refresh_token) { await markNeedsReconnect(workspaceId, userId, 'No refresh token'); throw new HttpError(409, `${conn.name}'s calendar connection must be reconnected.`); }
  const r = await google.refreshToken(cfg, tokens.refresh_token);
  if (!r.ok) {
    if (r.json?.error === 'invalid_grant' || r.status === 400 || r.status === 401) {
      await markNeedsReconnect(workspaceId, userId, `Google refused the refresh token (${r.json?.error_description || r.json?.error || r.status})`);
      throw new HttpError(409, `${conn.name}'s Google Calendar connection expired or was revoked. Reconnect it from the Profile page.`, { code: 'calendar_needs_reconnect' });
    }
    await logEvent(db0, { workspaceId, provider: 'google', direction: 'outbound', kind: 'token.refresh', result: 'error', reference: userId, httpStatus: r.status, detail: r.networkError || `HTTP ${r.status}` });
    throw new HttpError(502, 'Google is temporarily unavailable. Please try again in a minute.');
  }
  tokens.access_token = r.json.access_token;
  if (r.json.refresh_token) tokens.refresh_token = r.json.refresh_token;
  await query("UPDATE calendar_connections SET tokens_enc = $2, expires_at = now() + make_interval(secs => $3), status = 'connected', last_error = NULL WHERE user_id = $1",
    [userId, encryptJson(tokens), Number(r.json.expires_in || 3600)]);
  await logEvent(db0, { workspaceId, provider: 'google', direction: 'outbound', kind: 'token.refresh', result: 'ok', reference: userId });
  return tokens.access_token;
}

// Wraps a Google API call: on 401 the token is force-refreshed once; errors are explained.
export async function googleCall(workspaceId, userId, kind, fn) {
  let token = await accessTokenFor(workspaceId, userId);
  let r = await fn(token);
  if (r.status === 401) {
    await query("UPDATE calendar_connections SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [userId]);
    token = await accessTokenFor(workspaceId, userId);
    r = await fn(token);
  }
  const ok = r.ok || r.status === 204 || r.status === 410 || (kind === 'calendar.event.delete' && r.status === 404);
  await logEvent(db0, { workspaceId, provider: 'google', direction: 'outbound', kind, result: ok ? 'ok' : 'error', reference: r.json?.id || userId, httpStatus: r.status, detail: ok ? null : (r.networkError || r.json?.error?.message || `HTTP ${r.status}`) });
  if (!ok) {
    if (r.status === 401 || r.status === 403) {
      await markNeedsReconnect(workspaceId, userId, r.json?.error?.message || 'Access denied');
      throw new HttpError(409, 'Google denied access to the calendar. The employee must reconnect Google Calendar.', { code: 'calendar_needs_reconnect' });
    }
    throw new HttpError(502, `Google Calendar error: ${r.networkError || r.json?.error?.message || `HTTP ${r.status}`}`);
  }
  return r.json;
}

// Busy intervals for an employee between two instants: Google events (opaque, not cancelled)
// plus appointments booked in this platform.
export async function busyIntervals(workspaceId, userId, from, to, { excludeAppointmentId } = {}) {
  const data = await googleCall(workspaceId, userId, 'calendar.busy', (t) => google.listEvents(t, from.toISOString(), to.toISOString()));
  const { rows: appts } = await query(
    `SELECT id, google_event_id FROM appointments WHERE id = $1`, [excludeAppointmentId || '00000000-0000-0000-0000-000000000000']);
  const excludeEvent = appts[0]?.google_event_id;
  const busy = [];
  for (const e of data?.items || []) {
    if (e.status === 'cancelled' || e.transparency === 'transparent' || e.id === excludeEvent) continue;
    const s = e.start?.dateTime || (e.start?.date ? `${e.start.date}T00:00:00Z` : null);
    const en = e.end?.dateTime || (e.end?.date ? `${e.end.date}T00:00:00Z` : null);
    if (s && en) busy.push({ start: new Date(s).toISOString(), end: new Date(en).toISOString(), title: e.summary || 'Busy', source: 'google' });
  }
  const { rows: local } = await query(
    `SELECT start_at, end_at, title FROM appointments WHERE workspace_id = $1 AND user_id = $2 AND status = 'scheduled'
        AND start_at < $4 AND end_at > $3 AND ($5::uuid IS NULL OR id <> $5) AND google_event_id IS NULL`,
    [workspaceId, userId, from, to, excludeAppointmentId || null]);
  for (const a of local) busy.push({ start: a.start_at.toISOString(), end: a.end_at.toISOString(), title: a.title, source: 'platform' });
  return busy.sort((a, b) => a.start.localeCompare(b.start));
}
