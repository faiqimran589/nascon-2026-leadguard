// Team & invitations, roles & permissions matrix, assignment rules, audit log, workspace settings.
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, patch, post, put, qs } from '../lib/api.js';
import { useApi, useAction, useApp } from '../lib/app.jsx';
import { AVAIL, TIMEZONES, duration, fmtDateTime } from '../lib/format.js';
import { Avail, Badge, Button, Confirm, ErrorNotice, Field, Loading, Modal, PageHeader, Pagination, Table } from '../components/ui.jsx';

// ---------- Team ----------
export function Team() {
  const { me, can } = useApp();
  const { data: users, error, reload } = useApi('/users', { live: ['team', 'leads'] });
  const { data: roles } = useApi('/roles', { live: ['team'] });
  const [invite, setInvite] = useState(false);
  const [edit, setEdit] = useState(null);
  const [link, setLink] = useState(null);
  const [run] = useAction();
  const admin = can('users.manage');
  const canSetOthers = can('leads.reassign') || can('users.manage');
  const setStatus = (u, v) => run(() => patch(`/users/${u.id}/availability`, { availability: v }).then((r) => { reload(); return r; }), { success: (r) => `${u.name} is now ${AVAIL[v]}${r.moved ? ` — ${r.moved.unacknowledged + r.moved.acknowledgedMoved} lead(s) reassigned` : ''}` });
  return (
    <div>
      <PageHeader title="Team" subtitle="Availability decides who receives new leads. Only Available employees below the open-lead limit get leads.">
        {admin && <button className="btn primary" onClick={() => setInvite(true)}>+ Invite user</button>}
      </PageHeader>
      {link && <div className="notice ok" style={{ marginBottom: 12 }} role="status"><div style={{ flex: 1 }}>Invitation link (valid 7 days) — send it to the person: <div className="mono">{link}</div></div><button className="btn sm" onClick={() => navigator.clipboard?.writeText(link)}>Copy</button></div>}
      <ErrorNotice error={error} onRetry={reload} />
      {!users ? <Loading /> : (
        <Table caption="Team" rows={users} empty="No users." columns={[
          { key: 'name', label: 'Name', render: (u) => <div><strong>{u.name}</strong>{u.id === me.user.id && <span className="muted"> (you)</span>}<div className="tiny muted">{u.email || ''}</div></div> },
          { key: 'level', label: 'Level / role', render: (u) => <div><Badge tone={u.level === 'owner' ? 'violet' : u.level === 'admin' ? 'primary' : 'muted'} plain>{u.level}</Badge> <span className="small">{u.level === 'owner' ? 'all permissions' : u.role_name}</span></div> },
          { key: 'status', label: 'Availability', render: (u) => (!u.active ? <Badge tone="muted">Deactivated</Badge> : u.invite_pending ? <Badge tone="warn">Invite pending</Badge> : (canSetOthers || u.id === me.user.id) ? (
            <select aria-label={`Availability of ${u.name}`} value={u.availability} onChange={(e) => setStatus(u, e.target.value)} style={{ width: 'auto' }} onClick={(e) => e.stopPropagation()}>{Object.entries(AVAIL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          ) : <Avail s={u.availability} />) },
          { key: 'open', label: 'Open leads', render: (u) => u.open_leads },
          { key: 'cal', label: 'Calendar', render: (u) => (u.calendar_status === 'connected' ? <Badge tone="ok">Connected</Badge> : u.calendar_status === 'needs_reconnect' ? <Badge tone="danger">Needs reconnection</Badge> : <Badge tone="muted">Not connected</Badge>) },
          ...(admin ? [{ key: 'tg', label: 'Telegram', render: (u) => (u.telegram_linked ? <Badge tone="ok">Linked</Badge> : <Badge tone="muted">Not linked</Badge>) }] : []),
          ...(admin ? [{ key: 'act', label: '', render: (u) => u.level !== 'owner' && u.id !== me.user.id && (
            <div className="row" style={{ gap: 4 }}>
              <button className="btn sm" onClick={() => setEdit(u)}>Edit</button>
              {u.invite_pending && <button className="btn sm" onClick={() => run(() => post(`/users/${u.id}/reinvite`).then((r) => setLink(r.inviteUrl)))}>New link</button>}
            </div>) }] : []),
        ]} />
      )}
      {invite && <InviteModal roles={roles || []} onClose={() => setInvite(false)} onDone={(r) => { setLink(r.inviteUrl); reload(); }} />}
      {edit && <EditUserModal user={edit} roles={roles || []} onClose={() => setEdit(null)} onDone={reload} />}
    </div>
  );
}

function InviteModal({ roles, onClose, onDone }) {
  const { me } = useApp();
  const [f, setF] = useState({ name: '', email: '', level: 'user', roleId: roles.find((r) => r.name === 'Sales')?.id || roles[0]?.id || '' });
  const [run, busy] = useAction();
  return (
    <Modal title="Invite a user" onClose={onClose}>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); const r = await run(() => post('/users/invite', f), { success: 'Invitation created' }); if (r) { onDone(r); onClose(); } }}>
        <Field label="Name">{(a) => <input {...a} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoFocus />}</Field>
        <Field label="Email">{(a) => <input {...a} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />}</Field>
        <Field label="Base level" help="Owner > Admin > User. Only the Owner can create Admins.">{(a) => <select {...a} value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })}><option value="user">User</option>{me.user.level === 'owner' && <option value="admin">Admin</option>}</select>}</Field>
        <Field label="Role (permissions)">{(a) => <select {...a} value={f.roleId} onChange={(e) => setF({ ...f, roleId: e.target.value })}>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>}</Field>
        <p className="small muted">You will get a link to send to them (no email service needed).</p>
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><Button type="submit" className="primary" busy={busy}>Create invitation</Button></div>
      </form>
    </Modal>
  );
}

