// Payments (I2): payment requests via Stripe Checkout and webhook-driven status updates.
import { config } from '../config.js';
import { query, tx } from '../db/pool.js';
import { HttpError } from '../lib/http.js';
import { getIntegration, logEvent } from '../integrations/store.js';
import * as stripe from '../integrations/stripe.js';
import { addActivity } from './activity.js';
import { audit } from './audit.js';
import { emit } from './events.js';
import { recordLeadAction } from './leads.js';
import { notifyUser } from './notify.js';

export async function createPaymentRequest({ workspaceId, opportunityId, amount, currency, description, expiresInMinutes, user }) {
  const integ = await getIntegration({ query }, workspaceId, 'stripe');
  if (!integ?.config) throw new HttpError(409, integ?.error || 'Payments are not connected. An admin can connect Stripe on the Integrations page.');
  const { rows: [opp] } = await query(
    `SELECT o.*, c.email, c.first_name, c.last_name FROM opportunities o JOIN contacts c ON c.id = o.contact_id
      WHERE o.id = $1 AND o.workspace_id = $2 AND o.deleted_at IS NULL`, [opportunityId, workspaceId]);
  if (!opp) throw new HttpError(404, 'Opportunity not found');
  const cur = currency.toLowerCase();
  const amountCents = stripe.toMinor(amount, cur);
  if (amountCents < 50) throw new HttpError(400, 'Amount is too small for Stripe (minimum is about 0.50 USD equivalent).');

  const { rows: [p] } = await query(
    `INSERT INTO payments (workspace_id, opportunity_id, contact_id, requested_by, amount_cents, currency, description, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING *`,
    [workspaceId, opp.id, opp.contact_id, user.id, amountCents, cur, description || opp.title]);

  const r = await stripe.createCheckout(integ.config, {
    paymentId: p.id, workspaceId, amountCents, currency: cur, name: description || opp.title, description,
    customerEmail: opp.email, expiresInMinutes,
    successUrl: `${config.appUrl}/pay/thanks?status=success`, cancelUrl: `${config.appUrl}/pay/thanks?status=cancelled`,
  });
  if (!r.ok) {
    const detail = r.networkError || r.json?.error?.message || `HTTP ${r.status}`;
    await query("UPDATE payments SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1", [p.id, `Could not create payment link: ${detail}`]);
    await logEvent({ query }, { workspaceId, provider: 'stripe', direction: 'outbound', kind: 'checkout.create', result: 'error', reference: p.id, httpStatus: r.status, detail });
    throw new HttpError(502, `Stripe could not create the payment link: ${detail}`);
  }
  const s = r.json;
  const payment = await tx(async (db) => {
    const { rows: [up] } = await db.query(
      `UPDATE payments SET checkout_session_id = $2, checkout_url = $3, expires_at = to_timestamp($4), updated_at = now() WHERE id = $1 RETURNING *`,
      [p.id, s.id, s.url, s.expires_at]);
    await logEvent(db, { workspaceId, provider: 'stripe', direction: 'outbound', kind: 'checkout.create', result: 'ok', reference: s.id, httpStatus: r.status });
    await addActivity(db, { workspaceId, contactId: opp.contact_id, opportunityId: opp.id, type: 'payment', actorId: user.id, body: `Payment request created: ${formatMoney(amountCents, cur)}`, data: { payment_id: p.id } });
    await recordLeadAction(db, { workspaceId, user, contactId: opp.contact_id, opportunityId: opp.id, via: 'payment request' });
    emit(db, workspaceId, 'payments', { id: p.id });
    return up;
  });
  return payment;
}

export async function expirePayment({ workspaceId, paymentId, user }) {
  const { rows: [p] } = await query('SELECT * FROM payments WHERE id = $1 AND workspace_id = $2', [paymentId, workspaceId]);
  if (!p) throw new HttpError(404, 'Payment not found');
  if (p.status !== 'pending' || !p.checkout_session_id) throw new HttpError(409, 'Only pending payment links can be cancelled.');
  const integ = await getIntegration({ query }, workspaceId, 'stripe');
  if (!integ?.config) throw new HttpError(409, 'Stripe is not connected.');
  const r = await stripe.expireCheckout(integ.config, p.checkout_session_id);
  await logEvent({ query }, { workspaceId, provider: 'stripe', direction: 'outbound', kind: 'checkout.expire', result: r.ok ? 'ok' : 'error', reference: p.checkout_session_id, httpStatus: r.status, detail: r.ok ? `Requested by ${user.name}` : (r.networkError || r.json?.error?.message) });
  if (!r.ok) throw new HttpError(502, `Stripe could not cancel the link: ${r.networkError || r.json?.error?.message}`);
  // Status changes to "expired" when Stripe's checkout.session.expired webhook arrives.
  return { ok: true };
}

export function formatMoney(cents, currency) {
  const amount = stripe.fromMinor(cents, currency);
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(amount); } catch { return `${amount} ${currency.toUpperCase()}`; }
}

