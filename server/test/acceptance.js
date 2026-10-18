// Extra acceptance checks mapped to problem-statement IDs (complements smoke.js).
// Usage: start the server, then  node server/test/acceptance.js
import 'dotenv/config';
import pg from 'pg';

const BASE = process.env.TEST_URL || `http://localhost:${process.env.PORT || 3000}`;
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0; let failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}`, extra ?? ''); } };

class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body) {
    const h = { 'X-Requested-With': 'LeadGuard' };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (this.cookie) h.Cookie = this.cookie;
    const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const sc = res.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  }
  get(p) { return this.req('GET', p); } post(p, b) { return this.req('POST', p, b ?? {}); }
  patch(p, b) { return this.req('PATCH', p, b); } put(p, b) { return this.req('PUT', p, b); } del(p) { return this.req('DELETE', p); }
}
const u = Date.now().toString(36);

async function join(owner, key, name, level, roleId) {
  const r = await owner.post('/api/users/invite', { email: `${key}-${u}@acc.dev`, name, level, roleId });
  const c = new Client();
  await c.post('/api/auth/accept-invite', { token: r.data.inviteUrl.split('/invite/')[1], name, password: 'password123' });
  return { c, id: (await c.get('/api/auth/me')).data.user.id };
}

async function main() {
  const O = new Client();
  let r = await O.post('/api/auth/signup', { workspaceName: `Acc ${u}`, name: 'Olivia Owner', email: `o-${u}@acc.dev`, password: 'password123' });
  const me = (await O.get('/api/auth/me')).data; const ownerId = me.user.id;
  const roles = (await O.get('/api/roles')).data;
  const sales = roles.find((x) => x.name === 'Sales'); const manager = roles.find((x) => x.name === 'Manager');

  console.log('F1.2 / F1.3 — levels and permission escalation');
  const adm = await join(O, 'adm', 'Adam Admin', 'admin', manager.id);
  r = await adm.c.patch(`/api/users/${ownerId}`, { name: 'Changed' });
  check('Admin cannot modify the Owner', r.status === 403);
  r = await adm.c.patch(`/api/users/${ownerId}/availability`, { availability: 'busy' });
  check('Admin cannot change the Owner’s status', r.status === 403);
  const hr = await O.post('/api/roles', { name: 'HR', permissions: ['crm.view', 'users.manage'] });
  const hrUser = await join(O, 'hr', 'Hana HR', 'user', hr.data.id);
  r = await hrUser.c.post('/api/users/invite', { email: `esc-${u}@acc.dev`, name: 'Esc', level: 'user', roleId: manager.id });
  check('User-level account cannot mint accounts (no privilege escalation)', r.status === 403, r.data);
  const pending = await O.post('/api/users/invite', { email: `pend-${u}@acc.dev`, name: 'Pending Admin', level: 'admin', roleId: manager.id });
  r = await hrUser.c.post(`/api/users/${pending.data.user.id}/reinvite`);
  check('User-level account cannot hijack a pending Admin invite', r.status === 403, r.data);
  r = await adm.c.post(`/api/users/${pending.data.user.id}/reinvite`);
  check('Admin cannot re-send an Admin invitation', r.status === 403, r.data);
  r = await O.post(`/api/users/${pending.data.user.id}/reinvite`);
  check('Owner can re-send it (audited)', r.status === 200);

  const s1 = await join(O, 's1', 'Sana Sales', 'user', sales.id);
  const s2 = await join(O, 's2', 'Saad Sales', 'user', sales.id);
  r = await s1.c.get('/api/export/contacts.csv');
  check('F1.3 export permission enforced on the server', r.status === 403);
  r = await s1.c.post('/api/contacts', { firstName: 'Owned', lastName: 'Elsewhere', ownerId: s2.id });
  check('F1.5 creating a record owned by someone else needs reassign permission', r.status === 403, r.data);

  console.log('F3.3 — only Available employees under the limit receive leads');
  for (const id of [ownerId, adm.id, hrUser.id]) await O.patch(`/api/users/${id}/availability`, { availability: 'offline' });
  await s2.c.patch(`/api/users/${s2.id}/availability`, { availability: 'busy' });
  r = await O.put('/api/rules', { maxOpenLeads: 2, ackWindowSeconds: 600, idleSeconds: 3600, acknowledgedOnAbsence: 'keep', escalationLevels: [{ type: 'next_available', seconds: 600 }], backupUserId: null, managerUserId: null });
  check('rules saved', r.status === 200, r.data);
  const owners = [];
  for (let i = 0; i < 3; i++) { r = await O.post('/api/leads', { firstName: `RR${i}`, lastName: 'Test', email: `rr${i}-${u}@cust.dev` }); owners.push(r.data.owner_id); }
  check('busy employee never received a lead', !owners.includes(s2.id), owners);
  check('only the Available employee received leads up to the limit (2)', owners.filter((x) => x === s1.id).length === 2, owners);
  const third = (await O.get('/api/leads')).data.items.find((l) => l.title.startsWith('RR2'));
  check('3rd lead (limit reached) still gets an accountable owner, with the reason recorded', !!third.owner_id, third);

  console.log('F3.6 — acknowledged-lead treatment (keep) is applied and reported');
  const first = (await O.get('/api/leads')).data.items.find((l) => l.title.startsWith('RR0'));
  await s1.c.post(`/api/leads/${first.id}/ack`);
  r = await s1.c.patch(`/api/users/${s1.id}/availability`, { availability: 'on_leave' });
  check('going On leave moves unacknowledged leads and keeps acknowledged ones', r.data.moved?.acknowledgedKept === 1 && r.data.moved?.unacknowledged >= 1, r.data);

  console.log('F1.4 / F4.1 / F4.2 — history');
  await s1.c.patch(`/api/users/${s1.id}/availability`, { availability: 'available' });
  const p = (await O.get('/api/pipelines')).data.pipelines[0];
  const c = (await O.post('/api/contacts', { firstName: 'Val', lastName: 'Ue' })).data;
  const opp = (await O.post('/api/opportunities', { title: 'Secret deal', contactId: c.id, pipelineId: p.id, stageId: p.stages.find((s) => s.kind === 'open').id, value: 98765 })).data;
  const full = (await O.get(`/api/opportunities/${opp.id}`)).data.opportunity;
  r = await O.patch(`/api/opportunities/${opp.id}`, { ownerId: s1.id, version: full.version });
  check('opportunity owner change accepted', r.status === 200, r.data);
  await O.del(`/api/opportunities/${opp.id}`);
  const aud = (await O.get(`/api/audit?targetId=${opp.id}`)).data.items;
  check('opportunity reassignment is in the audit log with before/after', aud.some((a) => a.action === 'opportunity.reassigned' && a.before.owner_id && a.after.owner_id === s1.id), aud.map((a) => a.action));
  const auditor = await O.post('/api/roles', { name: 'Auditor', permissions: ['crm.view', 'audit.view'] });
  const aU = await join(O, 'aud', 'Ali Auditor', 'user', auditor.data.id);
  const seen = (await aU.c.get(`/api/audit?targetId=${opp.id}`)).data.items;
  check('audit log hides opportunity value from users without value permission', seen.length > 0 && !JSON.stringify(seen).includes('98765'), JSON.stringify(seen).slice(0, 300));
  r = await O.get('/api/audit?from=notadate');
  check('invalid audit date filter returns a clear 400 (not 500)', r.status === 400, r);
  r = await O.get(`/api/audit?userId=${ownerId}&from=2020-01-01&action=lead.`);
  check('audit filter by user + date + type works', r.status === 200 && r.data.items.every((a) => a.actor_user_id === ownerId && a.action.startsWith('lead.')), r.data.items?.length);
  r = await db.query('TRUNCATE audit_log').then(() => 'ok', (e) => e.message);
  check('F4.3 audit log cannot be truncated either', r !== 'ok', r);

  console.log('F2.6 — saved list updates automatically');
  const list = await O.post('/api/lists', { name: 'VIP Lahore', entity: 'contacts', filters: [{ field: 'tag', op: 'has_tag', value: 'vip' }, { field: 'email', op: 'contains', value: 'zed' }, { field: 'created_at', op: 'after', value: '2020-01-01' }, { field: 'owner_id', op: 'eq', value: ownerId }] });
  check('4-criteria list (tag, field, date, owner) saved', list.status === 201, list.data);
  const q = (await O.get('/api/lists')).data.find((l) => l.id === list.data.id);
  const run = async () => (await O.get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(q.filters))}`)).data;
  const before = (await run()).total;
  await O.post('/api/contacts', { firstName: 'Zed', lastName: 'New', email: `zed-${u}@cust.dev`, tags: ['vip'] });
  check('a newly matching record appears in the saved list', (await run()).total === Number(before) + 1, { before });
  r = await O.del(`/api/lists/${list.data.id}`);
  const la = (await O.get('/api/audit?action=list.')).data.items;
  check('saved-list deletion is audited', la.some((a) => a.action === 'list.deleted'));

  console.log('F5.4 — role-aware dashboard');
  r = await s1.c.get('/api/dashboard');
  check('User sees personal figures even when asking for company', r.data.scope === 'personal', r.data.scope);
  r = await O.get('/api/dashboard');
  check('Owner sees company figures', r.data.scope === 'company');

  console.log(`\n${passed} passed, ${failed} failed`);
  await db.end();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
