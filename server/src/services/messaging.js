// Messaging (I1): conversations, outbound sending with retries, inbound capture, delivery status.
import { config } from '../config.js';
import { query, tx } from '../db/pool.js';
import { HttpError } from '../lib/http.js';
import { normalizePhone } from '../lib/phone.js';
import { getIntegration, logEvent } from '../integrations/store.js';
import * as twilio from '../integrations/twilio.js';
import { addActivity } from './activity.js';
import { emit } from './events.js';
import { createLead, findOrCreateContact, recordLeadAction } from './leads.js';
import { notifyUser } from './notify.js';

const MAX_ATTEMPTS = 3;
const STATUS_RANK = { received: 0, queued: 1, accepted: 1, scheduled: 1, sending: 2, sent: 3, delivered: 4, read: 5, failed: 6, undelivered: 6, canceled: 6 };

export async function ensureConversation(db, workspaceId, contactId, channel) {
  const { rows: [c] } = await db.query(
    `INSERT INTO conversations (workspace_id, contact_id, channel) VALUES ($1,$2,$3)
     ON CONFLICT (workspace_id, contact_id, channel) DO UPDATE SET channel = EXCLUDED.channel
     RETURNING *`, [workspaceId, contactId, channel]);
  return c;
}

export const statusCallbackUrl = (token) => `${config.appUrl}/webhooks/twilio/${token}/status`;

// Employee sends a message. The row is stored first (so nothing is ever silently lost), then delivered.
export async function sendMessage({ workspaceId, contactId, body, user }) {
  const integ = await getIntegration({ query }, workspaceId, 'twilio');
  if (!integ?.config) throw new HttpError(409, 'Messaging is not connected. An admin can connect Twilio on the Integrations page.');
  const channel = integ.config.channel || 'whatsapp';
  const msg = await tx(async (db) => {
    const { rows: [contact] } = await db.query(
      'SELECT * FROM contacts WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL', [contactId, workspaceId]);
    if (!contact) throw new HttpError(404, 'Contact not found');
    if (contact.opted_out) throw new HttpError(409, 'This contact has opted out of messages (replied STOP or was marked opted-out). They cannot be messaged until they opt back in.');
    if (!contact.phone) throw new HttpError(409, 'This contact has no phone number.');
    const conv = await ensureConversation(db, workspaceId, contactId, channel);
    const { rows: [m] } = await db.query(
      `INSERT INTO messages (workspace_id, conversation_id, direction, body, status, sent_by, next_attempt_at)
       VALUES ($1,$2,'outbound',$3,'queued',$4, now() + interval '30 seconds') RETURNING *`,
      [workspaceId, conv.id, body, user.id]);
    await db.query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [conv.id]);
    await addActivity(db, { workspaceId, contactId, opportunityId: conv.opportunity_id, type: 'message', actorId: user.id, body: `Sent ${channel} message: “${body.slice(0, 160)}”`, data: { message_id: m.id } });
    await recordLeadAction(db, { workspaceId, user, contactId, via: 'replied to the customer' });
    emit(db, workspaceId, 'messages', { conversationId: conv.id });
    return m;
  });
  return deliver(msg.id);
}

