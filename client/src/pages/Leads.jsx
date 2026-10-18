// Leads list, lead detail (countdown, acknowledge, reassign, convert), recovery queue, escalations.
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { post, qs } from '../lib/api.js';
import { useApi, useAction, useApp } from '../lib/app.jsx';
import { ago, duration, fmtDateTime, fullName, SOURCE, AVAIL } from '../lib/format.js';
import { Avail, Badge, Button, Countdown, ErrorNotice, Field, LeadStatus, Loading, Modal, PageHeader, Pagination, Table } from '../components/ui.jsx';
import { CustomFieldInputs, NewLeadModal, NoteForm, Timeline } from '../components/shared.jsx';

export function Leads() {
  const [sp, setSp] = useSearchParams();
  const [showNew, setShowNew] = useState(false);
  const { can } = useApp();
  const params = Object.fromEntries(sp.entries());
  const { data, error, loading, reload } = useApi(`/leads${qs(params)}`, { live: ['leads'] });
  const nav = useNavigate();
  const set = (k, v) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); n.delete('page'); setSp(n); };
  const cols = [
    { key: 'title', label: 'Lead', render: (l) => <div><Link to={`/leads/${l.id}`} onClick={(e) => e.stopPropagation()}><strong>{l.title}</strong></Link><div className="tiny muted">{l.contact_name} · {l.phone || l.email || ''}</div></div> },
    { key: 'source', label: 'Source', render: (l) => <Badge tone="info" plain>{SOURCE[l.source]}</Badge> },
    { key: 'status', label: 'Status', render: (l) => <LeadStatus s={l.status} /> },
    { key: 'owner', label: 'Owner', render: (l) => l.owner_name || '—' },
    { key: 'deadline', label: 'Acknowledge', render: (l) => (l.status === 'assigned' ? <Countdown deadline={l.ack_deadline} serverNow={data.serverNow} /> : l.first_acknowledged_at ? <span className="small">Responded in {duration((new Date(l.first_acknowledged_at) - new Date(l.first_assigned_at)) / 1000)}</span> : '—') },
    { key: 'esc', label: 'Escalations', render: (l) => (l.escalation_count ? <Badge tone={l.escalation_count >= 2 ? 'danger' : 'warn'}>{l.escalation_count}×</Badge> : '0') },
    { key: 'created', label: 'Created', render: (l) => <span title={fmtDateTime(l.created_at)}>{ago(l.created_at)}</span> },
  ];
  return (
    <div>
      <PageHeader title="Leads" subtitle="Every lead has exactly one accountable owner. Unacknowledged leads escalate automatically.">
        {can('crm.create') && <button className="btn primary" onClick={() => setShowNew(true)}>+ New lead</button>}
      </PageHeader>
      <div className="row" style={{ marginBottom: 12 }}>
        <input className="search" type="search" placeholder="Search leads…" aria-label="Search leads" defaultValue={params.q || ''} onKeyDown={(e) => e.key === 'Enter' && set('q', e.target.value)} />
        <select aria-label="Status" style={{ width: 'auto' }} value={params.status || ''} onChange={(e) => set('status', e.target.value)}>
          <option value="">All statuses</option><option value="open">Open</option><option value="assigned">Awaiting acknowledgement</option><option value="acknowledged">Acknowledged</option><option value="converted">Converted</option><option value="closed">Closed</option>
        </select>
        <select aria-label="Source" style={{ width: 'auto' }} value={params.source || ''} onChange={(e) => set('source', e.target.value)}>
          <option value="">All sources</option>{Object.entries(SOURCE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select aria-label="Owner" style={{ width: 'auto' }} value={params.ownerId || ''} onChange={(e) => set('ownerId', e.target.value)}>
          <option value="">Any owner</option><option value="me">Mine</option>
        </select>
        {params.preset === 'new_today' && <span className="chip">Created today <button className="btn ghost sm" style={{ padding: 0, minHeight: 0 }} aria-label="Remove filter" onClick={() => set('preset', '')}>{'✕'}</button></span>}
        {loading && <span className="spinner" aria-label="Refreshing" />}
      </div>
      <ErrorNotice error={error} onRetry={reload} />
      {!data ? <Loading /> : (
        <>
          <Table columns={cols} rows={data.items} onRowClick={(l) => nav(`/leads/${l.id}`)} empty="No leads match. Share your web form link (Workspace page) or add one manually." caption="Leads" />
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => { const n = new URLSearchParams(sp); n.set('page', p); setSp(n); }} />
        </>
      )}
      {showNew && <NewLeadModal onClose={() => setShowNew(false)} />}
    </div>
  );
}