// Applies a verified Stripe event. Idempotent: the event id is recorded in the same transaction.
export async function applyStripeEvent(workspaceId, event) {
  return tx(async (db) => {
    const ins = await db.query(
      `INSERT INTO processed_webhooks (workspace_id, provider, event_id) VALUES ($1,'stripe',$2) ON CONFLICT DO NOTHING RETURNING event_id`,
      [workspaceId, event.id]);
    if (!ins.rows.length) {
      await logEvent(db, { workspaceId, provider: 'stripe', direction: 'inbound', kind: event.type, result: 'duplicate', reference: event.id, detail: 'Already processed — ignored' });
      return 'duplicate';
    }
    const obj = event.data?.object || {};
    let payment = null;
    const find = async (sql, v) => (v ? (await db.query(`SELECT * FROM payments WHERE workspace_id = $1 AND ${sql} FOR UPDATE`, [workspaceId, v])).rows[0] : null);
    if (event.type.startsWith('checkout.session.')) {
      payment = await find('checkout_session_id = $2', obj.id) || await find('id::text = $2', obj.metadata?.payment_id);
    } else if (event.type.startsWith('payment_intent.')) {
      payment = await find('payment_intent_id = $2', obj.id) || await find('id::text = $2', obj.metadata?.payment_id);
    } else if (event.type === 'charge.refunded') {
      payment = await find('payment_intent_id = $2', obj.payment_intent) || await find('id::text = $2', obj.metadata?.payment_id);
    }
    if (!payment) {
      await logEvent(db, { workspaceId, provider: 'stripe', direction: 'inbound', kind: event.type, result: 'ok', reference: event.id, detail: 'No matching payment in this workspace — ignored' });
      return 'ignored';
    }

    let next = null; let note = null; const set = {};
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        set.payment_intent_id = obj.payment_intent || payment.payment_intent_id;
        if (obj.payment_status === 'paid' || event.type.endsWith('succeeded')) {
          if (!['paid', 'refunded', 'partially_refunded'].includes(payment.status)) { next = 'paid'; set.paid_at = new Date(event.created * 1000); note = 'Payment received'; }
        } else { note = 'Checkout completed, waiting for the payment to clear'; }
        break;
      case 'checkout.session.async_payment_failed':
        if (payment.status !== 'paid') { next = 'failed'; set.last_error = 'The bank declined the delayed payment'; note = 'Payment failed'; }
        break;
      case 'checkout.session.expired':
        if (payment.status === 'pending' || payment.status === 'failed') { next = 'expired'; note = 'Payment link expired without payment (abandoned)'; }
        break;
      case 'payment_intent.payment_failed':
        set.payment_intent_id = obj.id;
        if (payment.status === 'pending') { next = 'failed'; set.last_error = obj.last_payment_error?.message || 'Card payment failed'; note = `Payment attempt failed: ${set.last_error}`; }
        break;
      case 'charge.refunded': {
        const refunded = Number(obj.amount_refunded || 0);
        set.refunded_cents = refunded;
        next = refunded >= payment.amount_cents ? 'refunded' : 'partially_refunded';
        note = `Refund of ${formatMoney(refunded, payment.currency)} confirmed by Stripe`;
        break;
      }
      default: break;
    }
    if (next === 'paid' && payment.status === 'failed') set.last_error = null; // a later successful attempt wins
    const fields = Object.keys(set);
    const vals = fields.map((k) => set[k]);
    const sqlSet = [...fields.map((k, i) => `${k} = $${i + 3}`), 'updated_at = now()'];
    if (next) sqlSet.push(`status = '${next}'`);
    await db.query(`UPDATE payments SET ${sqlSet.join(', ')} WHERE id = $1 AND workspace_id = $2`, [payment.id, workspaceId, ...vals]);
    if (note) {
      await addActivity(db, { workspaceId, contactId: payment.contact_id, opportunityId: payment.opportunity_id, type: 'payment', body: `${note} (${formatMoney(payment.amount_cents, payment.currency)})`, data: { payment_id: payment.id, event: event.type } });
    }
    if (next) {
      await audit(db, { workspaceId, actor: null, action: `payment.${next}`, targetType: 'payment', targetId: payment.id, before: { status: payment.status }, after: { status: next, stripe_event: event.id } });
      if (payment.requested_by && ['paid', 'failed', 'refunded'].includes(next)) {
        await notifyUser(db, { workspaceId, userId: payment.requested_by, title: `Payment ${next}: ${formatMoney(payment.amount_cents, payment.currency)}`, link: `/opportunities/${payment.opportunity_id}` });
      }
    }
    await logEvent(db, { workspaceId, provider: 'stripe', direction: 'inbound', kind: event.type, result: 'ok', reference: event.id, detail: next ? `Payment ${payment.id.slice(0, 8)} → ${next}` : 'No status change' });
    emit(db, workspaceId, 'payments', { id: payment.id });
    emit(db, workspaceId, 'dashboard', {});
    return next || 'unchanged';
  });
}