// Attempts delivery of one queued message via Twilio. Safe to call repeatedly.
export async function deliver(messageId) {
  const claim = await tx(async (db) => {
    const { rows: [m] } = await db.query(
      `SELECT m.*, c.contact_id, w.webhook_token, ct.phone, ct.opted_out
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
         JOIN workspaces w ON w.id = m.workspace_id JOIN contacts ct ON ct.id = c.contact_id
        WHERE m.id = $1 AND m.direction = 'outbound' AND m.status = 'queued' FOR UPDATE OF m SKIP LOCKED`, [messageId]);
    if (!m) return null;
    // lease: if this process dies mid-call, the worker retries after the lease expires
    await db.query("UPDATE messages SET status = 'sending', attempts = attempts + 1, next_attempt_at = now() + interval '60 seconds', updated_at = now() WHERE id = $1", [m.id]);
    return m;
  });
  if (!claim) return (await query('SELECT * FROM messages WHERE id = $1', [messageId])).rows[0];

  const integ = await getIntegration({ query }, claim.workspace_id, 'twilio');
  let update;
  if (claim.opted_out) {
    update = { status: 'failed', error_code: 'opted_out', error_message: 'Contact opted out before the message was sent.' };
  } else if (!integ?.config) {
    update = { status: 'failed', error_code: 'not_connected', error_message: integ?.error || 'Messaging integration is not connected.' };
  } else {
    const r = await twilio.send(integ.config, { to: claim.phone, body: claim.body, statusCallback: statusCallbackUrl(claim.webhook_token) });
    if (r.ok) {
      update = { status: r.json.status || 'queued', provider_sid: r.json.sid, error_code: null, error_message: null, next_attempt_at: null };
      await logEvent({ query }, { workspaceId: claim.workspace_id, provider: 'twilio', direction: 'outbound', kind: 'message.send', result: 'ok', reference: r.json.sid, httpStatus: r.status });
    } else if (r.transient && claim.attempts + 1 < MAX_ATTEMPTS) {
      const delay = 10 * 3 ** claim.attempts; // 10s, 30s
      update = { status: 'queued', error_code: String(r.status || 'network'), error_message: `Temporary problem reaching Twilio (${r.networkError || `HTTP ${r.status}`}). Retrying automatically in ${delay}s (attempt ${claim.attempts + 1} of ${MAX_ATTEMPTS}).`, next_attempt_at: new Date(Date.now() + delay * 1000) };
      await logEvent({ query }, { workspaceId: claim.workspace_id, provider: 'twilio', direction: 'outbound', kind: 'message.send', result: 'retrying', reference: claim.id, httpStatus: r.status, detail: update.error_message });
    } else {
      const explained = r.networkError ? `${r.networkError}. Gave up after ${MAX_ATTEMPTS} attempts — use Retry.` : twilio.explain(r.json?.code, r.json?.message) || `HTTP ${r.status}`;
      update = { status: 'failed', error_code: String(r.json?.code || r.status || 'network'), error_message: explained, next_attempt_at: null };
      await logEvent({ query }, { workspaceId: claim.workspace_id, provider: 'twilio', direction: 'outbound', kind: 'message.send', result: 'error', reference: claim.id, httpStatus: r.status, detail: explained });
    }
  }
  const { rows: [m] } = await query(
    `UPDATE messages SET status = $2, provider_sid = COALESCE($3, provider_sid), error_code = $4, error_message = $5,
            next_attempt_at = $6, updated_at = now() WHERE id = $1 RETURNING *`,
    [messageId, update.status, update.provider_sid || null, update.error_code ?? null, update.error_message ?? null, update.next_attempt_at ?? null]);
  emit({ query }, claim.workspace_id, 'messages', { conversationId: claim.conversation_id });
  return m;
}

export async function retryMessage({ workspaceId, messageId }) {
  const { rows: [m] } = await query(
    `UPDATE messages SET status = 'queued', attempts = 0, error_code = NULL, error_message = NULL, next_attempt_at = now() + interval '30 seconds', updated_at = now()
      WHERE id = $1 AND workspace_id = $2 AND direction = 'outbound' AND status IN ('failed','undelivered') RETURNING id`,
    [messageId, workspaceId]);
  if (!m) throw new HttpError(409, 'Only failed messages can be retried.');
  return deliver(m.id);
}

// Worker: deliver queued messages whose retry time has come (or whose lease expired).
export async function processMessageRetries() {
  await query("UPDATE messages SET status = 'queued' WHERE status = 'sending' AND next_attempt_at <= now()");
  const { rows } = await query("SELECT id FROM messages WHERE status = 'queued' AND direction = 'outbound' AND next_attempt_at <= now() LIMIT 20");
  for (const r of rows) await deliver(r.id).catch((e) => console.error('[messages] retry', e.message));
}

const STOP_WORDS = ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit'];
const START_WORDS = ['start', 'unstop', 'yes'];