function EditUserModal({ user, roles, onClose, onDone }) {
  const { me } = useApp();
  const [f, setF] = useState({ level: user.level, roleId: user.role_id, active: user.active });
  const [run, busy] = useAction();
  return (
    <Modal title={`Edit ${user.name}`} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        const body = { roleId: f.roleId, active: f.active };
        if (me.user.level === 'owner') body.level = f.level;
        const r = await run(() => patch(`/users/${user.id}`, body), { success: (x) => `Saved${x.moved ? ` — ${x.moved.unacknowledged + x.moved.acknowledgedMoved} lead(s) reassigned` : ''}` });
        if (r) { onDone(); onClose(); }
      }}>
        {me.user.level === 'owner' && <Field label="Base level">{(a) => <select {...a} value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })}><option value="user">User</option><option value="admin">Admin</option></select>}</Field>}
        <Field label="Role">{(a) => <select {...a} value={f.roleId || ''} onChange={(e) => setF({ ...f, roleId: e.target.value })}>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>}</Field>
        <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active (unticking logs them out and reassigns their open leads)</label>
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><Button type="submit" className="primary" busy={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

// ---------- Roles & permissions (F1.3) ----------
export function Roles() {
  const { data: roles, reload, error } = useApi('/roles', { live: ['team'] });
  const { data: perms } = useApi('/permissions');
  const [draft, setDraft] = useState({});
  const [name, setName] = useState('');
  const [run, busy] = useAction();
  useEffect(() => { if (roles) setDraft(Object.fromEntries(roles.map((r) => [r.id, new Set(r.permissions)]))); }, [roles]);
  if (!roles || !perms) return error ? <ErrorNotice error={error} /> : <Loading />;
  const toggle = (rid, p) => setDraft((d) => { const s = new Set(d[rid]); if (s.has(p)) s.delete(p); else s.add(p); return { ...d, [rid]: s }; });
  const dirty = roles.filter((r) => [...(draft[r.id] || [])].sort().join() !== [...r.permissions].sort().join());
  const groups = [...new Set(perms.map((p) => p.group))];
  return (
    <div>
      <PageHeader title="Roles & permissions" subtitle="Permissions are not tied to role names. A “Manager” is just a role with reassign + company-view permissions. The Owner always has every permission.">
        <Button className="primary" disabled={!dirty.length} busy={busy} onClick={() => run(async () => { for (const r of dirty) await patch(`/roles/${r.id}`, { permissions: [...draft[r.id]] }); reload(); }, { success: 'Permissions saved (recorded in the audit log)' })}>Save changes{dirty.length ? ` (${dirty.length})` : ''}</Button>
      </PageHeader>
      <div className="table-wrap" style={{ overflowX: 'auto' }}>
        <table className="table perm-table">
          <caption className="sr-only">Permission matrix</caption>
          <thead><tr><th scope="col">Permission</th>{roles.map((r) => <th key={r.id} scope="col">{r.name}<div className="tiny">{r.user_count} user(s)</div></th>)}</tr></thead>
          <tbody>
            {groups.map((g) => [
              <tr key={g}><td colSpan={roles.length + 1} style={{ background: 'var(--surface-2)', fontWeight: 700 }}>{g}</td></tr>,
              ...perms.filter((p) => p.group === g).map((p) => (
                <tr key={p.key}>
                  <td><div>{p.label}</div><div className="tiny muted mono">{p.key}</div></td>
                  {roles.map((r) => <td key={r.id}><input type="checkbox" aria-label={`${r.name}: ${p.label}`} checked={!!draft[r.id]?.has(p.key)} onChange={() => toggle(r.id, p.key)} /></td>)}
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h2>Add a role</h2>
        <form className="row" onSubmit={async (e) => { e.preventDefault(); const ok = await run(() => post('/roles', { name, permissions: ['crm.view'] }), { success: 'Role created' }); if (ok) { setName(''); reload(); } }}>
          <input aria-label="Role name" placeholder="e.g. Team lead" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 260 }} required />
          <Button type="submit" busy={busy}>Create</Button>
        </form>
        <div className="row" style={{ marginTop: 10 }}>{roles.filter((r) => !r.is_system).map((r) => <button key={r.id} className="btn sm" onClick={() => run(() => api(`/roles/${r.id}`, { method: 'DELETE' }).then(reload), { success: 'Role deleted' })}>Delete “{r.name}”</button>)}</div>
      </div>
    </div>
  );
}

// ---------- Assignment rules (F3.3, F3.5, F3.6) ----------
export function Rules() {
  const { can } = useApp();
  const { data: rules, reload } = useApi('/rules', { live: ['config'] });
  const { data: users } = useApi('/users');
  const [f, setF] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => {
    if (rules) setF({ maxOpenLeads: rules.max_open_leads, ackWindowSeconds: rules.ack_window_seconds, escalationLevels: rules.escalation_levels, backupUserId: rules.backup_user_id || '', managerUserId: rules.manager_user_id || '', idleSeconds: rules.idle_seconds, acknowledgedOnAbsence: rules.acknowledged_on_absence });
  }, [rules]);
  if (!f) return <Loading />;
  const ro = !can('rules.manage');
  const active = (users || []).filter((u) => u.active && !u.invite_pending);
  const setLevel = (i, patchObj) => setF({ ...f, escalationLevels: f.escalationLevels.map((l, j) => (j === i ? { ...l, ...patchObj } : l)) });
  const demo = () => setF({ ...f, ackWindowSeconds: 30, escalationLevels: [{ type: 'next_available', seconds: 30 }, { type: 'backup', seconds: 30 }, { type: 'manager', seconds: 60 }], idleSeconds: 300 });
  const save = () => run(() => put('/rules', { ...f, backupUserId: f.backupUserId || null, managerUserId: f.managerUserId || null, maxOpenLeads: Number(f.maxOpenLeads), ackWindowSeconds: Number(f.ackWindowSeconds), idleSeconds: Number(f.idleSeconds), escalationLevels: f.escalationLevels.map((l) => ({ ...l, seconds: Number(l.seconds) })) }).then(reload), { success: 'Rules saved (recorded in the audit log)' });
  const TYPE = { next_available: 'Next available employee (round-robin)', backup: 'Designated backup', manager: 'Manager (falls back to Owner)' };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <PageHeader title="Assignment & escalation rules" subtitle="All timers are in seconds so you can watch escalation happen live during a demo.">
        {!ro && <button className="btn" onClick={demo}>Use demo timings (30s)</button>}
        {!ro && <Button className="primary" busy={busy} onClick={save}>Save rules</Button>}
      </PageHeader>
      {ro && <div className="notice info">You can view the rules. Changing them requires the “Manage assignment rules” permission.</div>}
      <fieldset disabled={ro} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
        <section className="card">
          <h2>Distribution</h2>
          <p className="muted small">New leads go round-robin to employees whose status is <strong>Available</strong> and who have fewer open leads than the limit. Busy, On leave and Offline employees never receive leads automatically. If nobody is available, the lead goes to the backup, then the manager, then the Owner — a lead is never left without an owner.</p>
          <div className="form-grid">
            <Field label="Maximum open leads per employee">{(a) => <input {...a} type="number" min="1" value={f.maxOpenLeads} onChange={(e) => setF({ ...f, maxOpenLeads: e.target.value })} />}</Field>
            <Field label="Acknowledgement window (seconds)" help={duration(Number(f.ackWindowSeconds))}>{(a) => <input {...a} type="number" min="3" value={f.ackWindowSeconds} onChange={(e) => setF({ ...f, ackWindowSeconds: e.target.value })} />}</Field>
            <Field label="Designated backup">{(a) => <select {...a} value={f.backupUserId} onChange={(e) => setF({ ...f, backupUserId: e.target.value })}><option value="">— none —</option>{active.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}</Field>
            <Field label="Manager">{(a) => <select {...a} value={f.managerUserId} onChange={(e) => setF({ ...f, managerUserId: e.target.value })}><option value="">— Owner —</option>{active.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}</Field>
          </div>
        </section>
        <section className="card">
          <h2>Escalation chain</h2>
          <p className="muted small">When a window expires without acknowledgement, the lead moves to the next level automatically, and the new owner is alerted on Telegram. Levels whose person is unavailable are skipped.</p>
          <ol className="stack" style={{ paddingLeft: 18 }}>
            {f.escalationLevels.map((l, i) => (
              <li key={i}>
                <div className="row">
                  <select aria-label={`Level ${i + 1} target`} value={l.type} onChange={(e) => setLevel(i, { type: e.target.value })} style={{ flex: '2 1 220px' }}>{Object.entries(TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                  <label className="row" style={{ flex: '1 1 160px', gap: 6 }}><span className="small">has</span><input aria-label={`Level ${i + 1} seconds`} type="number" min="3" value={l.seconds} onChange={(e) => setLevel(i, { seconds: e.target.value })} style={{ width: 100 }} /><span className="small">seconds</span></label>
                  <button type="button" className="btn ghost sm" aria-label={`Remove level ${i + 1}`} disabled={f.escalationLevels.length <= 1} onClick={() => setF({ ...f, escalationLevels: f.escalationLevels.filter((_, j) => j !== i) })}>{'✕'}</button>
                </div>
              </li>
            ))}
          </ol>
          {f.escalationLevels.length < 6 && <button type="button" className="btn sm" onClick={() => setF({ ...f, escalationLevels: [...f.escalationLevels, { type: 'manager', seconds: 60 }] })}>+ Add level</button>}
        </section>
        <section className="card">
          <h2>Absence & recovery</h2>
          <div className="form-grid">
            <Field label="When an employee goes On leave / Offline, their ACKNOWLEDGED leads…" help="Unacknowledged leads are always reassigned immediately.">{(a) => <select {...a} value={f.acknowledgedOnAbsence} onChange={(e) => setF({ ...f, acknowledgedOnAbsence: e.target.value })}><option value="reassign">are reassigned (new owner must acknowledge)</option><option value="keep">stay with them (shown as owner absent)</option></select>}</Field>
            <Field label="Idle period before a lead enters the recovery queue (seconds)" help={duration(Number(f.idleSeconds))}>{(a) => <input {...a} type="number" min="10" value={f.idleSeconds} onChange={(e) => setF({ ...f, idleSeconds: e.target.value })} />}</Field>
          </div>
        </section>
      </fieldset>
    </div>
  );
}

// ---------- Audit log (F4) ----------
export function Audit() {
  const [sp, setSp] = useSearchParams();
  const params = Object.fromEntries(sp.entries());
  const { data, error, reload } = useApi(`/audit${qs(params)}`, { live: ['leads', 'team', 'config', 'integrations'] });
  const { data: users } = useApi('/users');
  const set = (k, v) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); n.delete('page'); setSp(n); };
  const show = (v) => (v ? <pre className="tiny mono" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(v, null, 1)}</pre> : '—');
  return (
    <div>
      <PageHeader title="Audit log" subtitle="Read-only history of important actions. Entries cannot be edited or deleted — not from any screen, endpoint, or directly in the database." />
      <div className="row" style={{ marginBottom: 12 }}>
        <select aria-label="Event type" style={{ width: 'auto' }} value={params.action || ''} onChange={(e) => set('action', e.target.value)}>
          <option value="">All event types</option>{(data?.groups || []).map((g) => <option key={g} value={`${g}.`}>{g}</option>)}
        </select>
        <select aria-label="User" style={{ width: 'auto' }} value={params.userId || ''} onChange={(e) => set('userId', e.target.value)}>
          <option value="">Any actor</option><option value="system">System</option>{(users || []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <label className="row small" style={{ gap: 4 }}>From <input type="date" value={params.from || ''} onChange={(e) => set('from', e.target.value)} style={{ width: 'auto' }} /></label>
        <label className="row small" style={{ gap: 4 }}>To <input type="date" value={params.to || ''} onChange={(e) => set('to', e.target.value)} style={{ width: 'auto' }} /></label>
      </div>
      <ErrorNotice error={error} onRetry={reload} />
      {!data ? <Loading /> : (
        <>
          <Table caption="Audit entries" rows={data.items} empty="No entries match." columns={[
            { key: 'time', label: 'Time', render: (a) => <span className="nowrap">{fmtDateTime(a.created_at, { year: true, fmt: { second: '2-digit' } })}</span> },
            { key: 'actor', label: 'Actor', render: (a) => a.actor_user_id ? a.actor_label : <Badge tone="muted" plain>System</Badge> },
            { key: 'action', label: 'Event', render: (a) => <span className="mono">{a.action}</span> },
            { key: 'target', label: 'Target', render: (a) => <span>{a.target_type}{a.target_label ? `: ${a.target_label}` : ''}</span> },
            { key: 'before', label: 'Before', render: (a) => show(a.before) },
            { key: 'after', label: 'After', render: (a) => show(a.after) },
          ]} />
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => set('page', String(p))} />
        </>
      )}
    </div>
  );
}

// ---------- Workspace settings + web form link ----------
export function Workspace() {
  const { me, refreshMe, can } = useApp();
  const [f, setF] = useState({ name: me.workspace.name, timezone: me.workspace.timezone, defaultCurrency: me.workspace.defaultCurrency });
  const [run, busy] = useAction();
  const formUrl = `${window.location.origin}/form/${me.workspace.formToken}`;
  const isAdmin = ['owner', 'admin'].includes(me.user.level);
  return (
    <div className="stack" style={{ gap: 16 }}>
      <PageHeader title="Workspace & web form" />
      <section className="card">
        <h2>Public lead form</h2>
        <p className="muted small">Share this link or put it behind a “Contact us” button. Every submission becomes a lead with source “Web form” and is assigned instantly.</p>
        <div className="row"><span className="mono" style={{ flex: 1 }}>{formUrl}</span><button className="btn sm" onClick={() => navigator.clipboard?.writeText(formUrl)}>Copy</button><a className="btn sm" href={formUrl} target="_blank" rel="noreferrer">Open</a></div>
        <p className="tiny muted" style={{ marginTop: 8 }}>Embed: <span className="mono">{`<iframe src="${formUrl}" width="480" height="640" style="border:0"></iframe>`}</span></p>
      </section>
      <section className="card">
        <h2>Settings</h2>
        <form className="form-grid" onSubmit={async (e) => { e.preventDefault(); const ok = await run(() => patch('/workspace', f), { success: 'Workspace saved' }); if (ok) refreshMe(); }}>
          <Field label="Company name">{(a) => <input {...a} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} disabled={!isAdmin} />}</Field>
          <Field label="Default time zone" help="Used for “today” and “this month” figures unless a user sets their own.">{(a) => <select {...a} value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} disabled={!isAdmin}>{TIMEZONES.map((z) => <option key={z}>{z}</option>)}</select>}</Field>
          <Field label="Currency" help="Opportunity values and pipeline totals use this currency.">{(a) => <select {...a} value={f.defaultCurrency} onChange={(e) => setF({ ...f, defaultCurrency: e.target.value })} disabled={!isAdmin}>{['usd', 'pkr', 'eur', 'gbp', 'aed', 'sar'].map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}</select>}</Field>
          {isAdmin && <div className="full row end"><Button type="submit" className="primary" busy={busy}>Save</Button></div>}
        </form>
      </section>
      {can('pipeline.manage') && <p><Link to="/settings/pipelines">Pipelines, stages & custom fields →</Link></p>}
    </div>
  );
}
