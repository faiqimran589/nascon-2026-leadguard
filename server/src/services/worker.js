// Background worker (runs inside the web process). Every WORKER_INTERVAL_MS it:
//   1. escalates leads whose acknowledgement deadline has passed (F3.5)
//   2. delivers queued Telegram escalation alerts with limited retries (I4.1, I4.4)
//   3. retries messages that failed temporarily (I1.7, I5.5)
//   4. cleans up expired sessions / OAuth states
// All state lives in PostgreSQL, so a restart simply resumes where it stopped (Q5).
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { processDueEscalations } from './leads.js';
import { processMessageRetries } from './messaging.js';
import { getIntegration, logEvent } from '../integrations/store.js';
import * as telegram from '../integrations/telegram.js';
import { emit } from './events.js';

const db0 = { query };
const MAX_ALERT_ATTEMPTS = 3;

async function processAlerts() {
  // Claim with a lease so a crash mid-send leads to a retry, never a silent loss.
  const { rows } = await query(
    `UPDATE alert_outbox SET next_attempt_at = now() + interval '60 seconds', attempts = attempts + 1
      WHERE id IN (SELECT id FROM alert_outbox WHERE status = 'pending' AND next_attempt_at <= now()
                   ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED)
      RETURNING *`);
  for (const a of rows) {
    const integ = await getIntegration(db0, a.workspace_id, 'telegram');
    const { rows: [u] } = await query('SELECT telegram_chat_id, name FROM users WHERE id = $1', [a.user_id]);
    let result;
    if (!integ?.config) result = { ok: false, permanent: true, detail: integ?.error || 'Telegram not connected' };
    else if (!u?.telegram_chat_id) result = { ok: false, permanent: true, detail: `${u?.name || 'User'} has no linked Telegram chat` };
    else {
      const r = await telegram.sendMessage(integ.config, u.telegram_chat_id, a.text);
      result = { ok: r.ok, permanent: !r.transient, detail: r.detail, status: r.status, ref: r.messageId };
    }
    if (result.ok) {
      await query("UPDATE alert_outbox SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1", [a.id]);
    } else if (result.permanent || a.attempts >= MAX_ALERT_ATTEMPTS) {
      await query("UPDATE alert_outbox SET status = 'failed', last_error = $2 WHERE id = $1", [a.id, `${result.detail} (after ${a.attempts} attempt${a.attempts > 1 ? 's' : ''})`]);
    } else {
      await query("UPDATE alert_outbox SET last_error = $2, next_attempt_at = now() + make_interval(secs => $3) WHERE id = $1",
        [a.id, result.detail, 5 * 3 ** (a.attempts - 1)]);
    }
    await logEvent(db0, {
      workspaceId: a.workspace_id, provider: 'telegram', direction: 'outbound', kind: 'alert.escalation',
      result: result.ok ? 'ok' : (result.permanent || a.attempts >= MAX_ALERT_ATTEMPTS ? 'error' : 'retrying'),
      reference: `alert#${a.id}`, httpStatus: result.status, detail: result.ok ? `Delivered to ${u?.name}` : result.detail,
    });
    emit(db0, a.workspace_id, 'alerts', {});
  }
}

async function cleanup() {
  await query('DELETE FROM sessions WHERE expires_at < now()');
  await query('DELETE FROM oauth_states WHERE expires_at < now()');
}

let running = false;
let ticks = 0;
async function tick() {
  if (running) return;
  running = true;
  try {
    await processDueEscalations();
    await processAlerts();
    await processMessageRetries();
    if (++ticks % 300 === 0) await cleanup();
  } catch (e) {
    console.error('[worker]', e.message);
  } finally {
    running = false;
  }
}

export function startWorker() {
  if (!config.runWorker) return;
  console.log(`[worker] running every ${config.workerIntervalMs} ms`);
  setInterval(tick, config.workerIntervalMs).unref();
  tick();
}

export { tick as workerTick };