export function LeadDetail() {
  const { id } = useParams();
  const { me, can } = useApp();
  const { data, error, reload } = useApi(`/leads/${id}`, { live: ['leads', 'crm', 'messages'] });
  const { data: users } = useApi('/users');
  const { data: pipes } = useApi('/pipelines');
  const [run, busy] = useAction();
  const [reassign, setReassign] = useState(false);
  const [convert, setConvert] = useState(false);
  const [close, setClose] = useState(false);
  if (!data) return error ? <ErrorNotice error={error} onRetry={reload} /> : <Loading />;
  const l = data.lead;
  const mine = l.owner_id === me.user.id;
  const open = ['assigned', 'acknowledged'].includes(l.status);
  const windowTotal = l.escalation_level === 0 ? data.rules.ackWindowSeconds : data.rules.escalationLevels[l.escalation_level - 1]?.seconds;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <PageHeader title={l.title} subtitle={`${SOURCE[l.source]} lead · created ${fmtDateTime(l.created_at)}`}>
        <Link className="btn" to={`/contacts/${l.contact_id}`}>Open customer</Link>
      </PageHeader>
      <div className="split">
        <div className="stack">
          <section className="card" aria-labelledby="own-h">
            <div className="card-header"><h2 id="own-h">Ownership</h2><LeadStatus s={l.status} /></div>
            <dl className="kv">
              <dt>Owner</dt><dd><strong>{l.owner_name || '—'}</strong> {l.owner_availability && <Avail s={l.owner_availability} />}</dd>
              <dt>Assigned</dt><dd>{fmtDateTime(l.assigned_at)} ({ago(l.assigned_at)})</dd>
              <dt>Escalation level</dt><dd>{l.escalation_level} of {data.rules.escalationLevels.length} · escalated {l.escalation_count}×</dd>
              {l.first_acknowledged_at && <><dt>First response</dt><dd>{duration((new Date(l.first_acknowledged_at) - new Date(l.first_assigned_at)) / 1000)} after first assignment</dd></>}
            </dl>
            {l.status === 'assigned' && (
              <div className="stack" style={{ marginTop: 12 }}>
                {l.chain_exhausted
                  ? <div className="notice danger" role="alert">Escalation chain finished without acknowledgement — this lead is in the recovery queue.</div>
                  : <Countdown deadline={l.ack_deadline} serverNow={data.serverNow} total={windowTotal} />}
                {mine && <Button className="success big" busy={busy} onClick={() => run(() => post(`/leads/${l.id}/ack`).then(reload), { success: 'Acknowledged — the lead is yours' })}>{'✅'} Acknowledge</Button>}
                {!mine && <p className="small muted" style={{ margin: 0 }}>Only {l.owner_name} can acknowledge. Any recorded action by them (note, message, call, stage change, appointment) also counts.</p>}
              </div>
            )}
            {l.status === 'acknowledged' && ['on_leave', 'offline'].includes(l.owner_availability) && (
              <div className="notice warn" style={{ marginTop: 10 }}>The owner is {AVAIL[l.owner_availability]}. Workspace rule for acknowledged leads: <strong>{data.rules.acknowledgedOnAbsence === 'keep' ? 'they stay with the owner' : 'they are reassigned'}</strong>.</div>
            )}
            {open && (
              <div className="row" style={{ marginTop: 12 }}>
                {can('leads.reassign') && <button className="btn" onClick={() => setReassign(true)}>Reassign</button>}
                {can('crm.create') && <button className="btn" onClick={() => setConvert(true)}>Convert to opportunity</button>}
                {can('crm.edit') && <button className="btn" onClick={() => setClose(true)}>Close lead</button>}
              </div>
            )}
            {l.opportunity_id && <p style={{ marginTop: 10 }}><Link to={`/opportunities/${l.opportunity_id}`}>Open the opportunity →</Link></p>}
          </section>
          <section className="card" aria-labelledby="msg-h">
            <h2 id="msg-h">Customer</h2>
            <dl className="kv"><dt>Name</dt><dd>{fullName(l)}</dd><dt>Email</dt><dd>{l.email || '—'}</dd><dt>Phone</dt><dd>{l.phone || '—'}{l.opted_out && <> <Badge tone="danger">Opted out</Badge></>}</dd></dl>
            {l.message && <><hr /><div className="small muted">Their message</div><p style={{ whiteSpace: 'pre-wrap' }}>{l.message}</p></>}
          </section>
          <section className="card" aria-labelledby="act-h">
            <h2 id="act-h">Activity</h2>
            {can('crm.edit') && open && <><NoteForm onSubmit={(b) => post(`/leads/${l.id}/notes`, b).then(reload)} /><hr /></>}
            <Timeline items={data.activities} />
          </section>
        </div>
        <section className="card" aria-labelledby="hist-h">
          <h2 id="hist-h">Assignment history</h2>
          <ul className="timeline">
            {data.assignments.map((a) => (
              <li key={a.id}>
                <span className="tl-icon" aria-hidden>{a.kind === 'escalation' ? '⏫' : '👤'}</span>
                <div>
                  <div><Badge tone={a.kind === 'escalation' ? 'danger' : a.kind === 'manual' ? 'violet' : a.kind === 'absence' ? 'warn' : 'info'}>{a.kind}</Badge> {a.from_name ? `${a.from_name} → ` : ''}<strong>{a.to_name}</strong></div>
                  <div className="small">{a.reason}</div>
                  <div className="tiny muted">{fmtDateTime(a.created_at)} · {a.actor_name ? `by ${a.actor_name}` : 'by system'}{a.level ? ` · level ${a.level}` : ''}</div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
      {reassign && <ReassignModal lead={l} users={users} onClose={() => setReassign(false)} onDone={reload} />}
      {convert && <ConvertModal lead={l} pipes={pipes} onClose={() => setConvert(false)} />}
      {close && <CloseModal lead={l} onClose={() => setClose(false)} onDone={reload} />}
    </div>
  );
}

function ReassignModal({ lead, users, onClose, onDone }) {
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');
  const [run, busy] = useAction();
  const options = (users || []).filter((u) => u.active && !u.invite_pending && u.id !== lead.owner_id);
  return (
    <Modal title="Reassign lead" onClose={onClose}>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); const ok = await run(() => post(`/leads/${lead.id}/reassign`, { userId, reason: reason || undefined }), { success: 'Lead reassigned' }); if (ok) { onDone(); onClose(); } }}>
        <Field label="New owner">{(a) => <select {...a} value={userId} onChange={(e) => setUserId(e.target.value)} required><option value="">Choose…</option>{options.map((u) => <option key={u.id} value={u.id} disabled={['on_leave', 'offline'].includes(u.availability)}>{u.name} — {AVAIL[u.availability]} — {u.open_leads} open</option>)}</select>}</Field>
        <Field label="Reason (optional)">{(a) => <input {...a} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />}</Field>
        <p className="small muted">The new owner gets a fresh acknowledgement window. Manual reassignments are counted separately from escalations.</p>
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><Button type="submit" className="primary" busy={busy}>Reassign</Button></div>
      </form>
    </Modal>
  );
}

