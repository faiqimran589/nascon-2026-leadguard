// Operational dashboard (F5): live figures, drill-down, role-aware scope, show/hide remembered per user.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, qs } from '../lib/api.js';
import { useApi, useApp } from '../lib/app.jsx';
import { cents, duration, fmtDateTime, money, AVAIL } from '../lib/format.js';
import { Avail, ErrorNotice, Loading, PageHeader } from '../components/ui.jsx';

const FIGURES = [
  ['new_leads', 'New leads today'], ['response', 'Avg. time to first response'], ['recovery', 'Recovery queue'],
  ['escalations', 'Escalations (24h)'], ['collected', 'Payments received this month'], ['projected', 'Projected revenue'],
  ['pipeline', 'Open pipeline by stage'], ['availability', 'Employee availability'], ['appointments', 'Upcoming appointments'],
];

export default function Dashboard() {
  const { me, refreshMe, toast } = useApp();
  const [scope, setScope] = useState(null);
  const effective = scope || 'company';
  const { data, error, loading, reload } = useApi(`/dashboard${qs({ scope: effective })}`, { live: ['leads', 'crm', 'payments', 'appointments', 'team', 'dashboard'] });
  const nav = useNavigate();
  const [customize, setCustomize] = useState(false);
  const hidden = new Set(me.user.dashboardPrefs?.hidden || []);
  const show = (k) => !hidden.has(k);
  const toggle = async (k) => {
    const next = new Set(hidden); if (next.has(k)) next.delete(k); else next.add(k);
    try { await api('/me', { method: 'PATCH', body: { dashboardPrefs: { hidden: [...next] } } }); await refreshMe(); } catch (e) { toast(e.message, 'error'); }
  };
  if (!data && loading) return <Loading />;
  if (!data) return <ErrorNotice error={error} onRetry={reload} />;
  const personal = data.scope === 'personal';
  const sc = personal ? '&scope=personal' : '';
  const stagesByPipe = data.pipelineByStage.reduce((acc, s) => { (acc[s.pipeline] ||= []).push(s); return acc; }, {});
  const maxVal = Math.max(1, ...data.pipelineByStage.map((s) => (data.valuesMasked ? s.count : s.value)));
  const Stat = ({ k, label, value, hint, to, alert }) => show(k) && (
    <button className={`stat ${alert ? 'alert' : ''}`} onClick={() => to && nav(to)} aria-label={`${label}: ${value}. ${to ? 'Open the list' : ''}`}>
      <span className="label">{label}{to && <span aria-hidden className="tiny">↗</span>}</span>
      <span className="value">{value}</span>
      {hint && <span className="hint">{hint}</span>}
    </button>
  );
  return (
    <div className="stack" style={{ gap: 16 }}>
      <PageHeader title={`Good to see you, ${me.user.name.split(' ')[0]}`} subtitle={`${personal ? 'Your personal figures' : 'Company-wide figures'} · live · times in ${data.timezone}`}>
        {data.canCompany && (
          <div className="dash-toggle" role="group" aria-label="Scope">
            <button className="btn sm" aria-pressed={!personal} onClick={() => setScope('company')}>Company</button>
            <button className="btn sm" aria-pressed={personal} onClick={() => setScope('personal')}>Just me</button>
          </div>
        )}
        <button className="btn sm" aria-expanded={customize} onClick={() => setCustomize(!customize)}>Customize</button>
      </PageHeader>
      {customize && (
        <div className="card">
          <h3>Show or hide figures</h3>
          <p className="muted small">Your choice is saved to your account and remembered on every device.</p>
          <div className="row">{FIGURES.map(([k, l]) => <label key={k} className="check chip"><input type="checkbox" checked={show(k)} onChange={() => toggle(k)} /> {l}</label>)}</div>
        </div>
      )}
      <div className="grid grid-4">
        <Stat k="new_leads" label="New leads today" value={data.newLeadsToday} to={`/leads?preset=new_today${personal ? '&ownerId=me' : ''}`} hint={personal ? 'Assigned to you' : 'All sources'} />
        <Stat k="response" label="Avg. time to first response" value={duration(data.avgFirstResponseSeconds)} hint={`First assignment → first acknowledgement, ${data.responseSample} lead(s), last 30 days`} />
        <Stat k="recovery" label="Recovery queue" value={data.recoveryQueue} alert={data.recoveryQueue > 0} to={`/recovery${personal ? '?scope=personal' : ''}`} hint="Overdue, escalated 2+ times, or idle" />
        <Stat k="escalations" label="Escalations (24h)" value={data.escalations24h} to={`/escalations${personal ? '?scope=personal' : ''}`} hint="Automatic reassignments after a missed window" />
        <Stat k="collected" label="Payments received this month" value={data.collectedThisMonth.length ? data.collectedThisMonth.map((c) => cents(c.cents, c.currency)).join(' + ') : money(0, data.currency)} to={`/payments?preset=collected_month${sc}`} hint="Confirmed by Stripe webhook, minus refunds" />
        <Stat k="projected" label="Projected revenue" value={data.valuesMasked ? 'Hidden' : money(data.openPipelineValue, data.currency)} hint={`Open pipeline${data.projectedUnpaid.length ? ` + unpaid requests ${data.projectedUnpaid.map((c) => cents(c.cents, c.currency)).join(' + ')}` : ''}`} to="/opportunities?view=list" />
      </div>
      <div className="grid grid-3">
        {show('pipeline') && (
          <section className="card span-2" aria-labelledby="pipe-h">
            <div className="card-header"><h2 id="pipe-h">Open pipeline value by stage</h2>{data.valuesMasked ? <span className="badge b-muted plain">Values hidden for your role — showing counts</span> : <strong>{money(data.openPipelineValue, data.currency)}</strong>}</div>
            {Object.entries(stagesByPipe).map(([pipe, stages]) => (
              <div key={pipe} className="stack" style={{ gap: 6, marginBottom: 12 }}>
                <div className="small muted" style={{ fontWeight: 700 }}>{pipe}</div>
                {stages.map((s) => {
                  const v = data.valuesMasked ? s.count : s.value;
                  return (
                    <Link key={s.id} to={`/opportunities?view=list&stageId=${s.id}`} className="bar" style={{ color: 'inherit' }} aria-label={`${s.name}: ${s.count} opportunities${data.valuesMasked ? '' : `, ${money(s.value, data.currency)}`}`}>
                      <span className="small bar-label">{s.name}</span>
                      <span className="track"><span className="fill" style={{ width: `${(v / maxVal) * 100}%`, display: 'block' }} /></span>
                      <span className="small nowrap bar-value">{data.valuesMasked ? `${s.count} opp.` : `${money(s.value, data.currency)} · ${s.count}`}</span>
                    </Link>
                  );
                })}
              </div>
            ))}
            {!data.pipelineByStage.length && <p className="muted">No open stages.</p>}
          </section>
        )}
        {show('availability') && (
          <section className="card" aria-labelledby="av-h">
            <div className="card-header"><h2 id="av-h">Team availability</h2><Link to="/team" className="small">Team →</Link></div>
            <div className="row" style={{ marginBottom: 8 }}>{Object.entries(data.availability).map(([k, n]) => <span key={k} className="chip">{AVAIL[k]}: <strong>{n}</strong></span>)}</div>
            <ul className="timeline">
              {data.team.map((u) => (
                <li key={u.id} style={{ gridTemplateColumns: '1fr auto' }}>
                  <div><div style={{ fontWeight: 600 }}>{u.name}</div><div className="tiny muted">{u.open_leads}/{u.max_open_leads} open leads</div></div>
                  <Avail s={u.availability} />
                </li>
              ))}
            </ul>
          </section>
        )}
        {show('appointments') && (
          <section className={`card ${show('pipeline') ? 'span-all' : ''}`} aria-labelledby="ap-h">
            <div className="card-header"><h2 id="ap-h">Upcoming appointments (7 days)</h2><Link to="/appointments" className="small">All →</Link></div>
            {data.upcomingAppointments.length === 0 ? <p className="muted">Nothing booked.</p> : (
              <ul className="timeline">
                {data.upcomingAppointments.map((a) => (
                  <li key={a.id} style={{ gridTemplateColumns: '1fr' }}>
                    <div><Link to={`/contacts/${a.contact_id}`}><strong>{a.title}</strong></Link> · {a.contact}</div>
                    <div className="small muted">{fmtDateTime(a.start_at)} · with {a.employee}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
