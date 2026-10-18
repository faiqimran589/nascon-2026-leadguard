// Domain components shared by several pages.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, get, post, qs } from '../lib/api.js';
import { useApi, useAction, useApp, useLive } from '../lib/app.jsx';
import { ago, fmtDateTime, fmtTime, toLocalInput, userTimeZone, TIMEZONES, cents } from '../lib/format.js';
import { Button, Field, Modal, MsgStatus, ICON, Loading, ErrorNotice, Badge } from './ui.jsx';

// ---------- Custom fields ----------
export function CustomFieldInputs({ fields, values, onChange, highlight = [] }) {
  if (!fields?.length) return null;
  const set = (k, v) => onChange({ ...values, [k]: v });
  return fields.map((f) => (
    <Field key={f.key} label={f.label} error={highlight.includes(f.key) ? 'Required for this stage' : undefined}>
      {(a) => {
        const v = values?.[f.key];
        if (f.type === 'checkbox') return <label className="check"><input type="checkbox" {...a} checked={v === true} onChange={(e) => set(f.key, e.target.checked)} /> Yes</label>;
        if (f.type === 'dropdown') return <select {...a} value={v ?? ''} onChange={(e) => set(f.key, e.target.value || null)}><option value="">—</option>{f.options.map((o) => <option key={o}>{o}</option>)}</select>;
        if (f.type === 'number') return <input {...a} type="number" step="any" value={v ?? ''} onChange={(e) => set(f.key, e.target.value === '' ? null : Number(e.target.value))} />;
        if (f.type === 'date') return <input {...a} type="date" value={v ?? ''} onChange={(e) => set(f.key, e.target.value || null)} />;
        return <input {...a} value={v ?? ''} onChange={(e) => set(f.key, e.target.value)} maxLength={2000} />;
      }}
    </Field>
  ));
}

export function CustomFieldValues({ fields, values }) {
  if (!fields?.length) return null;
  return fields.map((f) => {
    const v = values?.[f.key];
    return (
      <div key={f.key} style={{ display: 'contents' }}>
        <dt>{f.label}</dt>
        <dd>{v === undefined || v === null || v === '' ? <span className="muted">—</span> : f.type === 'checkbox' ? (v ? 'Yes' : 'No') : String(v)}</dd>
      </div>
    );
  });
}

