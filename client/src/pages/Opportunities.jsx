// Opportunities: board (drag & drop + keyboard "Move to") and list views, filters, saved lists, detail page.
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, post, qs } from '../lib/api.js';
import { useApi, useAction, useApp } from '../lib/app.jsx';
import { fmtDate, fmtDateTime, money } from '../lib/format.js';
import { Badge, Button, Confirm, ErrorNotice, Field, Loading, Modal, PageHeader, Pagination, PayStatus, Table } from '../components/ui.jsx';
import { AppointmentModal, AppointmentsList, CustomFieldInputs, CustomFieldValues, FilterBuilder, NoteForm, PaymentModal, PaymentsList, Timeline } from '../components/shared.jsx';
import { SavedListsLive } from './Contacts.jsx';

// Shown when a move is blocked by stage-required fields (F2.4): fill them and move in one step.
function RequiredFieldsModal({ opp, stage, missing, fields, onClose, onDone }) {
  const { can } = useApp();
  const [vals, setVals] = useState({ value: opp.value ?? '', closeDate: opp.close_date ?? '', custom: { ...(opp.custom || {}) } });
  const [run, busy] = useAction();
  const keys = missing.map((m) => m.key);
  const customMissing = fields.filter((f) => keys.includes(f.key));
  const submit = async (e) => {
    e.preventDefault();
    const body = { stageId: stage.id, version: opp.version, custom: vals.custom };
    if (keys.includes('value')) body.value = vals.value === '' ? null : Number(vals.value);
    if (keys.includes('close_date')) body.closeDate = vals.closeDate || null;
    const out = await run(() => api(`/opportunities/${opp.id}`, { method: 'PATCH', body }), { success: `Moved to ${stage.name}` });
    if (out) { onDone(); onClose(); }
  };
  return (
    <Modal title={`Fill required fields for “${stage.name}”`} onClose={onClose}>
      <div className="notice warn" style={{ marginBottom: 12 }} role="alert">This stage requires: {missing.map((m) => m.label).join(', ')}.</div>
      <form className="stack" onSubmit={submit}>
        {keys.includes('value') && (can('values.view')
          ? <Field label="Value *">{(a) => <input {...a} type="number" min="0" step="0.01" value={vals.value} onChange={(e) => setVals({ ...vals, value: e.target.value })} required autoFocus />}</Field>
          : <p className="notice danger">This stage needs a Value, but your role cannot see or set values. Ask a manager.</p>)}
        {keys.includes('close_date') && <Field label="Expected close date *">{(a) => <input {...a} type="date" value={vals.closeDate} onChange={(e) => setVals({ ...vals, closeDate: e.target.value })} required />}</Field>}
        <CustomFieldInputs fields={customMissing} values={vals.custom} onChange={(c) => setVals({ ...vals, custom: c })} highlight={keys} />
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><Button type="submit" className="primary" busy={busy}>Save and move</Button></div>
      </form>
    </Modal>
  );
}

