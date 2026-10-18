// Central integrations page (I5.1): status, last success, recent errors, limits, per-workspace credentials,
// synchronization history (I5.4) and escalation alert deliveries (I4.4).
import { useState } from 'react';
import { api, post, put, qs } from '../lib/api.js';
import { useApi, useAction, useApp } from '../lib/app.jsx';
import { ago, fmtDateTime } from '../lib/format.js';
import { Badge, Button, ErrorNotice, Field, Loading, PageHeader, Pagination, Table, Tabs } from '../components/ui.jsx';

const STATUS = { connected: ['Connected', 'ok'], error: ['Error', 'danger'], not_connected: ['Not connected', 'muted'] };

const FORM = {
  twilio: [
    { key: 'accountSid', label: 'Account SID', help: 'Twilio Console → Account Info (starts with AC)' },
    { key: 'authToken', label: 'Auth Token', secret: true, help: 'Twilio Console → Account Info → Auth Token' },
    { key: 'fromNumber', label: 'Sender number', help: 'WhatsApp sandbox: +14155238886 (see Messaging → Try it out → WhatsApp)' },
    { key: 'channel', label: 'Channel', options: [['whatsapp', 'WhatsApp (sandbox)'], ['sms', 'SMS']] },
  ],
  stripe: [
    { key: 'secretKey', label: 'Secret key (test mode)', secret: true, help: 'Stripe Dashboard → Developers → API keys → Secret key (sk_test_…)' },
    { key: 'webhookSecret', label: 'Webhook signing secret', secret: true, help: 'After adding the webhook endpoint below: Developers → Webhooks → your endpoint → Signing secret (whsec_…)' },
  ],
  google: [
    { key: 'clientId', label: 'OAuth Client ID', help: 'Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client IDs' },
    { key: 'clientSecret', label: 'OAuth Client secret', secret: true },
  ],
  telegram: [
    { key: 'botToken', label: 'Bot token', secret: true, help: 'From @BotFather after /newbot (looks like 123456:ABC…)' },
  ],
};

const STEPS = {
  twilio: ['Create a free Twilio account and open Messaging → Try it out → Send a WhatsApp message.', 'From your phone, send the join phrase shown there to the sandbox number.', 'Paste Account SID, Auth Token and the sandbox number here and save (we test the credentials before saving).', 'In the sandbox settings, set “When a message comes in” to the Incoming webhook URL below (HTTP POST).'],
  stripe: ['In the Stripe Dashboard make sure “Test mode” is on.', 'Paste the test Secret key here and save.', 'Developers → Webhooks → Add endpoint: paste the endpoint URL below and select the listed events.', 'Copy the endpoint’s Signing secret (whsec_…) here and save again.'],
  google: ['Google Cloud Console: create a project and enable “Google Calendar API”.', 'Configure the OAuth consent screen (External, Testing) and add each employee’s Gmail as a test user.', 'Create an OAuth client ID of type “Web application” with the redirect URI below.', 'Paste Client ID and secret here. Each employee then connects their own calendar from their Profile.'],
  telegram: ['In Telegram, open @BotFather and send /newbot. Choose a name and a username ending in “bot”.', 'Paste the bot token here and save (we check it with Telegram).', 'Each employee links their own chat from Profile → Telegram.'],
};

