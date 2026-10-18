// In-app notifications (bell + live toast) and the outbound alert queue (Telegram, I4).
import { config } from '../config.js';
import { publish } from './events.js';
import { onCommit } from '../db/pool.js';

export async function notifyUser(db, { workspaceId, userId, title, body, link }) {
  if (!userId) return;
  await db.query(
    'INSERT INTO notifications (workspace_id, user_id, title, body, link) VALUES ($1,$2,$3,$4,$5)',
    [workspaceId, userId, title, body || null, link || null],
  );
  onCommit(db, () => publish(workspaceId, 'notification', { title, body, link }, { userIds: [userId] }));
}

const SOURCE_LABEL = { web_form: 'Web form', whatsapp: 'WhatsApp', sms: 'SMS', manual: 'Manual entry' };
export const sourceLabel = (s) => SOURCE_LABEL[s] || s;

// Queue an external escalation alert (F3.9 / I4). The worker delivers it with retries.
export async function enqueueEscalationAlert(db, { workspaceId, userId, lead, reason }) {
  const { rows: [u] } = await db.query('SELECT telegram_chat_id, name FROM users WHERE id = $1', [userId]);
  const { rows: [integ] } = await db.query(
    "SELECT 1 FROM integrations WHERE workspace_id = $1 AND provider = 'telegram'", [workspaceId]);
  const text = [
    '⚠️ Lead escalated to you',
    `Lead: ${lead.title}`,
    `Source: ${sourceLabel(lead.source)}`,
    `Reason: ${reason}`,
    `Open: ${config.appUrl}/leads/${lead.id}`,
  ].join('\n');
  let status = 'pending';
  let lastError = null;
  if (!integ) { status = 'skipped'; lastError = 'Telegram integration is not connected for this workspace'; }
  else if (!u?.telegram_chat_id) { status = 'skipped'; lastError = `${u?.name || 'User'} has not linked a Telegram chat (Profile → Telegram)`; }
  await db.query(
    'INSERT INTO alert_outbox (workspace_id, user_id, lead_id, text, status, last_error) VALUES ($1,$2,$3,$4,$5,$6)',
    [workspaceId, userId, lead.id, text, status, lastError],
  );
}
