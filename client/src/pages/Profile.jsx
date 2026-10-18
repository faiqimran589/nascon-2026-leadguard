// My profile: time zone, Google Calendar connection (I3.1), Telegram alerts (I4.3), password, sessions.
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, post, put } from '../lib/api.js';
import { useAction, useApp } from '../lib/app.jsx';
import { TIMEZONES, browserTimeZone } from '../lib/format.js';
import { Badge, Button, Field, PageHeader } from '../components/ui.jsx';

export default function Profile() {
  const { me, refreshMe, toast, setMe } = useApp();
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const [run, busy] = useAction();
  const [tz, setTz] = useState(me.user.timezone || '');
  const [tg, setTg] = useState(null);
  const [manualChat, setManualChat] = useState('');
  const [pw, setPw] = useState({ current: '', next: '' });

  useEffect(() => {
    const c = sp.get('calendar');
    if (c === 'connected') toast('Google Calendar connected', 'success');
    if (c === 'error') toast(`Calendar connection failed: ${sp.get('reason') || 'unknown error'}`, 'error');
    if (c) { setSp({}); refreshMe(); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const cal = me.user.calendar;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <PageHeader title="My profile" subtitle={`${me.user.name} · ${me.user.email} · ${me.user.roleName || me.user.level}`} />
      <div className="grid grid-2">
        <section className="card stack">
          <h2>Google Calendar</h2>
          <p className="small muted" style={{ margin: 0 }}>Connect your own Google account so customers can be booked on your real calendar. Tokens are stored only on the server, encrypted, and refreshed automatically.</p>
          <div>{!cal ? <Badge tone="muted">Not connected — you cannot be booked yet</Badge> : cal.status === 'connected' ? <Badge tone="ok">Connected as {cal.email}</Badge> : <Badge tone="danger">Needs reconnection (expired or revoked)</Badge>}</div>
          <div className="row">
            <Button className="primary" busy={busy} onClick={() => run(async () => { const r = await post('/calendar/connect'); window.location.href = r.url; })}>{cal ? 'Reconnect Google Calendar' : 'Connect Google Calendar'}</Button>
            {cal && <Button busy={busy} onClick={() => run(() => post('/calendar/disconnect').then(refreshMe), { success: 'Calendar disconnected' })}>Disconnect</Button>}
          </div>
        </section>
        <section className="card stack">
          <h2>Telegram escalation alerts</h2>
          <p className="small muted" style={{ margin: 0 }}>When a lead is escalated to you, you get a Telegram message within seconds, with a link to the lead.</p>
          <div>{me.user.telegramLinked ? <Badge tone="ok">Linked</Badge> : <Badge tone="muted">Not linked</Badge>}</div>
          {!tg && (
            <div className="row">
              <Button className="primary" busy={busy} onClick={() => run(async () => setTg(await post('/me/telegram/start')))}>{me.user.telegramLinked ? 'Re-link Telegram' : 'Link Telegram'}</Button>
              {me.user.telegramLinked && <Button busy={busy} onClick={() => run(() => post('/me/telegram/test'), { success: 'Test alert sent — check Telegram' })}>Send test alert</Button>}
              {me.user.telegramLinked && <Button busy={busy} onClick={() => run(() => api('/me/telegram', { method: 'DELETE' }).then(refreshMe), { success: 'Unlinked' })}>Unlink</Button>}
            </div>
          )}
          {tg && (
            <ol className="small stack" style={{ paddingLeft: 18 }}>
              <li>Open <a href={tg.link} target="_blank" rel="noreferrer">t.me/{tg.bot}</a> on your phone or computer and press <strong>Start</strong>.</li>
              <li>Come back and press: <Button className="sm primary" busy={busy} onClick={() => run(async () => { await post('/me/telegram/check'); setTg(null); await refreshMe(); }, { success: 'Telegram linked — a confirmation was sent to you' })}>I pressed Start</Button></li>
            </ol>
          )}
          <details><summary className="small">Enter a chat ID manually</summary>
            <form className="row" style={{ marginTop: 8 }} onSubmit={async (e) => { e.preventDefault(); const ok = await run(() => put('/me/telegram', { chatId: manualChat }), { success: 'Chat ID saved' }); if (ok) refreshMe(); }}>
              <input aria-label="Telegram chat ID" value={manualChat} onChange={(e) => setManualChat(e.target.value)} placeholder="e.g. 123456789" style={{ maxWidth: 200 }} />
              <Button type="submit" className="sm" busy={busy}>Save</Button>
            </form>
          </details>
        </section>
        <section className="card stack">
          <h2>Time zone</h2>
          <p className="small muted" style={{ margin: 0 }}>All times are shown in this zone. Your browser reports {browserTimeZone()}.</p>
          <form className="row" onSubmit={async (e) => { e.preventDefault(); const ok = await run(() => api('/me', { method: 'PATCH', body: { timezone: tz || null } }), { success: 'Time zone saved' }); if (ok) refreshMe(); }}>
            <select aria-label="Time zone" value={tz} onChange={(e) => setTz(e.target.value)} style={{ maxWidth: 280 }}>
              <option value="">Workspace default ({me.workspace.timezone})</option>{TIMEZONES.map((z) => <option key={z}>{z}</option>)}
            </select>
            <Button type="submit" busy={busy}>Save</Button>
          </form>
        </section>
        <section className="card stack">
          <h2>Security</h2>
          <form className="stack" onSubmit={async (e) => { e.preventDefault(); const ok = await run(() => post('/auth/change-password', pw), { success: 'Password changed — other sessions were signed out' }); if (ok) setPw({ current: '', next: '' }); }}>
            <Field label="Current password">{(a) => <input {...a} type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required />}</Field>
            <Field label="New password" help="At least 8 characters">{(a) => <input {...a} type="password" autoComplete="new-password" minLength={8} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required />}</Field>
            <div className="row"><Button type="submit" busy={busy}>Change password</Button></div>
          </form>
          <hr />
          <Button busy={busy} onClick={() => run(async () => { await post('/auth/logout-all'); setMe(null); nav('/login'); })}>Sign out of all devices</Button>
        </section>
      </div>
    </div>
  );
}
