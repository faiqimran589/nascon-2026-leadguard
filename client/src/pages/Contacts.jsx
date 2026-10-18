// Contacts & companies: lists with filters and saved lists, the complete customer view (F2.8).
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, post, qs } from '../lib/api.js';
import { useApi, useAction, useApp, useLive } from '../lib/app.jsx';
import { ago, fmtDateTime, fullName, money, SOURCE } from '../lib/format.js';
import { Avail, Badge, Button, Confirm, ErrorNotice, Field, LeadStatus, Loading, Modal, PageHeader, Pagination, Table, Tabs } from '../components/ui.jsx';
import { AppointmentModal, AppointmentsList, Conversation, CustomFieldInputs, CustomFieldValues, FilterBuilder, NoteForm, PaymentsList, SavedLists, Timeline } from '../components/shared.jsx';

export function Contacts() {
  const [sp, setSp] = useSearchParams();
  const { can, toast } = useApp();
  const filters = JSON.parse(sp.get('filters') || '[]');
  const [showFilters, setShowFilters] = useState(filters.length > 0);
  const [listId, setListId] = useState(null);
  const [create, setCreate] = useState(false);
  const { data, error, loading, reload } = useApi(`/contacts${qs({ q: sp.get('q'), page: sp.get('page'), filters: filters.length ? filters : undefined })}`, { live: ['crm', 'leads'] });
  const nav = useNavigate();
  const setParam = (k, v) => { const n = new URLSearchParams(sp); if (v && (!Array.isArray(v) || v.length)) n.set(k, typeof v === 'string' ? v : JSON.stringify(v)); else n.delete(k); if (k !== 'page') n.delete('page'); setSp(n); };
  const saveList = async (rows, name) => {
    try { await post('/lists', { name, entity: 'contacts', filters: rows }); toast('List saved — it updates automatically as contacts start or stop matching', 'success'); window.dispatchEvent(new CustomEvent('lg:change', { detail: { topic: 'lists' } })); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div>
      <PageHeader title="Contacts" subtitle="People your company talks to.">
        {can('crm.export') && <a className="btn" href={`/api/export/contacts.csv${qs({ q: sp.get('q'), filters: filters.length ? filters : undefined })}`}>Export CSV</a>}
        {can('crm.create') && <button className="btn primary" onClick={() => setCreate(true)}>+ New contact</button>}
      </PageHeader>
      <div className="stack" style={{ marginBottom: 12 }}>
        <div className="row">
          <input className="search" type="search" placeholder="Search name, email, phone…" aria-label="Search contacts" defaultValue={sp.get('q') || ''} onKeyDown={(e) => e.key === 'Enter' && setParam('q', e.target.value)} />
          <button className="btn" aria-expanded={showFilters} onClick={() => setShowFilters(!showFilters)}>Filters{filters.length ? ` (${filters.length})` : ''}</button>
          {loading && <span className="spinner" aria-label="Refreshing" />}
        </div>
        <SavedListsLive entity="contacts" activeId={listId} onPick={(l) => { setListId(l.id); setShowFilters(true); setParam('filters', l.filters); }} />
        {showFilters && <FilterBuilder entity="contacts" filters={filters} onApply={(rows) => { setListId(null); setParam('filters', rows); }} onSave={saveList} />}
      </div>
      <ErrorNotice error={error} onRetry={reload} />
      {!data ? <Loading /> : (
        <>
          <Table caption="Contacts" rows={data.items} onRowClick={(c) => nav(`/contacts/${c.id}`)} empty="No contacts match." columns={[
            { key: 'name', label: 'Name', render: (c) => <div><strong>{fullName(c)}</strong>{c.opted_out && <> <Badge tone="danger">Opted out</Badge></>}<div className="tiny muted">{c.email || ''}</div></div> },
            { key: 'phone', label: 'Phone', render: (c) => c.phone || '—' },
            { key: 'company', label: 'Company', render: (c) => c.company_name || '—' },
            { key: 'owner', label: 'Owner', render: (c) => c.owner_name || '—' },
            { key: 'tags', label: 'Tags', render: (c) => <div className="row" style={{ gap: 4 }}>{c.tags.map((t) => <span key={t} className="chip">{t}</span>)}</div> },
            { key: 'source', label: 'Source', render: (c) => SOURCE[c.source] || c.source || '—' },
            { key: 'created', label: 'Added', render: (c) => ago(c.created_at) },
          ]} />
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => setParam('page', String(p))} />
        </>
      )}
      {create && <ContactModal onClose={() => setCreate(false)} onDone={(c) => nav(`/contacts/${c.id}`)} />}
    </div>
  );
}