// Inbound webhook (already signature-verified). Idempotent on MessageSid.
export async function handleInbound(workspace, params) {
  const channel = String(params.From || '').startsWith('whatsapp:') ? 'whatsapp' : 'sms';
  const phone = normalizePhone(params.From);
  const body = String(params.Body || '').slice(0, 4000) || (Number(params.NumMedia) > 0 ? '[media message — not displayed]' : '');
  const sid = params.MessageSid || params.SmsSid;
  if (!phone || !sid) return { result: 'rejected', detail: 'Missing From or MessageSid' };

  return tx(async (db) => {
    const ws = workspace.id;
    const dup = await db.query(
      `INSERT INTO processed_webhooks (workspace_id, provider, event_id) VALUES ($1,'twilio',$2) ON CONFLICT DO NOTHING RETURNING event_id`,
      [ws, `in:${sid}`]);
    if (!dup.rows.length) {
      await logEvent(db, { workspaceId: ws, provider: 'twilio', direction: 'inbound', kind: 'message.received', result: 'duplicate', reference: sid, detail: 'Duplicate delivery ignored' });
      return { result: 'duplicate' };
    }
    const { contact, created } = await findOrCreateContact(db, ws, { firstName: params.ProfileName || phone, phone, source: channel });
    const conv = await ensureConversation(db, ws, contact.id, channel);
    await db.query(
      `INSERT INTO messages (workspace_id, conversation_id, direction, body, status, provider_sid) VALUES ($1,$2,'inbound',$3,'received',$4)`,
      [ws, conv.id, body, sid]);
    await db.query('UPDATE conversations SET last_message_at = now(), unread_count = unread_count + 1 WHERE id = $1', [conv.id]);
    await addActivity(db, { workspaceId: ws, contactId: contact.id, opportunityId: conv.opportunity_id, type: 'message', body: `Received ${channel} message: “${body.slice(0, 160)}”` });

    const word = body.trim().toLowerCase();
    if (STOP_WORDS.includes(word) && !contact.opted_out) {
      await db.query('UPDATE contacts SET opted_out = true, opted_out_at = now() WHERE id = $1', [contact.id]);
      await addActivity(db, { workspaceId: ws, contactId: contact.id, type: 'opt_out', body: 'Contact opted out of messages (replied STOP)' });
    } else if (START_WORDS.includes(word) && contact.opted_out) {
      await db.query('UPDATE contacts SET opted_out = false, opted_out_at = NULL WHERE id = $1', [contact.id]);
      await addActivity(db, { workspaceId: ws, contactId: contact.id, type: 'opt_in', body: 'Contact opted back in (replied START)' });
    }

    let lead = null;
    if (created) {
      lead = await createLead(db, { workspaceId: ws, source: channel, contactId: contact.id, title: `${contact.first_name} via ${channel === 'whatsapp' ? 'WhatsApp' : 'SMS'}`, message: body, actor: null });
    } else {
      await db.query('UPDATE leads SET last_action_at = now() WHERE contact_id = $1 AND status IN (\'assigned\',\'acknowledged\')', [contact.id]);
      if (contact.owner_id) {
        await notifyUser(db, { workspaceId: ws, userId: contact.owner_id, title: `New message from ${contact.first_name}`, body: body.slice(0, 120), link: `/inbox/${conv.id}` });
      }
    }
    await logEvent(db, { workspaceId: ws, provider: 'twilio', direction: 'inbound', kind: 'message.received', result: 'ok', reference: sid, detail: created ? `New contact + lead from ${phone}` : `Attached to existing contact ${contact.first_name}` });
    emit(db, ws, 'messages', { conversationId: conv.id });
    return { result: 'ok', leadId: lead?.id, contactId: contact.id };
  });
}

// Delivery status callback (already signature-verified). Status never moves backwards.
export async function handleStatus(workspace, params) {
  const sid = params.MessageSid || params.SmsSid;
  const status = String(params.MessageStatus || params.SmsStatus || '').toLowerCase();
  if (!sid || !status) return { result: 'rejected', detail: 'Missing MessageSid or MessageStatus' };
  return tx(async (db) => {
    const ws = workspace.id;
    const dup = await db.query(
      `INSERT INTO processed_webhooks (workspace_id, provider, event_id) VALUES ($1,'twilio',$2) ON CONFLICT DO NOTHING RETURNING event_id`,
      [ws, `st:${sid}:${status}`]);
    if (!dup.rows.length) {
      await logEvent(db, { workspaceId: ws, provider: 'twilio', direction: 'inbound', kind: 'message.status', result: 'duplicate', reference: sid, detail: status });
      return { result: 'duplicate' };
    }
    const { rows: [m] } = await db.query('SELECT * FROM messages WHERE workspace_id = $1 AND provider_sid = $2 FOR UPDATE', [ws, sid]);
    if (!m) {
      await logEvent(db, { workspaceId: ws, provider: 'twilio', direction: 'inbound', kind: 'message.status', result: 'error', reference: sid, detail: `Status "${status}" for unknown message` });
      return { result: 'unknown' };
    }
    if ((STATUS_RANK[status] ?? 0) >= (STATUS_RANK[m.status] ?? 0)) {
      const errText = params.ErrorCode ? twilio.explain(params.ErrorCode, params.ErrorMessage) : null;
      await db.query('UPDATE messages SET status = $2, error_code = COALESCE($3, error_code), error_message = COALESCE($4, error_message), updated_at = now() WHERE id = $1',
        [m.id, status, params.ErrorCode || null, errText]);
    }
    await logEvent(db, { workspaceId: ws, provider: 'twilio', direction: 'inbound', kind: 'message.status', result: 'ok', reference: sid, detail: status + (params.ErrorCode ? ` (error ${params.ErrorCode})` : '') });
    emit(db, ws, 'messages', { conversationId: m.conversation_id });
    return { result: 'ok' };
  });
}