function ConvertModal({ lead, pipes, onClose }) {
  const nav = useNavigate();
  const { can } = useApp();
  const [f, setF] = useState({ pipelineId: pipes?.pipelines?.[0]?.id || '', title: lead.title, value: '', custom: {} });
  const [run, busy] = useAction();
  const pipe = pipes?.pipelines?.find((p) => p.id === f.pipelineId);
  const fields = (pipes?.fields || []).filter((x) => x.entity === 'opportunity' && (!x.pipeline_id || x.pipeline_id === f.pipelineId));
  return (
    <Modal title="Convert to opportunity" onClose={onClose} wide>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); const o = await run(() => post(`/leads/${lead.id}/convert`, { ...f, value: f.value === '' ? null : Number(f.value) }), { success: 'Opportunity created' }); if (o) nav(`/opportunities/${o.id}`); }}>
        <div className="form-grid">
          <Field label="Pipeline">{(a) => <select {...a} value={f.pipelineId} onChange={(e) => setF({ ...f, pipelineId: e.target.value, custom: {} })}>{(pipes?.pipelines || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}</Field>
          <Field label="Title">{(a) => <input {...a} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required />}</Field>
          {can('values.view') && <Field label="Value">{(a) => <input {...a} type="number" min="0" step="0.01" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />}</Field>}
          <CustomFieldInputs fields={fields} values={f.custom} onChange={(c) => setF({ ...f, custom: c })} />
        </div>
        {pipe && <p className="small muted">It will start in “{pipe.stages.find((s) => s.kind === 'open')?.name}”.</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><Button type="submit" className="primary" busy={busy}>Convert</Button></div>
      </form>
    </Modal>
  );
}

function CloseModal({ lead, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [run, busy] = useAction();
  return (
    <Modal title="Close lead" onClose={onClose}>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); const ok = await run(() => post(`/leads/${lead.id}/close`, { reason }), { success: 'Lead closed' }); if (ok) { onDone(); onClose(); } }}>
        <Field label="Reason" help="e.g. spam, not interested, duplicate">{(a) => <input {...a} value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={300} autoFocus />}</Field>
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><Button type="submit" className="danger" busy={busy}>Close lead</Button></div>
      </form>
    </Modal>
  );
}