export function SavedListsLive(props) {
  const [k, setK] = useState(0);
  useLive(['lists'], () => setK((x) => x + 1)); // re-mount when a list is saved
  return <SavedLists key={k} {...props} />;
}

export function ContactModal({ contact, onClose, onDone }) {
  const { data: meta } = useApi('/pipelines');
  const { data: companies } = useApi('/companies?pageSize=100');
  const { data: users } = useApi('/users');
  const { can } = useApp();
  const [f, setF] = useState({
    firstName: contact?.first_name || '', lastName: contact?.last_name || '', email: contact?.email || '', phone: contact?.phone || '',
    companyId: contact?.company_id || '', ownerId: contact?.owner_id || '', tags: (contact?.tags || []).join(', '), custom: contact?.custom || {},
  });
  const [errs, setErrs] = useState({});
  const [run, busy] = useAction();
  const fields = (meta?.fields || []).filter((x) => x.entity === 'contact');
  const submit = async (e) => {
    e.preventDefault(); setErrs({});
    const body = { firstName: f.firstName, lastName: f.lastName, email: f.email || null, phone: f.phone || null, companyId: f.companyId || null, tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean), custom: f.custom };
    if (contact) { body.version = contact.version; if (can('leads.reassign')) body.ownerId = f.ownerId || null; }
    const out = await run(() => (contact ? api(`/contacts/${contact.id}`, { method: 'PATCH', body }) : post('/contacts', body)), { success: contact ? 'Contact saved' : 'Contact created', onError: (x) => { if (x.data?.fields) setErrs(x.data.fields); } });
    if (out) { onDone?.(out); onClose(); }
  };
  const bind = (k) => ({ value: f[k], onChange: (e) => setF({ ...f, [k]: e.target.value }) });
  return (
    <Modal title={contact ? 'Edit contact' : 'New contact'} onClose={onClose} wide>
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          <Field label="First name *" error={errs.firstName}>{(a) => <input {...a} {...bind('firstName')} required autoFocus />}</Field>
          <Field label="Last name">{(a) => <input {...a} {...bind('lastName')} />}</Field>
          <Field label="Email" error={errs.email}>{(a) => <input {...a} type="email" {...bind('email')} />}</Field>
          <Field label="Phone" help="International format, e.g. +923001234567" error={errs.phone}>{(a) => <input {...a} type="tel" {...bind('phone')} />}</Field>
          <Field label="Company">{(a) => <select {...a} {...bind('companyId')}><option value="">— none —</option>{(companies?.items || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}</Field>
          {contact && can('leads.reassign') && <Field label="Owner">{(a) => <select {...a} {...bind('ownerId')}><option value="">—</option>{(users || []).filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}</Field>}
          <Field label="Tags" help="Comma separated" className="full">{(a) => <input {...a} {...bind('tags')} />}</Field>
          <CustomFieldInputs fields={fields} values={f.custom} onChange={(c) => setF({ ...f, custom: c })} />
        </div>
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><Button type="submit" className="primary" busy={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

export function ContactDetail() {
  const { id } = useParams();
  const { can } = useApp();
  const nav = useNavigate();
  const { data, error, reload } = useApi(`/contacts/${id}`, { live: ['crm', 'messages', 'payments', 'appointments', 'leads'] });
  const [tab, setTab] = useState('conversation');
  const [edit, setEdit] = useState(false);
  const [book, setBook] = useState(false);
  const [newOpp, setNewOpp] = useState(false);
  const [del, setDel] = useState(false);
  const [run, busy] = useAction();
  if (!data) return error ? <ErrorNotice error={error} onRetry={reload} /> : <Loading />;
  const c = data.contact;
  const conv = data.conversations[0];
  const toggleOpt = () => run(() => api(`/contacts/${c.id}`, { method: 'PATCH', body: { optedOut: !c.opted_out, version: c.version } }).then(reload), { success: c.opted_out ? 'Contact opted back in' : 'Contact marked as opted out' });
  return (
    <div className="stack" style={{ gap: 16 }}>
      <PageHeader title={fullName(c)} subtitle={`${c.company_name ? `${c.company_name} · ` : ''}Customer since ${fmtDateTime(c.created_at, { year: true })}`}>
        {can('crm.edit') && <button className="btn" onClick={() => setEdit(true)}>Edit</button>}
        {can('crm.edit') && <button className="btn" onClick={() => setBook(true)}>Book appointment</button>}
        {can('crm.create') && <button className="btn primary" onClick={() => setNewOpp(true)}>+ Opportunity</button>}
        {can('crm.delete') && <button className="btn" onClick={() => setDel(true)}>Delete</button>}
      </PageHeader>
      <div className="split">
        <div className="stack">
          <section className="card">
            <Tabs value={tab} onChange={setTab} tabs={[
              { value: 'conversation', label: `Conversation${conv?.unread_count ? ` (${conv.unread_count})` : ''}` },
              { value: 'opps', label: `Opportunities (${data.opportunities.length})` },
              { value: 'payments', label: `Payments (${data.payments.length})` },
              { value: 'appts', label: `Appointments (${data.appointments.length})` },
              { value: 'leads', label: `Leads (${data.leads.length})` },
            ]} />
            {tab === 'conversation' && (c.phone ? <Conversation conversationId={conv?.id} contactId={c.id} optedOut={c.opted_out} ownerName={c.owner_name} /> : <p className="muted">Add a phone number to message this contact.</p>)}
            {tab === 'opps' && (data.opportunities.length ? (
              <ul className="timeline">{data.opportunities.map((o) => (
                <li key={o.id} style={{ gridTemplateColumns: '1fr auto' }}>
                  <div><Link to={`/opportunities/${o.id}`}><strong>{o.title}</strong></Link><div className="tiny muted">{o.pipeline_name} → {o.stage_name} · owner {o.owner_name || '—'}</div></div>
                  <div className="right">{o.value_masked ? <span className="muted">Hidden</span> : money(o.value, o.currency)}</div>
                </li>))}
              </ul>) : <p className="muted">No opportunities.</p>)}
            {tab === 'payments' && <PaymentsList payments={data.payments} onChange={reload} showOpp />}
            {tab === 'appts' && <AppointmentsList items={data.appointments.map((a) => ({ ...a, contact_name: fullName(c) }))} onChange={reload} />}
            {tab === 'leads' && (data.leads.length ? (
              <ul className="timeline">{data.leads.map((l) => (
                <li key={l.id} style={{ gridTemplateColumns: '1fr auto' }}><div><Link to={`/leads/${l.id}`}><strong>{l.title}</strong></Link><div className="tiny muted">{SOURCE[l.source]} · {fmtDateTime(l.created_at)} · owner {l.owner_name}</div></div><LeadStatus s={l.status} /></li>
              ))}</ul>) : <p className="muted">No leads.</p>)}
          </section>
          <section className="card" aria-labelledby="hist">
            <h2 id="hist">Activity history</h2>
            {can('crm.edit') && <><NoteForm onSubmit={(b) => post(`/contacts/${c.id}/notes`, b).then(reload)} /><hr /></>}
            <Timeline items={data.activities} />
          </section>
        </div>
        <div className="stack">
          <section className="card">
            <h2>Details</h2>
            <dl className="kv">
              <dt>Assigned employee</dt><dd><strong>{c.owner_name || 'Unassigned'}</strong> {c.owner_availability && <Avail s={c.owner_availability} />}</dd>
              <dt>Email</dt><dd>{c.email || '—'}</dd>
              <dt>Phone</dt><dd>{c.phone || '—'}</dd>
              <dt>Company</dt><dd>{c.company_id ? <Link to={`/companies/${c.company_id}`}>{c.company_name}</Link> : '—'}</dd>
              <dt>Source</dt><dd>{SOURCE[c.source] || c.source || '—'}</dd>
              <dt>Tags</dt><dd>{c.tags.length ? c.tags.map((t) => <span key={t} className="chip" style={{ marginRight: 4 }}>{t}</span>) : '—'}</dd>
              <dt>Messaging</dt><dd>{c.opted_out ? <Badge tone="danger">Opted out {c.opted_out_at ? `· ${fmtDateTime(c.opted_out_at)}` : ''}</Badge> : <Badge tone="ok">Can be messaged</Badge>}</dd>
              <CustomFieldValues fields={data.fields} values={c.custom} />
            </dl>
            {can('crm.edit') && <div className="row" style={{ marginTop: 10 }}><Button className="sm" busy={busy} onClick={toggleOpt}>{c.opted_out ? 'Opt back in' : 'Mark as opted out'}</Button></div>}
          </section>
          <section className="card"><h2>Payments summary</h2><PaySummary payments={data.payments} /></section>
        </div>
      </div>
      {edit && <ContactModal contact={c} onClose={() => setEdit(false)} onDone={reload} />}
      {book && <AppointmentModal contactId={c.id} defaultUserId={c.owner_id} onClose={() => setBook(false)} onDone={reload} />}
      {newOpp && <OppQuickCreate contactId={c.id} onClose={() => setNewOpp(false)} />}
      {del && <Confirm title="Delete contact?" danger confirmLabel="Delete" busy={busy} message={`This hides ${fullName(c)}, their opportunities and closes their open leads. Payments and the audit history are kept.`} onClose={() => setDel(false)} onConfirm={async () => { const ok = await run(() => api(`/contacts/${c.id}`, { method: 'DELETE' }), { success: 'Contact deleted' }); if (ok) nav('/contacts'); }} />}
    </div>
  );
}

function PaySummary({ payments }) {
  const by = {};
  for (const p of payments) {
    const k = p.currency; by[k] ||= { collected: 0, pending: 0 };
    if (['paid', 'refunded', 'partially_refunded'].includes(p.status)) by[k].collected += p.amount_cents - p.refunded_cents;
    if (p.status === 'pending') by[k].pending += p.amount_cents;
  }
  if (!payments.length) return <p className="muted">No payments yet.</p>;
  return <dl className="kv">{Object.entries(by).map(([cur, v]) => <div key={cur} style={{ display: 'contents' }}><dt>Collected ({cur.toUpperCase()})</dt><dd>{money(v.collected / 100, cur)}</dd><dt>Awaiting</dt><dd>{money(v.pending / 100, cur)}</dd></div>)}</dl>;
}

export function OppQuickCreate({ contactId, onClose }) {
  const nav = useNavigate();
  const { can } = useApp();
  const { data: meta } = useApi('/pipelines');
  const [f, setF] = useState({ title: '', pipelineId: '', value: '', custom: {} });
  const [run, busy] = useAction();
  const pipelineId = f.pipelineId || meta?.pipelines?.[0]?.id;
  const fields = (meta?.fields || []).filter((x) => x.entity === 'opportunity' && (!x.pipeline_id || x.pipeline_id === pipelineId));
  return (
    <Modal title="New opportunity" onClose={onClose} wide>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); const o = await run(() => post('/opportunities', { title: f.title, contactId, pipelineId, value: f.value === '' ? null : Number(f.value), custom: f.custom }), { success: 'Opportunity created' }); if (o) nav(`/opportunities/${o.id}`); }}>
        <div className="form-grid">
          <Field label="Title *">{(a) => <input {...a} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required autoFocus />}</Field>
          <Field label="Pipeline">{(a) => <select {...a} value={pipelineId || ''} onChange={(e) => setF({ ...f, pipelineId: e.target.value, custom: {} })}>{(meta?.pipelines || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}</Field>
          {can('values.view') && <Field label="Value">{(a) => <input {...a} type="number" min="0" step="0.01" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />}</Field>}
          <CustomFieldInputs fields={fields} values={f.custom} onChange={(c) => setF({ ...f, custom: c })} />
        </div>
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><Button type="submit" className="primary" busy={busy}>Create</Button></div>
      </form>
    </Modal>
  );
}

export function Companies() {
  const [sp, setSp] = useSearchParams();
  const { can } = useApp();
  const { data, error, reload } = useApi(`/companies${qs({ q: sp.get('q'), page: sp.get('page') })}`, { live: ['crm'] });
  const [create, setCreate] = useState(false);
  const nav = useNavigate();
  return (
    <div>
      <PageHeader title="Companies" subtitle="Organisations your contacts belong to.">
        {can('crm.create') && <button className="btn primary" onClick={() => setCreate(true)}>+ New company</button>}
      </PageHeader>
      <div className="row" style={{ marginBottom: 12 }}><input className="search" type="search" placeholder="Search companies…" aria-label="Search companies" defaultValue={sp.get('q') || ''} onKeyDown={(e) => e.key === 'Enter' && setSp(e.target.value ? { q: e.target.value } : {})} /></div>
      <ErrorNotice error={error} onRetry={reload} />
      {!data ? <Loading /> : (
        <>
          <Table caption="Companies" rows={data.items} onRowClick={(c) => nav(`/companies/${c.id}`)} empty="No companies yet." columns={[
            { key: 'name', label: 'Name', render: (c) => <strong>{c.name}</strong> },
            { key: 'domain', label: 'Website', render: (c) => c.domain || '—' },
            { key: 'phone', label: 'Phone', render: (c) => c.phone || '—' },
            { key: 'contacts', label: 'Contacts', render: (c) => c.contact_count },
          ]} />
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => setSp({ ...Object.fromEntries(sp), page: p })} />
        </>
      )}
      {create && <CompanyModal onClose={() => setCreate(false)} onDone={(c) => nav(`/companies/${c.id}`)} />}
    </div>
  );
}

function CompanyModal({ company, onClose, onDone }) {
  const { data: meta } = useApi('/pipelines');
  const [f, setF] = useState({ name: company?.name || '', domain: company?.domain || '', phone: company?.phone || '', custom: company?.custom || {} });
  const [run, busy] = useAction();
  const fields = (meta?.fields || []).filter((x) => x.entity === 'company');
  return (
    <Modal title={company ? 'Edit company' : 'New company'} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); const out = await run(() => (company ? api(`/companies/${company.id}`, { method: 'PATCH', body: { ...f, version: company.version } }) : post('/companies', f)), { success: 'Saved' }); if (out) { onDone?.(out); onClose(); } }}>
        <Field label="Name *">{(a) => <input {...a} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoFocus />}</Field>
        <Field label="Website">{(a) => <input {...a} value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })} />}</Field>
        <Field label="Phone">{(a) => <input {...a} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />}</Field>
        <CustomFieldInputs fields={fields} values={f.custom} onChange={(c) => setF({ ...f, custom: c })} />
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><Button type="submit" className="primary" busy={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

export function CompanyDetail() {
  const { id } = useParams();
  const { can } = useApp();
  const nav = useNavigate();
  const { data, error, reload } = useApi(`/companies/${id}`, { live: ['crm'] });
  const [edit, setEdit] = useState(false);
  const [del, setDel] = useState(false);
  const [run, busy] = useAction();
  if (!data) return error ? <ErrorNotice error={error} onRetry={reload} /> : <Loading />;
  const co = data.company;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <PageHeader title={co.name} subtitle={co.domain || ''}>
        {can('crm.edit') && <button className="btn" onClick={() => setEdit(true)}>Edit</button>}
        {can('crm.delete') && <button className="btn" onClick={() => setDel(true)}>Delete</button>}
      </PageHeader>
      <div className="split">
        <section className="card"><h2>Contacts</h2>
          <Table caption="Company contacts" rows={data.contacts} onRowClick={(c) => nav(`/contacts/${c.id}`)} empty="No contacts at this company." columns={[
            { key: 'n', label: 'Name', render: (c) => fullName(c) }, { key: 'e', label: 'Email', render: (c) => c.email || '—' }, { key: 'o', label: 'Owner', render: (c) => c.owner_name || '—' }]} />
          <h2 style={{ marginTop: 16 }}>Opportunities</h2>
          <Table caption="Company opportunities" rows={data.opportunities} onRowClick={(o) => nav(`/opportunities/${o.id}`)} empty="None." columns={[
            { key: 't', label: 'Title', render: (o) => o.title }, { key: 'c', label: 'Contact', render: (o) => o.contact_name }, { key: 's', label: 'Stage', render: (o) => o.stage_name },
            { key: 'v', label: 'Value', render: (o) => (o.value_masked ? 'Hidden' : money(o.value, o.currency)) }]} />
        </section>
        <section className="card"><h2>Details</h2><dl className="kv"><dt>Phone</dt><dd>{co.phone || '—'}</dd><CustomFieldValues fields={data.fields} values={co.custom} /></dl></section>
      </div>
      {edit && <CompanyModal company={co} onClose={() => setEdit(false)} onDone={reload} />}
      {del && <Confirm title="Delete company?" danger confirmLabel="Delete" busy={busy} message="Contacts stay, but are unlinked from this company." onClose={() => setDel(false)} onConfirm={async () => { const ok = await run(() => api(`/companies/${co.id}`, { method: 'DELETE' }), { success: 'Company deleted' }); if (ok) nav('/companies'); }} />}
    </div>
  );
}
