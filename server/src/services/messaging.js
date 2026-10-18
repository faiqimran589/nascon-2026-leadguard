// Messaging (I1): conversations, outbound sending with retries, inbound capture, delivery status.
// Providers: Meta WhatsApp Cloud API (used when connected) or Twilio WhatsApp/SMS.
import { config } from '../config.js';
import { query, tx } from '../db/pool.js';
import { HttpError } from '../lib/http.js';
import { normalizePhone } from '../lib/phone.js';
import { getIntegration, logEvent } from '../integrations/store.js';
import * as twilio from '../integrations/twilio.js';
import * as meta from '../integrations/meta.js';
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

// Which messaging provider this workspace uses: Meta WhatsApp Cloud API if connected, otherwise Twilio.
export async function messagingProvider(workspaceId) {
  const m = await getIntegration({ query }, workspaceId, 'meta');
  if (m) return { provider: 'meta', integ: m, channel: 'whatsapp', name: 'Meta WhatsApp' };
  const t = await getIntegration({ query }, workspaceId, 'twilio');
  if (t) return { provider: 'twilio', integ: t, channel: t.config?.channel || 'whatsapp', name: 'Twilio' };
  return null;
}

// Employee sends a message. The row is stored first (so nothing is ever silently lost), then delivered.
export async function sendMessage({ workspaceId, contactId, body, user }) {
  const mp = await messagingProvider(workspaceId);
  if (!mp?.integ?.config) throw new HttpError(409, mp?.integ?.error || 'Messaging is not connected. An admin can connect Meta WhatsApp or Twilio on the Integrations page.');
  const channel = mp.channel;
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

  const mp = await messagingProvider(claim.workspace_id);
  const provider = mp?.provider || 'twilio';
  const label = mp?.name || 'the messaging provider';
  let update;
  if (claim.opted_out) {
    update = { status: 'failed', error_code: 'opted_out', error_message: 'Contact opted out before the message was sent.' };
  } else if (!mp?.integ?.config) {
    update = { status: 'failed', error_code: 'not_connected', error_message: mp?.integ?.error || 'Messaging integration is not connected.' };
  } else {
    let r; let sid = null; let providerStatus = 'sent'; let errCode = null; let errText = null;
    if (provider === 'meta') {
      r = await meta.send(mp.integ.config, { to: claim.phone, body: claim.body });
      if (r.ok) { sid = r.json?.messages?.[0]?.id; providerStatus = 'sent'; } else { errCode = r.json?.error?.code; errText = meta.explain(errCode, r.json?.error?.error_data?.details || r.json?.error?.message); }
    } else {
      r = await twilio.send(mp.integ.config, { to: claim.phone, body: claim.body, statusCallback: statusCallbackUrl(claim.webhook_token) });
      if (r.ok) { sid = r.json.sid; providerStatus = r.json.status || 'queued'; } else { errCode = r.json?.code; errText = twilio.explain(r.json?.code, r.json?.message); }
    }
    if (r.ok) {
      update = { status: providerStatus, provider_sid: sid, error_code: null, error_message: null, next_attempt_at: null };
      await logEvent({ query }, { workspaceId: claim.workspace_id, provider, direction: 'outbound', kind: 'message.send', result: 'ok', reference: sid, httpStatus: r.status });
    } else if (r.transient && claim.attempts + 1 < MAX_ATTEMPTS) {
      const delay = 10 * 3 ** claim.attempts; // 10s, 30s
      update = { status: 'queued', error_code: String(r.status || 'network'), error_message: `Temporary problem reaching ${label} (${r.networkError || errText || `HTTP ${r.status}`}). Retrying automatically in ${delay}s (attempt ${claim.attempts + 1} of ${MAX_ATTEMPTS}).`, next_attempt_at: new Date(Date.now() + delay * 1000) };
      await logEvent({ query }, { workspaceId: claim.workspace_id, provider, direction: 'outbound', kind: 'message.send', result: 'retrying', reference: claim.id, httpStatus: r.status, detail: update.error_message });
    } else {
      const explained = r.networkError ? `${r.networkError}. Gave up after ${MAX_ATTEMPTS} attempts — use Retry.` : errText || `HTTP ${r.status}`;
      update = { status: 'failed', error_code: String(errCode || r.status || 'network'), error_message: explained, next_attempt_at: null };
      await logEvent({ query }, { workspaceId: claim.workspace_id, provider, direction: 'outbound', kind: 'message.send', result: 'error', reference: claim.id, httpStatus: r.status, detail: explained });
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

// Twilio inbound webhook (already signature-verified).
export async function handleInbound(workspace, params) {
  const channel = String(params.From || '').startsWith('whatsapp:') ? 'whatsapp' : 'sms';
  return receiveMessage(workspace, {
    provider: 'twilio', channel, phone: normalizePhone(params.From), sid: params.MessageSid || params.SmsSid, profileName: params.ProfileName,
    body: String(params.Body || '').slice(0, 4000) || (Number(params.NumMedia) > 0 ? '[media message — not displayed]' : ''),
  });
}

// Provider-independent inbound message handling. Idempotent on the provider message id.
export async function receiveMessage(workspace, { provider, channel, phone, sid, body, profileName }) {
  if (!phone || !sid) return { result: 'rejected', detail: 'Missing sender or message id' };
  return tx(async (db) => {
    const ws = workspace.id;
    const dup = await db.query(
      `INSERT INTO processed_webhooks (workspace_id, provider, event_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id`,
      [ws, provider, `in:${sid}`]);
    if (!dup.rows.length) {
      await logEvent(db, { workspaceId: ws, provider, direction: 'inbound', kind: 'message.received', result: 'duplicate', reference: sid, detail: 'Duplicate delivery ignored' });
      return { result: 'duplicate' };
    }
    const { contact, created } = await findOrCreateContact(db, ws, { firstName: profileName || phone, phone, source: channel });
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
    await logEvent(db, { workspaceId: ws, provider, direction: 'inbound', kind: 'message.received', result: 'ok', reference: sid, detail: created ? `New contact + lead from ${phone}` : `Attached to existing contact ${contact.first_name}` });
    emit(db, ws, 'messages', { conversationId: conv.id });
    return { result: 'ok', leadId: lead?.id, contactId: contact.id };
  });
}

// Twilio delivery status callback (already signature-verified).
export async function handleStatus(workspace, params) {
  return applyStatus(workspace, {
    provider: 'twilio', sid: params.MessageSid || params.SmsSid, status: String(params.MessageStatus || params.SmsStatus || '').toLowerCase(),
    errorCode: params.ErrorCode || null, errorText: params.ErrorCode ? twilio.explain(params.ErrorCode, params.ErrorMessage) : null,
  });
}

// Provider-independent delivery status update. Idempotent; status never moves backwards.
export async function applyStatus(workspace, { provider, sid, status, errorCode, errorText }) {
  if (!sid || !status) return { result: 'rejected', detail: 'Missing message id or status' };
  return tx(async (db) => {
    const ws = workspace.id;
    const dup = await db.query(
      `INSERT INTO processed_webhooks (workspace_id, provider, event_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id`,
      [ws, provider, `st:${sid}:${status}`]);
    if (!dup.rows.length) {
      await logEvent(db, { workspaceId: ws, provider, direction: 'inbound', kind: 'message.status', result: 'duplicate', reference: sid, detail: status });
      return { result: 'duplicate' };
    }
    const { rows: [m] } = await db.query('SELECT * FROM messages WHERE workspace_id = $1 AND provider_sid = $2 FOR UPDATE', [ws, sid]);
    if (!m) {
      await logEvent(db, { workspaceId: ws, provider, direction: 'inbound', kind: 'message.status', result: 'error', reference: sid, detail: `Status "${status}" for unknown message` });
      return { result: 'unknown' };
    }
    if ((STATUS_RANK[status] ?? 0) >= (STATUS_RANK[m.status] ?? 0)) {
      await db.query('UPDATE messages SET status = $2, error_code = COALESCE($3, error_code), error_message = COALESCE($4, error_message), updated_at = now() WHERE id = $1',
        [m.id, status, errorCode ? String(errorCode) : null, errorText]);
    }
    await logEvent(db, { workspaceId: ws, provider, direction: 'inbound', kind: 'message.status', result: 'ok', reference: sid, detail: status + (errorCode ? ` (error ${errorCode})` : '') });
    emit(db, ws, 'messages', { conversationId: m.conversation_id });
    return { result: 'ok' };
  });
}

// Meta WhatsApp Cloud API webhook payload (already signature-verified).
// One POST can contain several messages and status updates.
export async function handleMetaWebhook(workspace, payload, cfg) {
  const results = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;
      const v = change.value || {};
      if (cfg.phoneNumberId && v.metadata?.phone_number_id && String(v.metadata.phone_number_id) !== String(cfg.phoneNumberId)) {
        results.push({ result: 'ignored', detail: `Event for another phone number (${v.metadata.phone_number_id})` });
        continue;
      }
      const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const msg of v.messages || []) {
        results.push(await receiveMessage(workspace, {
          provider: 'meta', channel: 'whatsapp', sid: msg.id, phone: normalizePhone(`+${String(msg.from || '').replace(/[^\d]/g, '')}`),
          profileName: names[msg.from], body: meta.bodyOf(msg).slice(0, 4000),
        }));
      }
      for (const st of v.statuses || []) {
        const err = st.errors?.[0];
        results.push(await applyStatus(workspace, {
          provider: 'meta', sid: st.id, status: String(st.status || '').toLowerCase(),
          errorCode: err?.code || null, errorText: err ? meta.explain(err.code, err.error_data?.details || err.message || err.title) : null,
        }));
      }
    }
  }
  return results;
}
