// Per-workspace integration credentials (I5.2/I5.3) and the synchronization history (I5.4).
import { encryptJson, decryptJson } from '../lib/crypto.js';
import { emit } from '../services/events.js';

export const PROVIDERS = ['twilio', 'stripe', 'google', 'telegram'];

export async function getIntegration(db, workspaceId, provider) {
  const { rows: [row] } = await db.query(
    'SELECT * FROM integrations WHERE workspace_id = $1 AND provider = $2', [workspaceId, provider]);
  if (!row) return null;
  let cfg;
  try { cfg = decryptJson(row.config_enc); } catch {
    return { row, config: null, error: 'Stored credentials cannot be decrypted (ENCRYPTION_KEY changed?). Reconnect this integration.' };
  }
  return { row, config: cfg };
}

export async function saveIntegration(db, workspaceId, provider, cfg, publicConfig, actorId) {
  await db.query(
    `INSERT INTO integrations (workspace_id, provider, config_enc, public_config, connected_by, last_success_at, last_error, last_error_at)
     VALUES ($1,$2,$3,$4,$5, now(), NULL, NULL)
     ON CONFLICT (workspace_id, provider) DO UPDATE SET config_enc = EXCLUDED.config_enc,
       public_config = EXCLUDED.public_config, connected_by = EXCLUDED.connected_by, updated_at = now(),
       last_success_at = now(), last_error = NULL, last_error_at = NULL`,
    [workspaceId, provider, encryptJson(cfg), JSON.stringify(publicConfig || {}), actorId]);
}

// Record an inbound event or outbound call. Also maintains the integration's health status.
export async function logEvent(db, { workspaceId, provider, direction, kind, result, reference, httpStatus, detail }) {
  await db.query(
    `INSERT INTO integration_events (workspace_id, provider, direction, kind, result, reference, http_status, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [workspaceId, provider, direction, kind, result, reference || null, httpStatus || null, detail ? String(detail).slice(0, 1000) : null]);
  if (result === 'ok' || result === 'duplicate') {
    await db.query('UPDATE integrations SET last_success_at = now() WHERE workspace_id = $1 AND provider = $2', [workspaceId, provider]);
  } else if (result === 'error' || result === 'retrying') {
    await db.query('UPDATE integrations SET last_error_at = now(), last_error = $3 WHERE workspace_id = $1 AND provider = $2',
      [workspaceId, provider, detail ? String(detail).slice(0, 500) : kind]);
  }
  emit(db, workspaceId, 'integrations', { provider });
}

// Integration status shown on the integrations page.
export function statusOf(row) {
  if (!row) return 'not_connected';
  if (row.last_error_at && (!row.last_success_at || new Date(row.last_error_at) > new Date(row.last_success_at))) return 'error';
  return 'connected';
}