export function Opportunities() {
  const [sp, setSp] = useSearchParams();
  const { can, toast, me } = useApp();
  const nav = useNavigate();
  const view = sp.get('view') || (sp.get('stageId') ? 'list' : 'board');
  const { data: meta } = useApi('/pipelines', { live: ['config'] });
  const pipelineId = sp.get('pipelineId') || (view === 'board' ? meta?.pipelines?.[0]?.id : undefined);
  const filters = JSON.parse(sp.get('filters') || '[]');
  const [showFilters, setShowFilters] = useState(filters.length > 0);
  const [blocked, setBlocked] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const path = `/opportunities${qs({ view, pipelineId, stageId: sp.get('stageId'), q: sp.get('q'), page: sp.get('page'), filters: filters.length ? filters : undefined })}`;
  const { data, error, loading, reload } = useApi(meta && (view !== 'board' || pipelineId) ? path : null, { live: ['crm', 'payments'] });
  const [run] = useAction();
  const setParam = (k, v) => { const n = new URLSearchParams(sp); if (v && (!Array.isArray(v) || v.length)) n.set(k, typeof v === 'string' ? v : JSON.stringify(v)); else n.delete(k); if (k !== 'page') n.delete('page'); setSp(n); };
  const pipe = meta?.pipelines?.find((p) => p.id === pipelineId);
  const fieldsFor = (pid) => (meta?.fields || []).filter((f) => f.entity === 'opportunity' && (!f.pipeline_id || f.pipeline_id === pid));

  const move = async (opp, stageId) => {
    if (opp.stage_id === stageId) return;
    const stage = pipe.stages.find((s) => s.id === stageId);
    // optimistic update, rolled back on failure
    const before = data.items;
    try {
      await api(`/opportunities/${opp.id}/move`, { method: 'POST', body: { stageId, version: opp.version } });
      toast(`Moved to ${stage.name}`, 'success');
      reload();
    } catch (e) {
      if (e.status === 422) setBlocked({ opp, stage, missing: e.data.missing });
      else toast(e.message, 'error');
      if (e.status === 409) reload();
      void before;
    }
  };
  const saveList = (rows, name) => run(async () => { await post('/lists', { name, entity: 'opportunities', filters: rows }); window.dispatchEvent(new CustomEvent('lg:change', { detail: { topic: 'lists' } })); }, { success: 'List saved — it updates automatically' });

  return (
    <div>
      <PageHeader title="Opportunities" subtitle="Drag cards between stages, or use the “Move to” menu on each card.">
        <div className="dash-toggle" role="group" aria-label="View">
          <button className="btn sm" aria-pressed={view === 'board'} onClick={() => setParam('view', 'board')}>Board</button>
          <button className="btn sm" aria-pressed={view === 'list'} onClick={() => setParam('view', 'list')}>List</button>
        </div>
        {can('crm.export') && <a className="btn" href={`/api/export/opportunities.csv${qs({ pipelineId, stageId: sp.get('stageId'), filters: filters.length ? filters : undefined })}`}>Export CSV</a>}
      </PageHeader>
      <div className="stack" style={{ marginBottom: 12 }}>
        <div className="row">
          <select aria-label="Pipeline" style={{ width: 'auto' }} value={pipelineId || ''} onChange={(e) => setParam('pipelineId', e.target.value)}>
            {view === 'list' && <option value="">All pipelines</option>}
            {(meta?.pipelines || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input className="search" type="search" placeholder="Search title or contact…" aria-label="Search opportunities" defaultValue={sp.get('q') || ''} onKeyDown={(e) => e.key === 'Enter' && setParam('q', e.target.value)} />
          <button className="btn" aria-expanded={showFilters} onClick={() => setShowFilters(!showFilters)}>Filters{filters.length ? ` (${filters.length})` : ''}</button>
          {sp.get('stageId') && <span className="chip">Stage filter <button className="btn ghost sm" style={{ padding: 0, minHeight: 0 }} aria-label="Remove stage filter" onClick={() => setParam('stageId', '')}>{'✕'}</button></span>}
          {loading && <span className="spinner" aria-label="Refreshing" />}
          {data?.valuesMasked && <Badge tone="muted" plain>Values hidden for your role</Badge>}
        </div>
        <SavedListsLive entity="opportunities" onPick={(l) => { setShowFilters(true); setParam('filters', l.filters); }} />
        {showFilters && <FilterBuilder entity="opportunities" pipelineId={pipelineId} filters={filters} onApply={(rows) => setParam('filters', rows)} onSave={saveList} />}
      </div>
      <ErrorNotice error={error} onRetry={reload} />
      {!data ? <Loading /> : view === 'board' && pipe ? (
        <div className="board" aria-label={`${pipe.name} board`}>
          {pipe.stages.map((s) => {
            const cards = data.items.filter((o) => o.stage_id === s.id);
            const total = cards.reduce((a, o) => a + Number(o.value || 0), 0);
            return (
              <section key={s.id} className={`column ${dragOver === s.id ? 'drop' : ''}`} aria-label={`Stage ${s.name}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(s.id); }} onDragLeave={() => setDragOver(null)}
                onDrop={(e) => { e.preventDefault(); setDragOver(null); const o = data.items.find((x) => x.id === e.dataTransfer.getData('text/plain')); if (o) move(o, s.id); }}>
                <div className="column-head">
                  <span>{s.name} <span className="muted">({cards.length})</span></span>
                  {!data.valuesMasked && <span className="small muted">{money(total, cards[0]?.currency || me.workspace.defaultCurrency)}</span>}
                </div>
                <div className="tiny">{s.kind !== 'open' && <Badge tone={s.kind === 'won' ? 'ok' : 'muted'}>{s.kind}</Badge>} {s.required_fields.length > 0 && <span className="muted">Requires: {s.required_fields.join(', ')}</span>}</div>
                {cards.map((o) => (
                  <article key={o.id} className="opp-card" draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', o.id)}>
                    <Link className="title" to={`/opportunities/${o.id}`}>{o.title}</Link>
                    <div className="small muted">{o.contact_name} · {o.owner_name || 'no owner'}</div>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <strong className="small">{o.value_masked ? 'Value hidden' : money(o.value, o.currency)}</strong>
                      {o.payment_status && <PayStatus s={o.payment_status} />}
                    </div>
                    {can('crm.edit') && (
                      <select aria-label={`Move ${o.title} to stage`} value={o.stage_id} onChange={(e) => move(o, e.target.value)}>
                        {pipe.stages.map((x) => <option key={x.id} value={x.id}>Move to: {x.name}</option>)}
                      </select>
                    )}
                  </article>
                ))}
              </section>
            );
          })}
        </div>
      ) : (
        <>
          <Table caption="Opportunities" rows={data.items} onRowClick={(o) => nav(`/opportunities/${o.id}`)} empty="No opportunities match." columns={[
            { key: 'title', label: 'Opportunity', render: (o) => <div><strong>{o.title}</strong><div className="tiny muted">{o.contact_name}</div></div> },
            { key: 'stage', label: 'Stage', render: (o) => <span>{o.pipeline_name} → {o.stage_name}</span> },
            { key: 'value', label: 'Value', render: (o) => (o.value_masked ? <span className="muted">Hidden</span> : money(o.value, o.currency)) },
            { key: 'owner', label: 'Owner', render: (o) => o.owner_name || '—' },
            { key: 'close', label: 'Close date', render: (o) => fmtDate(o.close_date) },
            { key: 'pay', label: 'Payment', render: (o) => (o.payment_status ? <PayStatus s={o.payment_status} /> : '—') },
          ]} />
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => setParam('page', String(p))} />
        </>
      )}
      {blocked && <RequiredFieldsModal {...blocked} fields={fieldsFor(blocked.opp.pipeline_id)} onClose={() => setBlocked(null)} onDone={reload} />}
    </div>
  );
}

export function OpportunityDetail() {
  const { id } = useParams();
  const { can } = useApp();
  const nav = useNavigate();
  const { data, error, reload } = useApi(`/opportunities/${id}`, { live: ['crm', 'payments', 'appointments'] });
  const { data: users } = useApi('/users');
  const [edit, setEdit] = useState(false);
  const [pay, setPay] = useState(false);
  const [book, setBook] = useState(false);
  const [del, setDel] = useState(false);
  const [blocked, setBlocked] = useState(null);
  const [run, busy] = useAction();
  if (!data) return error ? <ErrorNotice error={error} onRetry={reload} /> : <Loading />;
  const o = data.opportunity;
  const stage = data.stages.find((s) => s.id === o.stage_id);
  const moveTo = async (stageId) => {
    try { await api(`/opportunities/${o.id}/move`, { method: 'POST', body: { stageId, version: o.version } }); reload(); }
    catch (e) { if (e.status === 422) setBlocked({ opp: o, stage: data.stages.find((s) => s.id === stageId), missing: e.data.missing }); else run(() => Promise.reject(e)); }
  };
  const collected = data.payments.filter((p) => ['paid', 'refunded', 'partially_refunded'].includes(p.status)).reduce((a, p) => a + p.amount_cents - p.refunded_cents, 0);
  const pending = data.payments.filter((p) => p.status === 'pending').reduce((a, p) => a + p.amount_cents, 0);
  return (
    <div className="stack" style={{ gap: 16 }}>
      <PageHeader title={o.title} subtitle={<span>{o.pipeline_name} · <Link to={`/contacts/${o.contact_id}`}>{o.first_name} {o.last_name}</Link></span>}>
        {can('crm.edit') && <button className="btn" onClick={() => setEdit(true)}>Edit</button>}
        {can('crm.edit') && <button className="btn" onClick={() => setBook(true)}>Book appointment</button>}
        {can('crm.edit') && <button className="btn primary" onClick={() => setPay(true)}>Request payment</button>}
        {can('crm.delete') && <button className="btn" onClick={() => setDel(true)}>Delete</button>}
      </PageHeader>
      <section className="card" aria-label="Stage">
        <div className="row" role="group" aria-label="Pipeline stages">
          {data.stages.map((s) => (
            <button key={s.id} className={`btn sm ${s.id === o.stage_id ? 'primary' : ''}`} aria-current={s.id === o.stage_id ? 'step' : undefined} disabled={!can('crm.edit')} onClick={() => moveTo(s.id)} title={s.required_fields.length ? `Requires: ${s.required_fields.join(', ')}` : undefined}>
              {s.name}{s.required_fields.length > 0 && <span aria-hidden> *</span>}
            </button>
          ))}
        </div>
        <p className="tiny muted" style={{ margin: '8px 0 0' }}>* stage has required fields. Current: <strong>{stage?.name}</strong> since {fmtDateTime(o.stage_changed_at)}</p>
      </section>
      <div className="split">
        <div className="stack">
          <section className="card"><div className="card-header"><h2>Payments</h2><span className="small">Collected <strong>{money(collected / 100, o.currency)}</strong> · Awaiting <strong>{money(pending / 100, o.currency)}</strong></span></div><PaymentsList payments={data.payments} onChange={reload} /></section>
          <section className="card"><h2>Appointments</h2><AppointmentsList items={data.appointments} onChange={reload} /></section>
          <section className="card"><h2>Activity history</h2>
            {can('crm.edit') && <><NoteForm onSubmit={(b) => post(`/contacts/${o.contact_id}/notes`, { ...b, opportunityId: o.id }).then(reload)} /><hr /></>}
            <Timeline items={data.activities} />
          </section>
        </div>
        <section className="card"><h2>Details</h2>
          <dl className="kv">
            <dt>Value</dt><dd>{o.value_masked ? <Badge tone="muted" plain>Hidden for your role</Badge> : money(o.value, o.currency)}</dd>
            <dt>Owner</dt><dd>{o.owner_name || '—'}</dd>
            <dt>Expected close</dt><dd>{fmtDate(o.close_date)}</dd>
            <dt>Tags</dt><dd>{o.tags.length ? o.tags.map((t) => <span key={t} className="chip" style={{ marginRight: 4 }}>{t}</span>) : '—'}</dd>
            <dt>Customer</dt><dd><Link to={`/contacts/${o.contact_id}`}>{o.first_name} {o.last_name}</Link><div className="tiny muted">{o.contact_phone || o.contact_email || ''}</div></dd>
            <CustomFieldValues fields={data.fields} values={o.custom} />
          </dl>
        </section>
      </div>
      {edit && <OppEditModal o={o} fields={data.fields} users={users} onClose={() => setEdit(false)} onDone={reload} />}
      {pay && <PaymentModal opportunity={o} onClose={() => setPay(false)} onDone={reload} />}
      {book && <AppointmentModal contactId={o.contact_id} opportunityId={o.id} defaultUserId={o.owner_id} onClose={() => setBook(false)} onDone={reload} />}
      {blocked && <RequiredFieldsModal {...blocked} fields={data.fields} onClose={() => setBlocked(null)} onDone={reload} />}
      {del && <Confirm title="Delete opportunity?" danger confirmLabel="Delete" busy={busy} message="It will be removed from the pipeline. Payments and history are kept for the audit trail." onClose={() => setDel(false)} onConfirm={async () => { const ok = await run(() => api(`/opportunities/${o.id}`, { method: 'DELETE' }), { success: 'Deleted' }); if (ok) nav('/opportunities'); }} />}
    </div>
  );
}

function OppEditModal({ o, fields, users, onClose, onDone }) {
  const { can } = useApp();
  const [f, setF] = useState({ title: o.title, value: o.value ?? '', currency: o.currency, closeDate: o.close_date || '', ownerId: o.owner_id || '', tags: o.tags.join(', '), custom: { ...o.custom } });
  const [run, busy] = useAction();
  const [missing, setMissing] = useState([]);
  const submit = async (e) => {
    e.preventDefault();
    const body = { title: f.title, closeDate: f.closeDate || null, tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean), custom: f.custom, version: o.version };
    if (can('values.view')) body.value = f.value === '' ? null : Number(f.value);
    if (can('leads.reassign') && f.ownerId) body.ownerId = f.ownerId;
    const out = await run(() => api(`/opportunities/${o.id}`, { method: 'PATCH', body }), { success: 'Saved', onError: (x) => { if (x.data?.missing) setMissing(x.data.missing.map((m) => m.key)); return false; } });
    if (out) { onDone(); onClose(); }
  };
  return (
    <Modal title="Edit opportunity" onClose={onClose} wide>
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Title">{(a) => <input {...a} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required />}</Field>
          {can('values.view') && <Field label={`Value (${o.currency.toUpperCase()})`} error={missing.includes('value') ? 'Required for this stage' : undefined}>{(a) => <input {...a} type="number" min="0" step="0.01" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />}</Field>}
          <Field label="Expected close date" error={missing.includes('close_date') ? 'Required for this stage' : undefined}>{(a) => <input {...a} type="date" value={f.closeDate} onChange={(e) => setF({ ...f, closeDate: e.target.value })} />}</Field>
          {can('leads.reassign') && <Field label="Owner">{(a) => <select {...a} value={f.ownerId} onChange={(e) => setF({ ...f, ownerId: e.target.value })}>{(users || []).filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}</Field>}
          <Field label="Tags" help="Comma separated">{(a) => <input {...a} value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} />}</Field>
          <CustomFieldInputs fields={fields} values={f.custom} onChange={(c) => setF({ ...f, custom: c })} highlight={missing} />
        </div>
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><Button type="submit" className="primary" busy={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}