// ---------- Activity timeline (F2.7) ----------
export function Timeline({ items }) {
  if (!items?.length) return <p className="muted">No activity yet.</p>;
  return (
    <ul className="timeline">
      {items.map((a) => (
        <li key={a.id}>
          <span className="tl-icon" aria-hidden>{ICON[a.type] || '•'}</span>
          <div>
            <div className="wrap-any" style={{ whiteSpace: 'pre-wrap' }}>{a.body}</div>
            <div className="meta">{a.type.replace(/_/g, ' ')} · {a.actor_name || 'System'} · <time dateTime={a.created_at} title={fmtDateTime(a.created_at, { year: true })}>{fmtDateTime(a.created_at)}</time></div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function NoteForm({ onSubmit }) {
  const [body, setBody] = useState('');
  const [type, setType] = useState('note');
  const [run, busy] = useAction();
  return (
    <form className="stack" onSubmit={async (e) => { e.preventDefault(); if (!body.trim()) return; const ok = await run(() => onSubmit({ body, type }), { success: type === 'call' ? 'Call logged' : 'Note added' }); if (ok !== undefined) setBody(''); }}>
      <Field label="Add a note or log a call">{(a) => <textarea {...a} value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} placeholder="What happened?" />}</Field>
      <div className="row">
        <select aria-label="Entry type" value={type} onChange={(e) => setType(e.target.value)} style={{ width: 'auto' }}><option value="note">Note</option><option value="call">Call log</option></select>
        <Button type="submit" className="primary" busy={busy} disabled={!body.trim()}>Save</Button>
      </div>
    </form>
  );
}

// ---------- Filter builder (F2.6) ----------
export function FilterBuilder({ entity, pipelineId, filters, onApply, onSave }) {
  const { data: catalog } = useApi(`/${entity}/filter-fields${qs({ pipelineId })}`);
  const { data: users } = useApi('/users');
  const { data: pipes } = useApi('/pipelines');
  const [rows, setRows] = useState(filters.length ? filters : []);
  const [naming, setNaming] = useState(null);
  useEffect(() => setRows(filters), [filters]);
  const stages = useMemo(() => (pipes?.pipelines || []).flatMap((p) => p.stages.map((s) => ({ ...s, label: `${p.name} / ${s.name}` }))), [pipes]);
  if (!catalog) return null;
  const def = (k) => catalog.find((c) => c.key === k);
  const update = (i, patch) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const valueInput = (r, i) => {
    const d = def(r.field);
    if (!d || ['is_empty', 'not_empty', 'is_true', 'is_false'].includes(r.op)) return null;
    const common = { 'aria-label': 'Value', value: r.value ?? '', onChange: (e) => update(i, { value: e.target.value }) };
    if (r.field === 'owner_id') return <select {...common}><option value="">Choose…</option><option value="me">Me</option>{(users || []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>;
    if (r.field === 'stage_id') return <select {...common}><option value="">Choose…</option>{stages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>;
    if (r.field === 'pipeline_id') return <select {...common}><option value="">Choose…</option>{(pipes?.pipelines || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>;
    if (r.field === 'stage_kind') return <select {...common}><option value="">Choose…</option><option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option></select>;
    if (r.field === 'source') return <select {...common}><option value="">Choose…</option><option value="web_form">Web form</option><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option><option value="manual">Manual</option></select>;
    if (d.options?.length) return <select {...common}><option value="">Choose…</option>{d.options.map((o) => <option key={o}>{o}</option>)}</select>;
    if (d.type === 'date' && r.op !== 'last_days') return <input type="date" {...common} />;
    if (d.type === 'number' || r.op === 'last_days') return <input type="number" {...common} placeholder={r.op === 'last_days' ? 'days' : ''} />;
    return <input {...common} placeholder={r.field === 'tag' ? 'tag name' : 'value'} />;
  };
  const OP_LABEL = { eq: 'is', neq: 'is not', contains: 'contains', gt: '>', gte: '≥', lt: '<', lte: '≤', on: 'on', before: 'before', after: 'after', last_days: 'in last N days', is_empty: 'is empty', not_empty: 'is not empty', is_true: 'is checked', is_false: 'is not checked', has_tag: 'has tag', not_tag: 'does not have tag' };
  return (
    <div className="card stack" style={{ padding: 12 }}>
      {rows.length === 0 && <p className="muted small" style={{ margin: 0 }}>No filters. Add criteria such as owner, stage, tag, date or a custom field.</p>}
      {rows.map((r, i) => {
        const d = def(r.field);
        return (
          <div key={i} className="row" style={{ alignItems: 'stretch' }}>
            <select aria-label="Field" style={{ flex: '1 1 160px' }} value={r.field} onChange={(e) => { const nd = def(e.target.value); update(i, { field: e.target.value, op: nd.ops[0], value: '' }); }}>
              {catalog.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
            <select aria-label="Condition" style={{ flex: '1 1 130px' }} value={r.op} onChange={(e) => update(i, { op: e.target.value })}>
              {(d?.ops || []).map((o) => <option key={o} value={o}>{OP_LABEL[o] || o}</option>)}
            </select>
            <div style={{ flex: '2 1 160px' }}>{valueInput(r, i)}</div>
            <button className="btn ghost sm" aria-label="Remove criterion" onClick={() => setRows(rows.filter((_, j) => j !== i))}>{'✕'}</button>
          </div>
        );
      })}
      <div className="row">
        <button className="btn sm" onClick={() => setRows([...rows, { field: catalog[0].key, op: catalog[0].ops[0], value: '' }])}>+ Add criterion</button>
        <span style={{ flex: 1 }} />
        {onSave && rows.length > 0 && naming === null && <button className="btn sm" onClick={() => setNaming('')}>Save as list</button>}
        {naming !== null && (
          <span className="row" style={{ gap: 6 }}>
            <input aria-label="List name" placeholder="List name" value={naming} onChange={(e) => setNaming(e.target.value)} style={{ width: 180 }} autoFocus />
            <button className="btn sm" disabled={!naming.trim()} onClick={() => { onSave(rows, naming.trim()); setNaming(null); }}>Save</button>
            <button className="btn sm ghost" onClick={() => setNaming(null)}>Cancel</button>
          </span>
        )}
        <button className="btn sm primary" onClick={() => onApply(rows)}>Apply filters</button>
      </div>
    </div>
  );
}

export function SavedLists({ entity, onPick, activeId }) {
  const { data, reload } = useApi('/lists');
  const [run] = useAction();
  const lists = (data || []).filter((l) => l.entity === entity);
  if (!lists.length) return null;
  return (
    <div className="row" aria-label="Saved lists">
      <span className="muted small">Saved lists:</span>
      {lists.map((l) => (
        <span key={l.id} className="chip">
          <button className="btn ghost sm" style={{ padding: '0 4px', minHeight: 0, fontWeight: activeId === l.id ? 800 : 600 }} onClick={() => onPick(l)}>{l.name}</button>
          <button className="btn ghost sm" style={{ padding: 0, minHeight: 0 }} aria-label={`Delete list ${l.name}`} onClick={() => run(async () => { await api(`/lists/${l.id}`, { method: 'DELETE' }); reload(); })}>{'✕'}</button>
        </span>
      ))}
    </div>
  );
}

// ---------- Conversation (I1) ----------
export function Conversation({ conversationId, contactId, optedOut, ownerName, compact }) {
  const { data, error, reload } = useApi(conversationId ? `/conversations/${conversationId}` : null, { live: ['messages'] });
  const [body, setBody] = useState('');
  const [run, busy] = useAction();
  const end = useRef(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [data?.messages?.length]);
  const msgs = data?.messages || [];
  const opted = optedOut ?? data?.conversation?.opted_out;
  const send = async (e) => {
    e.preventDefault();
    const m = await run(() => post(`/contacts/${contactId || data.conversation.contact_id}/messages`, { body }));
    if (m) { setBody(''); reload(); if (m.status === 'failed') run(() => Promise.reject(new Error(`Message failed: ${m.error_message}`))); }
  };
  return (
    <div>
      {data?.conversation && !compact && <p className="muted small">Assigned employee: <strong>{data.conversation.owner_name || ownerName || 'Unassigned'}</strong> · Channel: {data.conversation.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'}</p>}
      <ErrorNotice error={error} />
      <div className="chat" aria-live="polite" aria-label="Messages">
        {!conversationId && <p className="muted small">No messages yet. Send the first one below.</p>}
        {msgs.map((m) => (
          <div key={m.id} className={`msg ${m.direction === 'inbound' ? 'in' : 'out'}`}>
            <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
            <div className="meta">
              <span>{m.direction === 'inbound' ? 'Customer' : (m.sent_by_name || 'You')}</span>·<time dateTime={m.created_at}>{fmtDateTime(m.created_at)}</time>
              {m.direction === 'outbound' && <MsgStatus s={m.status} />}
            </div>
            {m.error_message && <div className="small" style={{ color: 'var(--danger)', marginTop: 4 }} role="note">{m.error_message}</div>}
            {m.direction === 'outbound' && ['failed', 'undelivered'].includes(m.status) && (
              <button className="btn sm" style={{ marginTop: 6 }} onClick={() => run(() => post(`/messages/${m.id}/retry`).then(reload), { success: 'Retrying…' })}>Retry</button>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
      {opted ? (
        <div className="notice warn" style={{ marginTop: 10 }} role="note">{'🚫'} This contact opted out of messages (replied STOP or was marked opted-out), so messaging is disabled. They can opt back in by replying START.</div>
      ) : (
        <form className="composer" onSubmit={send}>
          <label htmlFor={`compose-${contactId || conversationId}`} className="sr-only">Message</label>
          <textarea id={`compose-${contactId || conversationId}`} value={body} onChange={(e) => setBody(e.target.value)} maxLength={1600} placeholder="Type a reply…" onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && body.trim()) send(e); }} />
          <Button type="submit" className="primary" busy={busy} disabled={!body.trim()}>Send</Button>
        </form>
      )}
    </div>
  );
}

// ---------- New lead (manual intake, F3.1) ----------
export function NewLeadModal({ onClose }) {
  const nav = useNavigate();
  const [f, setF] = useState({ firstName: '', lastName: '', email: '', phone: '', message: '' });
  const [run, busy] = useAction();
  const [err, setErr] = useState({});
  const submit = async (e) => {
    e.preventDefault();
    setErr({});
    const lead = await run(() => post('/leads', f), { success: (l) => `Lead created and assigned`, onError: (x) => { if (x.data?.fields) { setErr(x.data.fields); } } });
    if (lead) { onClose(); nav(`/leads/${lead.id}`); }
  };
  const bind = (k) => ({ value: f[k], onChange: (e) => setF({ ...f, [k]: e.target.value }) });
  return (
    <Modal title="New lead (manual entry)" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <div className="form-grid">
          <Field label="First name *" error={err.firstName || err._}>{(a) => <input {...a} {...bind('firstName')} required autoFocus />}</Field>
          <Field label="Last name">{(a) => <input {...a} {...bind('lastName')} />}</Field>
          <Field label="Email" error={err.email}>{(a) => <input {...a} type="email" {...bind('email')} />}</Field>
          <Field label="Phone" help="International format, e.g. +923001234567" error={err.phone}>{(a) => <input {...a} type="tel" {...bind('phone')} />}</Field>
          <Field label="Message / notes" className="full">{(a) => <textarea {...a} {...bind('message')} />}</Field>
        </div>
        <p className="muted small">The lead is assigned automatically by your round-robin rules. Existing contacts are matched by email or phone.</p>
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><Button type="submit" className="primary" busy={busy}>Create lead</Button></div>
      </form>
    </Modal>
  );
}

// ---------- Payment request (I2.1) ----------
export function PaymentModal({ opportunity, onClose, onDone }) {
  const { me } = useApp();
  const [f, setF] = useState({ amount: opportunity.value || '', currency: opportunity.currency || me.workspace.defaultCurrency || 'usd', description: opportunity.title, expiresInMinutes: 60 });
  const [run, busy] = useAction();
  const submit = async (e) => {
    e.preventDefault();
    const p = await run(() => post(`/opportunities/${opportunity.id}/payments`, { ...f, amount: Number(f.amount), expiresInMinutes: Number(f.expiresInMinutes) }), { success: 'Payment link created' });
    if (p) { onDone?.(p); onClose(); }
  };
  return (
    <Modal title="Request a payment" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <div className="form-grid">
          <Field label="Amount *">{(a) => <input {...a} type="number" min="0.5" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required autoFocus />}</Field>
          <Field label="Currency">{(a) => <select {...a} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>{['usd', 'pkr', 'eur', 'gbp', 'aed', 'sar'].map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}</select>}</Field>
          <Field label="Description" className="full">{(a) => <input {...a} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={200} />}</Field>
          <Field label="Link expires after">{(a) => <select {...a} value={f.expiresInMinutes} onChange={(e) => setF({ ...f, expiresInMinutes: e.target.value })}><option value={30}>30 minutes</option><option value={60}>1 hour</option><option value={360}>6 hours</option><option value={1440}>24 hours</option></select>}</Field>
        </div>
        <div className="notice info small">The customer pays on Stripe’s secure hosted page (test mode: card 4242 4242 4242 4242). Card details never touch this platform. Status updates automatically when Stripe confirms.</div>
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><Button type="submit" className="primary" busy={busy}>Create payment link</Button></div>
      </form>
    </Modal>
  );
}

export function PaymentsList({ payments, onChange, showOpp }) {
  const [run] = useAction();
  if (!payments?.length) return <p className="muted">No payment requests yet.</p>;
  return (
    <ul className="timeline">
      {payments.map((p) => (
        <li key={p.id} style={{ gridTemplateColumns: '1fr' }}>
          <div className="stack" style={{ gap: 6 }}>
            <div className="row"><strong>{cents(p.amount_cents, p.currency)}</strong><PaymentBadge p={p} />{showOpp && p.opportunity_title && <Link to={`/opportunities/${p.opportunity_id}`} className="small">{p.opportunity_title}</Link>}</div>
            <div className="tiny muted">Requested by {p.requested_by_name || '—'} · {fmtDateTime(p.created_at)} · Stripe ref: <span className="mono">{p.checkout_session_id || '—'}</span>{p.payment_intent_id && <> · <span className="mono">{p.payment_intent_id}</span></>}</div>
            {p.refunded_cents > 0 && <div className="tiny">Refunded: {cents(p.refunded_cents, p.currency)}</div>}
            {p.last_error && <div className="tiny" style={{ color: 'var(--danger)' }}>{p.last_error}</div>}
            {p.status === 'pending' && p.checkout_url && (
              <div className="row">
                <button className="btn sm" onClick={() => navigator.clipboard?.writeText(p.checkout_url).then(() => run(async () => {}, { success: 'Link copied' }))}>Copy link</button>
                <a className="btn sm" href={p.checkout_url} target="_blank" rel="noreferrer">Open checkout</a>
                <button className="btn sm" onClick={() => run(() => post(`/payments/${p.id}/send`), { success: 'Link sent by message' })}>Send via WhatsApp/SMS</button>
                <button className="btn sm" onClick={() => run(() => post(`/payments/${p.id}/expire`).then(onChange), { success: 'Cancellation requested — status updates when Stripe confirms' })}>Cancel link</button>
              </div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function PaymentBadge({ p }) {
  const map = { pending: ['Awaiting payment', 'warn'], paid: ['Paid', 'ok'], failed: ['Failed', 'danger'], expired: ['Expired / abandoned', 'muted'], refunded: ['Refunded', 'violet'], partially_refunded: ['Partially refunded', 'violet'] };
  const [t, tone] = map[p.status] || [p.status, 'muted'];
  return <Badge tone={tone}>{t}</Badge>;
}

// ---------- Appointment booking (I3) ----------
export function AppointmentModal({ contactId, opportunityId, defaultUserId, appointment, onClose, onDone }) {
  const { me } = useApp();
  const { data: users } = useApi('/users');
  const tz0 = appointment?.timezone || userTimeZone();
  const start0 = appointment ? toLocalInput(new Date(appointment.start_at), tz0) : toLocalInput(new Date(Date.now() + 3600_000), tz0).slice(0, 14) + '00';
  const [f, setF] = useState({
    userId: appointment?.user_id || defaultUserId || me.user.id, title: appointment?.title || 'Consultation', notes: appointment?.notes || '',
    start: start0, durationMinutes: appointment ? Math.round((new Date(appointment.end_at) - new Date(appointment.start_at)) / 60000) : 30, timezone: tz0,
  });
  const [busyTimes, setBusyTimes] = useState(null);
  const [busyErr, setBusyErr] = useState(null);
  const [conflicts, setConflicts] = useState(null);
  const [run, busy] = useAction();
  const date = f.start.slice(0, 10);
  const emp = (users || []).find((u) => u.id === f.userId);

  useEffect(() => {
    let alive = true;
    setBusyTimes(null); setBusyErr(null);
    get(`/calendar/busy${qs({ userId: f.userId, date, timezone: f.timezone, excludeAppointmentId: appointment?.id })}`)
      .then((d) => alive && setBusyTimes(d.busy)).catch((e) => alive && setBusyErr(e));
    return () => { alive = false; };
  }, [f.userId, date, f.timezone, appointment?.id]);

  const submit = async (force = false) => {
    setConflicts(null);
    const body = { ...f, durationMinutes: Number(f.durationMinutes), force };
    const out = await run(() => (appointment
      ? api(`/appointments/${appointment.id}`, { method: 'PATCH', body: { ...body, version: appointment.version } })
      : post('/appointments', { ...body, contactId, opportunityId: opportunityId || null })), {
      success: appointment ? 'Appointment rescheduled (Google Calendar updated)' : 'Appointment booked in Google Calendar',
      onError: (e) => { if (e.data?.code === 'conflict') { setConflicts(e.data.conflicts); return true; } return false; },
    });
    if (out) { onDone?.(out); onClose(); }
  };
  const calStatus = emp?.calendar_status;
  return (
    <Modal title={appointment ? 'Reschedule appointment' : 'Book an appointment'} onClose={onClose} wide>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); submit(false); }}>
        <div className="form-grid">
          <Field label="Employee" help={calStatus === 'connected' ? 'Google Calendar connected' : undefined} error={users && calStatus !== 'connected' ? (calStatus === 'needs_reconnect' ? 'Calendar connection expired — they must reconnect it on their Profile page.' : 'Has not connected Google Calendar — cannot be booked until they do (Profile page).') : undefined}>
            {(a) => <select {...a} value={f.userId} disabled={!!appointment} onChange={(e) => setF({ ...f, userId: e.target.value })}>{(users || []).filter((u) => u.active && !u.invite_pending).map((u) => <option key={u.id} value={u.id}>{u.name}{u.calendar_status === 'connected' ? '' : ' (no calendar)'}</option>)}</select>}
          </Field>
          <Field label="Title">{(a) => <input {...a} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required maxLength={160} />}</Field>
          <Field label="Start (local time)">{(a) => <input {...a} type="datetime-local" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} required />}</Field>
          <Field label="Time zone" help="Times are stored in UTC and shown in each person’s own zone">{(a) => <select {...a} value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>{TIMEZONES.map((z) => <option key={z}>{z}</option>)}</select>}</Field>
          <Field label="Duration">{(a) => <select {...a} value={f.durationMinutes} onChange={(e) => setF({ ...f, durationMinutes: e.target.value })}>{[15, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m} minutes</option>)}</select>}</Field>
          <Field label="Notes" className="full">{(a) => <textarea {...a} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={2000} />}</Field>
        </div>
        <div className="card" style={{ background: 'var(--surface-2)' }}>
          <h3>Busy times on {date} ({f.timezone})</h3>
          {busyErr ? <p className="small" style={{ color: 'var(--danger)' }}>{busyErr.message}</p>
            : !busyTimes ? <Loading text="Reading the employee’s calendar…" />
              : busyTimes.length === 0 ? <p className="small muted" style={{ margin: 0 }}>No busy times — the whole day is free.</p>
                : <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{busyTimes.map((b, i) => <li key={i}>{fmtTime(b.start, f.timezone)}–{fmtTime(b.end, f.timezone)} · {b.title}</li>)}</ul>}
        </div>
        {conflicts && (
          <div className="notice warn" role="alert">
            <div style={{ flex: 1 }}>
              <strong>Time conflict.</strong> {emp?.name} already has {conflicts.length} event{conflicts.length > 1 ? 's' : ''} then: {conflicts.map((c) => `${fmtTime(c.start, f.timezone)}–${fmtTime(c.end, f.timezone)} ${c.title}`).join('; ')}.
              <div className="row" style={{ marginTop: 8 }}><Button className="sm" busy={busy} onClick={() => submit(true)}>Book anyway (double-book)</Button></div>
            </div>
          </div>
        )}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><Button type="submit" className="primary" busy={busy} disabled={calStatus && calStatus !== 'connected'}>{appointment ? 'Save new time' : 'Book appointment'}</Button></div>
      </form>
    </Modal>
  );
}

export function AppointmentsList({ items, onChange }) {
  const [edit, setEdit] = useState(null);
  const [run] = useAction();
  if (!items?.length) return <p className="muted">No appointments.</p>;
  return (
    <>
      <ul className="timeline">
        {items.map((a) => (
          <li key={a.id} style={{ gridTemplateColumns: '34px 1fr' }}>
            <span className="tl-icon" aria-hidden>{'📅'}</span>
            <div>
              <div className="row"><strong>{a.title}</strong>{a.status === 'cancelled' ? <Badge tone="muted">Cancelled</Badge> : new Date(a.end_at) < new Date() ? <Badge tone="muted">Past</Badge> : <Badge tone="ok">Scheduled</Badge>}</div>
              <div className="small">{fmtDateTime(a.start_at)}–{fmtTime(a.end_at)} <span className="muted">(your time)</span>{a.timezone !== userTimeZone() && <span className="muted"> · booked as {fmtDateTime(a.start_at, { tz: a.timezone })} {a.timezone}</span>}</div>
              <div className="tiny muted">With {a.employee}{a.contact_name ? ` · ${a.contact_name}` : ''}{a.google_event_id ? ' · in Google Calendar' : ''}</div>
              {a.status === 'scheduled' && new Date(a.end_at) > new Date() && (
                <div className="row" style={{ marginTop: 6 }}>
                  <button className="btn sm" onClick={() => setEdit(a)}>Reschedule</button>
                  <button className="btn sm" onClick={() => run(() => post(`/appointments/${a.id}/cancel`).then(onChange), { success: 'Appointment cancelled (removed from Google Calendar)' })}>Cancel</button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      {edit && <AppointmentModal appointment={edit} onClose={() => setEdit(null)} onDone={onChange} />}
    </>
  );
}

export function UserName({ users, id }) {
  return (users || []).find((u) => u.id === id)?.name || '—';
}

export { ago };