function ProviderCard({ item, canManage, onSaved }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(() => Object.fromEntries(FORM[item.provider].map((x) => [x.key, x.secret ? '' : (item.config?.[x.key] ?? (x.options ? x.options[0][0] : ''))])));
  const [run, busy] = useAction();
  const [st, tone] = STATUS[item.status];
  const save = async (e) => {
    e.preventDefault();
    const body = {};
    for (const [k, v] of Object.entries(f)) if (v !== '') body[k] = v;
    const ok = await run(() => put(`/integrations/${item.provider}`, body), { success: (r) => `Connected — ${r.detail}` });
    if (ok) { setOpen(false); onSaved(); }
  };
  return (
    <section className="card stack" aria-labelledby={`int-${item.provider}`}>
      <div className="card-header">
        <h2 id={`int-${item.provider}`}>{item.name}</h2>
        <Badge tone={tone}>{st}</Badge>
      </div>
      <p className="muted small" style={{ margin: 0 }}>{item.purpose} Last worked: <strong>{item.lastSuccessAt ? `${ago(item.lastSuccessAt)}` : 'never'}</strong>.</p>
      <div className="grid grid-2" style={{ gap: 10 }}>
        <div><div className="label-text small">What it can do</div><ul className="small" style={{ margin: '4px 0', paddingLeft: 18 }}>{item.can.map((c) => <li key={c}>{c}</li>)}</ul></div>
        <div><div className="label-text small">Limits to know</div><ul className="small" style={{ margin: '4px 0', paddingLeft: 18 }}>{item.limits.map((c) => <li key={c}>{c}</li>)}</ul></div>
      </div>
      {canManage && (
        <>
          {item.lastError && item.status === 'error' && <div className="notice danger small" role="alert"><div><strong>Last error</strong> ({ago(item.lastErrorAt)}): {item.lastError}</div></div>}
          {item.config && Object.keys(item.config).length > 0 && <dl className="kv small">{Object.entries(item.config).map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd className="mono">{String(v)}</dd></div>)}</dl>}
          {Object.keys(item.urls || {}).length > 0 && (
            <div className="stack" style={{ gap: 6 }}>
              {Object.entries(item.urls).map(([label, url]) => (
                <div key={label}><div className="tiny label-text">{label}</div><div className="row"><span className="mono small" style={{ flex: 1 }}>{url}</span>{url.startsWith('http') && <button className="btn sm" onClick={() => navigator.clipboard?.writeText(url)}>Copy</button>}</div></div>
              ))}
            </div>
          )}
          {item.recentErrors?.length > 0 && (
            <details><summary className="small">Recent errors ({item.recentErrors.length})</summary>
              <ul className="small">{item.recentErrors.map((e, i) => <li key={i}>{fmtDateTime(e.created_at)} · {e.kind} · {e.detail}</li>)}</ul>
            </details>
          )}
          <details><summary className="small">How to set it up</summary><ol className="small">{STEPS[item.provider].map((s) => <li key={s}>{s}</li>)}</ol></details>
          <div className="row">
            <button className="btn sm primary" aria-expanded={open} onClick={() => setOpen(!open)}>{item.status === 'not_connected' ? 'Connect' : 'Change credentials'}</button>
            {item.status !== 'not_connected' && <Button className="sm" busy={busy} onClick={() => run(() => post(`/integrations/${item.provider}/test`).then((r) => { onSaved(); if (!r.ok) throw new Error(r.detail); return r; }), { success: (r) => `Working: ${r.detail}` })}>Test connection</Button>}
            {item.status !== 'not_connected' && <Button className="sm" busy={busy} onClick={() => { if (window.confirm('Disconnect this integration? Its credentials will be deleted.')) run(() => api(`/integrations/${item.provider}`, { method: 'DELETE' }).then(onSaved), { success: 'Disconnected' }); }}>Disconnect</Button>}
          </div>
          {open && (
            <form className="stack card" style={{ background: 'var(--surface-2)' }} onSubmit={save}>
              {FORM[item.provider].map((x) => (
                <Field key={x.key} label={x.label} help={x.secret && item.config?.[x.key] ? `Saved (${item.config[x.key]}). Leave empty to keep it.` : x.help}>
                  {(a) => (x.options
                    ? <select {...a} value={f[x.key]} onChange={(e) => setF({ ...f, [x.key]: e.target.value })}>{x.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                    : <input {...a} type={x.secret ? 'password' : 'text'} autoComplete="off" value={f[x.key]} onChange={(e) => setF({ ...f, [x.key]: e.target.value })} />)}
                </Field>
              ))}
              <p className="tiny muted" style={{ margin: 0 }}>Secrets are encrypted (AES-256-GCM) on the server, never sent back to the browser, and only the last 4 characters are shown.</p>
              <div className="row end"><button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button><Button type="submit" className="primary" busy={busy}>Test & save</Button></div>
            </form>
          )}
        </>
      )}
    </section>
  );
}