const REASON = { unacknowledged: ['Unacknowledged beyond window', 'danger'], escalated: ['Escalated 2+ times', 'warn'], idle: ['No action for too long', 'violet'] };

export function Recovery() {
  const [sp] = useSearchParams();
  const { data, error, reload } = useApi(`/leads/recovery${qs({ scope: sp.get('scope') })}`, { live: ['leads'] });
  const nav = useNavigate();
  const { can } = useApp();
  return (
    <div>
      <PageHeader title="Recovery queue" subtitle="Leads that are overdue, escalated two or more times, or untouched for the configured idle period. Act on these first." />
      <ErrorNotice error={error} onRetry={reload} />
      {!data ? <Loading /> : (
        <Table caption="Recovery queue" rows={data.items} onRowClick={(l) => nav(`/leads/${l.id}`)} empty={'🎉 Nothing to recover — every lead is being handled.'} columns={[
          { key: 'title', label: 'Lead', render: (l) => <div><strong>{l.title}</strong><div className="tiny muted">{l.contact_name} · {SOURCE[l.source]}</div></div> },
          { key: 'reasons', label: 'Why it is here', render: (l) => <div className="row" style={{ gap: 4 }}>{l.reasons.map((r) => <Badge key={r} tone={REASON[r][1]}>{REASON[r][0]}</Badge>)}</div> },
          { key: 'owner', label: 'Owner', render: (l) => <span>{l.owner_name} {l.owner_availability && <Avail s={l.owner_availability} />}</span> },
          { key: 'last', label: 'Last action', render: (l) => ago(l.last_action_at) },
          { key: 'esc', label: 'Escalations', render: (l) => l.escalation_count },
          { key: 'act', label: '', render: (l) => <Link className="btn sm" to={`/leads/${l.id}`} onClick={(e) => e.stopPropagation()}>{can('leads.reassign') ? 'Open / reassign' : 'Open'}</Link> },
        ]} />
      )}
    </div>
  );
}

export function Escalations() {
  const [sp] = useSearchParams();
  const { data, error, reload } = useApi(`/leads/escalations${qs({ hours: 24, scope: sp.get('scope') })}`, { live: ['leads'] });
  const nav = useNavigate();
  return (
    <div>
      <PageHeader title="Escalations in the last 24 hours" subtitle="Automatic reassignments caused by an expired acknowledgement window (manual reassignments are not counted)." />
      <ErrorNotice error={error} onRetry={reload} />
      {!data ? <Loading /> : (
        <Table caption="Escalations" rows={data.items} onRowClick={(a) => nav(`/leads/${a.lead_id}`)} empty="No escalations in the last 24 hours." columns={[
          { key: 'time', label: 'When', render: (a) => fmtDateTime(a.created_at) },
          { key: 'lead', label: 'Lead', render: (a) => <strong>{a.title}</strong> },
          { key: 'from', label: 'Missed by', render: (a) => a.from_name || '—' },
          { key: 'to', label: 'Escalated to', render: (a) => a.to_name },
          { key: 'level', label: 'Level', render: (a) => a.level },
          { key: 'reason', label: 'Reason', render: (a) => <span className="small">{a.reason}</span> },
        ]} />
      )}
    </div>
  );
}
