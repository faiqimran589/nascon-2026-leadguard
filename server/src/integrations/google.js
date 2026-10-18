// Google Calendar via OAuth 2.0 (I3). Docs:
//   https://developers.google.com/identity/protocols/oauth2/web-server
//   https://developers.google.com/calendar/api/v3/reference/events
import { config } from '../config.js';
import { providerFetch } from './http.js';

export const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'];
export const redirectUri = () => `${config.appUrl}/oauth/google/callback`;

export const LIMITS = [
  'While the Google Cloud app is in "Testing" status, only Google accounts listed as test users can connect, and refresh tokens expire after 7 days (reconnect when shown "Needs reconnection").',
  'Appointments are created on the employee’s primary Google Calendar.',
  'Busy times are read from the employee’s primary calendar only.',
];

export function authUrl(cfg, state) {
  const p = new URLSearchParams({
    client_id: cfg.clientId, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function tokenRequest(params) {
  return providerFetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params),
  });
}

export const exchangeCode = (cfg, code) => tokenRequest({
  code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: redirectUri(), grant_type: 'authorization_code',
});

export const refreshToken = (cfg, refresh) => tokenRequest({
  refresh_token: refresh, client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'refresh_token',
});

export const revoke = (token) => providerFetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
}, { retries: 0 });

export function emailFromIdToken(idToken) {
  try { return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString()).email || null; } catch { return null; }
}

const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const bearer = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

export const listEvents = (token, timeMin, timeMax) => providerFetch(
  `${CAL}?${new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '100' })}`,
  { headers: bearer(token) });

export const createEvent = (token, event) => providerFetch(`${CAL}?sendUpdates=none`, { method: 'POST', headers: bearer(token), body: JSON.stringify(event) }, { retries: 1 });
export const patchEvent = (token, id, event) => providerFetch(`${CAL}/${encodeURIComponent(id)}?sendUpdates=none`, { method: 'PATCH', headers: bearer(token), body: JSON.stringify(event) });
export const deleteEvent = (token, id) => providerFetch(`${CAL}/${encodeURIComponent(id)}?sendUpdates=none`, { method: 'DELETE', headers: bearer(token) });
