// End-to-end smoke test against a running server + database.
// Usage:  npm run dev   (in one terminal)   then   npm test   (in another)
// It creates two throw-away workspaces and checks the most important guarantees.
import 'dotenv/config';
import crypto from 'node:crypto';
import pg from 'pg';

const BASE = process.env.TEST_URL || `http://localhost:${process.env.PORT || 3000}`;
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0; let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}`, extra ?? ''); }
}

class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body, { csrf = true, raw = false, headers = {} } = {}) {
    const h = { ...headers };
    if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
    if (csrf) h['X-Requested-With'] = 'LeadGuard';
    if (this.cookie) h.Cookie = this.cookie;
    const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : raw ? body : JSON.stringify(body), redirect: 'manual' });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b ?? {}); }
  patch(p, b) { return this.req('PATCH', p, b); }
  put(p, b) { return this.req('PUT', p, b); }
  del(p) { return this.req('DELETE', p); }
}

const uniq = Date.now().toString(36);

async function main() {
  console.log(`Smoke test against ${BASE}\n`);
  const A = new Client(); const B = new Client();

  console.log('Accounts, sessions, CSRF');
  let r = await A.post('/api/auth/signup', { workspaceName: `Acme ${uniq}`, name: 'Alice Owner', email: `alice-${uniq}@test.dev`, password: 'password123', timezone: 'Asia/Karachi' });
  check('sign-up creates workspace + owner', r.status === 201, r.data);
  r = await A.get('/api/auth/me');
  check('session persists (me)', r.data.user?.level === 'owner', r.data);
  const wsA = r.data.workspace;
  await B.post('/api/auth/signup', { workspaceName: `Beta ${uniq}`, name: 'Bob Owner', email: `bob-${uniq}@test.dev`, password: 'password123' });
  r = await A.req('POST', '/api/contacts', { firstName: 'X' }, { csrf: false });
  check('state change without CSRF header is blocked', r.status === 403, r);
  r = await A.req('POST', '/api/contacts', { firstName: 'X' }, { headers: { Origin: 'https://evil.example' } });
  check('cross-site Origin is blocked', r.status === 403, r);
  const anon = new Client();
  r = await anon.get('/api/contacts');
  check('anonymous API call rejected', r.status === 401);

  console.log('Team, roles, invites');
  const roles = (await A.get('/api/roles')).data;
  const sales = roles.find((x) => x.name === 'Sales'); const manager = roles.find((x) => x.name === 'Manager');
  const users = {};
  for (const [key, name, role] of [['u1', 'Uma Sales', sales], ['u2', 'Vic Backup', sales], ['m', 'Mona Manager', manager]]) {
    r = await A.post('/api/users/invite', { email: `${key}-${uniq}@test.dev`, name, level: 'user', roleId: role.id });
    check(`invite ${name}`, r.status === 201, r.data);
    const c = new Client();
    const token = r.data.inviteUrl.split('/invite/')[1];
    r = await c.post('/api/auth/accept-invite', { token, name, password: 'password123' });
    check(`${name} accepts invite`, r.status === 200, r.data);
    users[key] = { client: c, id: (await c.get('/api/auth/me')).data.user.id };
  }
  r = await users.u1.client.get('/api/audit');
  check('Sales user cannot open audit log (server-side)', r.status === 403);
  r = await users.u1.client.put('/api/rules', {});
  check('Sales user cannot change rules', r.status === 403);
  const ownerId = (await A.get('/api/auth/me')).data.user.id;
  r = await users.m.client.patch(`/api/users/${ownerId}`, { name: 'Hacked' });
  check('non-admin cannot modify Owner', r.status === 403);

  console.log('Assignment rules (seconds for testing)');
  // Owner goes offline so leads go to the employees.
  await A.patch(`/api/users/${ownerId}/availability`, { availability: 'offline' });
  await users.m.client.patch(`/api/users/${users.m.id}/availability`, { availability: 'busy' });
  r = await A.put('/api/rules', {
    maxOpenLeads: 5, ackWindowSeconds: 3, idleSeconds: 3600, acknowledgedOnAbsence: 'reassign',
    escalationLevels: [{ type: 'next_available', seconds: 3 }, { type: 'backup', seconds: 3 }, { type: 'manager', seconds: 3 }],
    backupUserId: users.u2.id, managerUserId: users.m.id,
  });
  check('rules saved', r.status === 200, r.data);

  console.log('Lead intake + round-robin + acknowledgement');
  r = await anon.req('POST', `/api/public/forms/${wsA.formToken}`, { name: 'Web Lead', email: `lead-${uniq}@cust.dev`, message: 'Need solar quote' }, { csrf: false });
  check('public web form creates lead', r.status === 201, r.data);
  r = await anon.req('POST', `/api/public/forms/${wsA.formToken}`, { name: 'Bot', email: 'bot@x.dev', website: 'spam' }, { csrf: false });
  check('honeypot rejects bots', r.status === 400);
  let leads = (await A.get('/api/leads')).data.items;
  const l1 = leads[0];
  check('lead has exactly one owner among available employees', [users.u1.id, users.u2.id].includes(l1.owner_id), l1);
  const ownerClient = l1.owner_id === users.u1.id ? users.u1 : users.u2;
  const other = l1.owner_id === users.u1.id ? users.u2 : users.u1;
  r = await other.client.post(`/api/leads/${l1.id}/ack`);
  check('non-owner cannot see/ack someone else’s lead', r.status === 404, r);
  r = await ownerClient.client.post(`/api/leads/${l1.id}/ack`);
  check('owner acknowledges', r.status === 200 && r.data.status === 'acknowledged', r.data);
  r = await A.post('/api/leads', { firstName: 'Manual', lastName: 'Lead', phone: '+923001112233' });
  check('manual lead created', r.status === 201, r.data);
  const l2 = r.data;
  check('round-robin gave the 2nd lead to the other employee', l2.owner_id === other.id, { l2: l2.owner_id, other: other.id });

  console.log('Escalation chain (waiting ~4s)');
  await sleep(4500);
  let d = (await A.get(`/api/leads/${l2.id}`)).data;
  check('unacknowledged lead escalated automatically', d.lead.escalation_count >= 1 && d.lead.owner_id !== l2.owner_id, d.lead);
  check('escalation recorded in assignment history', d.assignments.some((a) => a.kind === 'escalation'));
  const { rows: alerts } = await db.query('SELECT * FROM alert_outbox WHERE lead_id = $1', [l2.id]);
  check('external alert recorded (skipped: telegram not connected)', alerts.length >= 1 && alerts[0].status === 'skipped', alerts);

  console.log('No double escalation under concurrency');
  r = await A.post('/api/leads', { firstName: 'Race', lastName: 'Lead', email: `race-${uniq}@x.dev` });
  const race = r.data;
  await db.query("UPDATE leads SET ack_deadline = now() - interval '1 second' WHERE id = $1", [race.id]);
  const { processDueEscalations } = await import('../src/services/leads.js');
  await Promise.all([processDueEscalations(), processDueEscalations(), processDueEscalations(), processDueEscalations()]);
  await sleep(300);
  const { rows: [rc] } = await db.query('SELECT escalation_count FROM leads WHERE id = $1', [race.id]);
  const { rows: esc } = await db.query("SELECT count(*)::int AS n FROM lead_assignments WHERE lead_id = $1 AND kind = 'escalation'", [race.id]);
  check('4 concurrent workers escalate the lead exactly once', rc.escalation_count === 1 && esc[0].n === 1, { rc, esc });

  console.log('Absence reassignment');
  r = await A.post('/api/leads', { firstName: 'Absence', email: `abs-${uniq}@x.dev` });
  const ab = r.data;
  const abOwner = ab.owner_id === users.u1.id ? users.u1 : users.u2;
  r = await abOwner.client.patch(`/api/users/${abOwner.id}/availability`, { availability: 'on_leave' });
  check('going On leave reports reassigned leads', r.status === 200 && r.data.moved.unacknowledged >= 1, r.data);
  const { rows: [abNow] } = await db.query('SELECT owner_id FROM leads WHERE id = $1', [ab.id]);
  check('lead moved away from on-leave employee', abNow.owner_id !== abOwner.id);
  await abOwner.client.patch(`/api/users/${abOwner.id}/availability`, { availability: 'available' });

  console.log('Recovery queue + dashboard');
  await db.query('UPDATE leads SET escalation_count = 2 WHERE id = $1', [ab.id]);
  r = await A.get('/api/leads/recovery');
  const item = r.data.items.find((x) => x.id === ab.id);
  check('recovery queue lists lead with reason', item && item.reasons.includes('escalated'), r.data.items.map((x) => x.reasons));
  const dash = (await A.get('/api/dashboard')).data;
  check('dashboard recovery figure matches queue', dash.recoveryQueue === r.data.items.length, { dash: dash.recoveryQueue, list: r.data.items.length });
  check('dashboard counts today’s leads', dash.newLeadsToday >= 4, dash.newLeadsToday);
  const esc24 = (await A.get('/api/leads/escalations?hours=24')).data.items.length;
  check('escalations figure matches drill-down', dash.escalations24h === esc24, { dash: dash.escalations24h, esc24 });

  console.log('Workspace isolation');
  const contactA = (await A.get(`/api/leads/${l1.id}`)).data.lead.contact_id;
  r = await B.get(`/api/contacts/${contactA}`);
  check('other workspace cannot read contact by id', r.status === 404);
  r = await B.patch(`/api/contacts/${contactA}`, { firstName: 'Pwned', version: 1 });
  check('other workspace cannot edit contact by id', r.status === 404);
  r = await B.get(`/api/leads/${l1.id}`);
  check('other workspace cannot read lead by id', r.status === 404);

  console.log('Pipeline, required fields, custom fields, masking, filters');
  const pipes = (await A.get('/api/pipelines')).data;
  const pipe = pipes.pipelines[0];
  r = await A.post('/api/fields', { entity: 'opportunity', label: 'Roof size (m2)', type: 'number', pipelineId: pipe.id });
  check('custom field created from UI', r.status === 201, r.data);
  const roof = r.data;
  r = await A.post('/api/opportunities', { title: 'Solar install', contactId: contactA, pipelineId: pipe.id, custom: { [roof.key]: 'abc' } });
  check('custom field type is validated', r.status === 400, r.data);
  r = await A.post('/api/opportunities', { title: 'Solar install', contactId: contactA, pipelineId: pipe.id, custom: { [roof.key]: 42 } });
  check('opportunity created', r.status === 201, r.data);
  let opp = r.data;
  const proposal = pipe.stages.find((s) => s.name === 'Proposal sent');
  r = await A.post(`/api/opportunities/${opp.id}/move`, { stageId: proposal.id, version: opp.version });
  check('stage with required Value blocks the move', r.status === 422 && /Value/.test(r.data.error), r.data);
  r = await A.patch(`/api/opportunities/${opp.id}`, { value: 5000, version: opp.version });
  opp = r.data;
  r = await A.patch(`/api/opportunities/${opp.id}`, { title: 'stale', version: opp.version - 1 });
  check('stale edit rejected (no silent overwrite)', r.status === 409);
  r = await A.post(`/api/opportunities/${opp.id}/move`, { stageId: proposal.id, version: opp.version });
  check('move allowed after filling field', r.status === 200, r.data);
  // masking
  r = await A.post('/api/roles', { name: `Junior ${uniq}`, permissions: ['crm.view', 'crm.view_all'] });
  await A.patch(`/api/users/${users.u2.id}`, { roleId: r.data.id });
  const masked = (await users.u2.client.get(`/api/opportunities/${opp.id}`)).data;
  check('value masked for user without permission', masked.opportunity.value === null && masked.opportunity.value_masked === true, masked.opportunity);
  r = await users.u2.client.get(`/api/opportunities?filters=${encodeURIComponent(JSON.stringify([{ field: 'value', op: 'gt', value: 1 }]))}`);
  check('cannot infer value through filters', r.status === 403);
  await A.patch(`/api/users/${users.u2.id}`, { roleId: sales.id });
  const filters = [{ field: 'pipeline_id', op: 'eq', value: pipe.id }, { field: `custom.${roof.key}`, op: 'gte', value: 40 }, { field: 'created_at', op: 'last_days', value: 7 }];
  r = await A.get(`/api/opportunities?filters=${encodeURIComponent(JSON.stringify(filters))}`);
  check('3-criteria filter works', r.status === 200 && r.data.items.some((x) => x.id === opp.id), r.data);
  r = await A.post('/api/lists', { name: 'Big roofs', entity: 'opportunities', filters });
  check('saved list stored', r.status === 201);
  r = await A.del(`/api/stages/${proposal.id}`);
  check('deleting a stage with opportunities requires a target', r.status === 409 && r.data.needsMoveTo);

  console.log('Twilio webhook: signature, duplicates, contact matching');
  const twilioCfg = { accountSid: `AC${'0'.repeat(32)}`, authToken: 'test_auth_token_1234567890', fromNumber: '+14155238886', channel: 'whatsapp' };
  const { encryptJson } = await import('../src/lib/crypto.js');
  await db.query("INSERT INTO integrations (workspace_id, provider, config_enc) VALUES ($1,'twilio',$2) ON CONFLICT (workspace_id, provider) DO UPDATE SET config_enc = EXCLUDED.config_enc", [wsA.id, encryptJson(twilioCfg)]);
  const inboundUrl = `${process.env.APP_URL || BASE}/webhooks/twilio/${wsA.formToken}/inbound`;
  const params = { MessageSid: `SM${uniq}aaaa`, From: 'whatsapp:+923009998877', To: 'whatsapp:+14155238886', Body: 'Hi, I want a quote', ProfileName: 'Wasi' };
  const sign = (url, p) => crypto.createHmac('sha1', twilioCfg.authToken).update(Object.keys(p).sort().reduce((a, k) => a + k + p[k], url)).digest('base64');
  const post = (p, sig) => fetch(`${BASE}/webhooks/twilio/${wsA.formToken}/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig }, body: new URLSearchParams(p) });
  let res = await post(params, sign(inboundUrl, params));
  check('signed inbound message accepted', res.status === 200, await res.text());
  res = await post(params, sign(inboundUrl, params));
  check('duplicate delivery accepted (200) but ignored', res.status === 200);
  const { rows: msgs } = await db.query('SELECT * FROM messages WHERE provider_sid = $1', [params.MessageSid]);
  check('only one message stored', msgs.length === 1);
  const { rows: wl } = await db.query("SELECT * FROM leads WHERE workspace_id = $1 AND source = 'whatsapp'", [wsA.id]);
  check('unknown number created contact + one lead', wl.length === 1);
  res = await post({ ...params, MessageSid: `SM${uniq}bbbb`, Body: 'forged' }, 'bm90LWEtcmVhbC1zaWduYXR1cmU=');
  check('forged signature rejected', res.status === 403);
  const { rows: rej } = await db.query("SELECT * FROM integration_events WHERE workspace_id = $1 AND result = 'rejected'", [wsA.id]);
  check('forged request recorded', rej.length >= 1);
  const p2 = { ...params, MessageSid: `SM${uniq}cccc`, Body: 'second message' };
  await post(p2, sign(inboundUrl, p2));
  const { rows: wl2 } = await db.query("SELECT * FROM leads WHERE workspace_id = $1 AND source = 'whatsapp'", [wsA.id]);
  check('known number attaches to existing contact (no new lead)', wl2.length === 1);
  const pStop = { ...params, MessageSid: `SM${uniq}dddd`, Body: 'STOP' };
  await post(pStop, sign(inboundUrl, pStop));
  const { rows: [optc] } = await db.query('SELECT id, opted_out FROM contacts WHERE workspace_id = $1 AND phone = $2', [wsA.id, '+923009998877']);
  check('STOP opts the contact out', optc.opted_out === true);
  r = await A.post(`/api/contacts/${optc.id}/messages`, { body: 'hello?' });
  check('opted-out contact cannot be messaged (with reason)', r.status === 409 && /opted out/i.test(r.data.error), r.data);

  console.log('Stripe webhook: signature, idempotency, refunds');
  const whsec = 'whsec_testsecret123';
  await db.query("INSERT INTO integrations (workspace_id, provider, config_enc) VALUES ($1,'stripe',$2) ON CONFLICT (workspace_id, provider) DO UPDATE SET config_enc = EXCLUDED.config_enc", [wsA.id, encryptJson({ secretKey: 'sk_test_x', webhookSecret: whsec })]);
  const { rows: [pay] } = await db.query(
    "INSERT INTO payments (workspace_id, opportunity_id, contact_id, requested_by, amount_cents, currency, status, checkout_session_id) VALUES ($1,$2,$3,$4,5000,'usd','pending',$5) RETURNING *",
    [wsA.id, opp.id, contactA, ownerId, `cs_test_${uniq}`]);
  const stripePost = (evt, secret = whsec) => {
    const body = JSON.stringify(evt); const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    return fetch(`${BASE}/webhooks/stripe/${wsA.formToken}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` }, body });
  };
  const evt = { id: `evt_${uniq}_1`, type: 'checkout.session.completed', livemode: false, created: Math.floor(Date.now() / 1000), data: { object: { id: `cs_test_${uniq}`, payment_status: 'paid', payment_intent: `pi_${uniq}`, metadata: { payment_id: pay.id } } } };
  res = await stripePost(evt, 'whsec_wrong');
  check('wrong Stripe signature rejected', res.status === 400);
  let { rows: [pp] } = await db.query('SELECT status FROM payments WHERE id = $1', [pay.id]);
  check('payment untouched by forged event', pp.status === 'pending');
  res = await stripePost(evt);
  check('signed completed event accepted', res.status === 200);
  res = await stripePost(evt);
  check('same event again is a duplicate', (await res.json()).result === 'duplicate');
  ({ rows: [pp] } = await db.query('SELECT status, paid_at FROM payments WHERE id = $1', [pay.id]));
  check('payment marked paid by webhook', pp.status === 'paid' && pp.paid_at);
  const dash2 = (await A.get('/api/dashboard')).data;
  check('dashboard collected revenue includes webhook-confirmed payment', dash2.collectedThisMonth.some((x) => x.currency === 'usd' && x.cents >= 5000), dash2.collectedThisMonth);
  res = await stripePost({ id: `evt_${uniq}_2`, type: 'charge.refunded', livemode: false, created: Math.floor(Date.now() / 1000), data: { object: { id: `ch_${uniq}`, payment_intent: `pi_${uniq}`, amount_refunded: 2000 } } });
  ({ rows: [pp] } = await db.query('SELECT status, refunded_cents FROM payments WHERE id = $1', [pay.id]));
  check('partial refund reflected', pp.status === 'partially_refunded' && pp.refunded_cents === 2000, pp);

  console.log('Audit log');
  r = await A.get('/api/audit?action=lead');
  check('audit has lead events', r.data.items.some((x) => x.action === 'lead.escalated') && r.data.items.some((x) => x.action === 'lead.acknowledged'));
  let tamper = null;
  try { await db.query('UPDATE audit_log SET action = $1 WHERE workspace_id = $2', ['x', wsA.id]); } catch (e) { tamper = e.message; }
  check('audit entries cannot be modified (DB trigger)', /append-only/.test(tamper || ''), tamper);
  r = await A.req('DELETE', '/api/audit/1');
  check('no API endpoint deletes audit entries', r.status === 404);

  console.log(`\n${passed} passed, ${failed} failed`);
  await db.end();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