function History() {
  const [p, setP] = useState({ page: 1 });
  const { data, error, reload } = useApi(`/integration-events${qs(p)}`, { live: ['integrations'] });
  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <select aria-label="Provider" style={{ width: 'auto' }} value={p.provider || ''} onChange={(e) => setP({ ...p, provider: e.target.value, page: 1 })}><option value="">All providers</option>{['twilio', 'stripe', 'google', 'telegram'].map((x) => <option key={x}>{x}</option>)}</select>
        <select aria-label="Result" style={{ width: 'auto' }} value={p.result || ''} onChange={(e) => setP({ ...p, result: e.target.value, page: 1 })}><option value="">All results</option>{['ok', 'error', 'rejected', 'duplicate', 'retrying'].map((x) => <option key={x}>{x}</option>)}</select>
        <select aria-label="Direction" style={{ width: 'auto' }} value={p.direction || ''} onChange={(e) => setP({ ...p, direction: e.target.value, page: 1 })}><option value="">In & out</option><option value="inbound">Inbound (webhooks)</option><option value="outbound">Outbound (calls)</option></select>
      </div>
      <ErrorNotice error={error} onRetry={reload} />
      {!data ? <Loading /> : (
        <>
          <Table caption="Synchronization history" rows={data.items} empty="No integration events yet." columns={[
            { key: 't', label: 'Time', render: (e) => <span className="nowrap">{fmtDateTime(e.created_at, { fmt: { second: '2-digit' } })}</span> },
            { key: 'p', label: 'Provider', render: (e) => e.provider },
            { key: 'd', label: 'Direction', render: (e) => (e.direction === 'inbound' ? '↓ in' : '↑ out') },
            { key: 'k', label: 'Event', render: (e) => <span className="mono small">{e.kind}</span> },
            { key: 'r', label: 'Result', render: (e) => <Badge tone={{ ok: 'ok', error: 'danger', rejected: 'danger', duplicate: 'muted', retrying: 'warn' }[e.result]}>{e.result}</Badge> },
            { key: 'ref', label: 'Reference', render: (e) => <span className="mono tiny">{e.reference || '—'}</span> },
            { key: 'det', label: 'Detail', render: (e) => <span className="small">{e.detail || (e.http_status ? `HTTP ${e.http_status}` : '—')}</span> },
          ]} />
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(page) => setP({ ...p, page })} />
        </>
      )}
    </div>
  );
}

function Alerts() {
  const { data, error, reload } = useApi('/alerts', { live: ['alerts', 'leads'] });
  const [run] = useAction();
  if (!data) return error ? <ErrorNotice error={error} /> : <Loading />;
  return (
    <Table caption="Escalation alerts" rows={data.items} empty="No escalation alerts yet." columns={[
      { key: 't', label: 'Time', render: (a) => fmtDateTime(a.created_at) },
      { key: 'u', label: 'Employee', render: (a) => a.user_name },
      { key: 'l', label: 'Lead', render: (a) => a.lead_title || '—' },
      { key: 's', label: 'Status', render: (a) => <Badge tone={{ sent: 'ok', failed: 'danger', skipped: 'warn', pending: 'muted' }[a.status]}>{a.status}</Badge> },
      { key: 'n', label: 'Attempts', render: (a) => a.attempts },
      { key: 'e', label: 'Detail', render: (a) => <span className="small">{a.status === 'sent' ? `Delivered ${fmtDateTime(a.sent_at, { fmt: { second: '2-digit' } })}` : a.last_error || '—'}</span> },
      { key: 'x', label: '', render: (a) => ['failed', 'skipped'].includes(a.status) && <button className="btn sm" onClick={() => run(() => post(`/alerts/${a.id}/retry`).then(reload), { success: 'Retry queued' })}>Retry</button> },
    ]} />
  );
}

export default function Integrations() {
  const { can } = useApp();
  const { data, error, reload } = useApi('/integrations', { live: ['integrations'] });
  const [tab, setTab] = useState('list');
  const manage = can('integrations.manage');
  return (
    <div>
      <PageHeader title="Integrations" subtitle="Real external services in sandbox / test mode. Each workspace uses its own credentials. If one provider is down, everything else keeps working." />
      {manage && <Tabs value={tab} onChange={setTab} tabs={[{ value: 'list', label: 'Integrations' }, { value: 'history', label: 'Synchronization history' }, { value: 'alerts', label: 'Escalation alerts' }]} />}
      <ErrorNotice error={error} onRetry={reload} />
      {tab === 'list' && (!data ? <Loading /> : (
        <div className="grid grid-2">{data.items.map((it) => <ProviderCard key={it.provider} item={it} canManage={data.canManage} onSaved={reload} />)}</div>
      ))}
      {tab === 'history' && <History />}
      {tab === 'alerts' && <Alerts />}
    </div>
  );
}
