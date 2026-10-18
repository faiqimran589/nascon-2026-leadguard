// Inbox (conversations), appointments and payments lists.
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { qs } from '../lib/api.js';
import { useApi, useApp } from '../lib/app.jsx';
import { ago, cents, fmtDateTime, fullName } from '../lib/format.js';
import { Badge, ErrorNotice, Loading, PageHeader, Pagination, PayStatus, Table, Tabs } from '../components/ui.jsx';
import { AppointmentsList, Conversation } from '../components/shared.jsx';

export function Inbox() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data, error, reload } = useApi('/conversations?pageSize=100', { live: ['messages'] });
  const { data: integ } = useApi('/integrations', { live: ['integrations'] });
  const msgIntegs = (integ?.items || []).filter((x) => x.provider === 'twilio' || x.provider === 'meta');
  const noMessaging = integ && msgIntegs.every((x) => x.status === 'not_connected');
  const active = data?.items?.find((c) => c.id === id);
  return (
    <div>
      <PageHeader title="Inbox" subtitle="WhatsApp / SMS conversations. You see conversations of customers you are allowed to see." />
      {noMessaging && <div className="notice warn" style={{ marginBottom: 12 }}>Messaging is not connected yet. An admin can connect WhatsApp (Meta) or Twilio on the <Link to="/integrations">Integrations</Link> page.</div>}
      <ErrorNotice error={error} onRetry={reload} />
      {!data ? <Loading /> : (
        <div className="inbox">
          <section className="card" style={{ padding: 0 }} aria-label="Conversations">
            {data.items.length === 0 && <p className="muted" style={{ padding: 16 }}>No conversations yet. Incoming WhatsApp messages appear here automatically.</p>}
            <div className="conv-list">
              {data.items.map((c) => (
                <Link key={c.id} to={`/inbox/${c.id}`} className={`conv-item ${c.id === id ? 'active' : ''}`} aria-current={c.id === id ? 'page' : undefined}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <strong>{fullName(c)}</strong>
                    {c.unread_count > 0 && <Badge tone="danger">{c.unread_count} new</Badge>}
                  </div>
                  <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.last_message ? `${c.last_message.direction === 'inbound' ? '' : 'You: '}${c.last_message.body}` : '—'}</div>
                  <div className="tiny muted">{c.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'} · {c.owner_name || 'Unassigned'} · {ago(c.last_message_at)}</div>
                </Link>
              ))}
            </div>
          </section>
          <section className="card" aria-label="Conversation">
            {active ? (
              <>
                <div className="card-header"><h2><Link to={`/contacts/${active.contact_id}`}>{fullName(active)}</Link></h2><span className="small muted">{active.phone}</span></div>
                <Conversation key={active.id} conversationId={active.id} contactId={active.contact_id} optedOut={active.opted_out} ownerName={active.owner_name} />
              </>
            ) : <p className="muted">{data.items.length ? 'Choose a conversation.' : ''}</p>}
            {!active && data.items[0] && <button className="btn" onClick={() => nav(`/inbox/${data.items[0].id}`)}>Open latest conversation</button>}
          </section>
        </div>
      )}
    </div>
  );
}

export function Appointments() {
  const [range, setRange] = useState('upcoming');
  const { data, error, reload } = useApi(`/appointments${qs({ range: range === 'upcoming' ? undefined : range })}`, { live: ['appointments'] });
  return (
    <div>
      <PageHeader title="Appointments" subtitle="Booked on employees’ real Google Calendars. Book from a contact or opportunity page." />
      <Tabs value={range} onChange={setRange} tabs={[{ value: 'upcoming', label: 'Upcoming' }, { value: 'week', label: 'Next 7 days' }, { value: 'past', label: 'Past' }]} />
      <ErrorNotice error={error} onRetry={reload} />
      {!data ? <Loading /> : <section className="card"><AppointmentsList items={data.items} onChange={reload} /></section>}
    </div>
  );
}

export function Payments() {
  const [sp, setSp] = useSearchParams();
  const { data, error, reload } = useApi(`/payments${qs(Object.fromEntries(sp.entries()))}`, { live: ['payments'] });
  const nav = useNavigate();
  const preset = sp.get('preset');
  return (
    <div>
      <PageHeader title="Payments" subtitle="Payment requests sent through Stripe. Collected = confirmed by Stripe’s webhook, minus refunds." />
      <div className="row" style={{ marginBottom: 12 }}>
        <select aria-label="Status" style={{ width: 'auto' }} value={preset ? 'collected_month' : sp.get('status') || ''} onChange={(e) => setSp(e.target.value === 'collected_month' ? { preset: 'collected_month' } : e.target.value ? { status: e.target.value } : {})}>
          <option value="">All payments</option><option value="collected_month">Received this month</option><option value="pending">Awaiting payment</option><option value="paid">Paid</option><option value="failed">Failed</option><option value="expired">Expired / abandoned</option><option value="refunded">Refunded</option><option value="partially_refunded">Partially refunded</option>
        </select>
      </div>
      <ErrorNotice error={error} onRetry={reload} />
      {!data ? <Loading /> : (
        <>
          {preset === 'collected_month' && <p className="small">Total collected (net of refunds): <strong>{Object.entries(data.items.reduce((a, p) => { a[p.currency] = (a[p.currency] || 0) + p.amount_cents - p.refunded_cents; return a; }, {})).map(([c, v]) => cents(v, c)).join(' + ') || '0'}</strong></p>}
          <Table caption="Payments" rows={data.items} onRowClick={(p) => nav(`/opportunities/${p.opportunity_id}`)} empty="No payments." columns={[
            { key: 'amount', label: 'Amount', render: (p) => <strong>{cents(p.amount_cents, p.currency)}</strong> },
            { key: 'status', label: 'Status', render: (p) => <div><PayStatus s={p.status} />{p.refunded_cents > 0 && <div className="tiny">refunded {cents(p.refunded_cents, p.currency)}</div>}</div> },
            { key: 'opp', label: 'Opportunity', render: (p) => p.opportunity_title },
            { key: 'contact', label: 'Customer', render: (p) => p.contact_name },
            { key: 'by', label: 'Requested by', render: (p) => p.requested_by_name || '—' },
            { key: 'ref', label: 'Stripe reference', render: (p) => <span className="mono tiny">{p.payment_intent_id || p.checkout_session_id || '—'}</span> },
            { key: 'date', label: 'Date', render: (p) => fmtDateTime(p.paid_at || p.created_at) },
          ]} />
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(pg) => setSp({ ...Object.fromEntries(sp), page: pg })} />
        </>
      )}
    </div>
  );
}
