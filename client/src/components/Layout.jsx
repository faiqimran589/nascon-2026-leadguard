// App shell: sidebar navigation, top bar with availability switch, notifications and user menu.
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api, patch, post } from '../lib/api.js';
import { useApi, useAction, useApp } from '../lib/app.jsx';
import { AVAIL, ago } from '../lib/format.js';
import { Toasts } from './ui.jsx';
import { Wordmark } from './Brand.jsx';

function Nav({ onNavigate }) {
  const { can } = useApp();
  const { data: rec } = useApi('/leads/recovery', { live: ['leads'] });
  const recCount = rec?.items?.length || 0;
  const L = ({ to, icon, children, count }) => (
    <NavLink to={to} end={to === '/'} onClick={onNavigate}><span aria-hidden>{icon}</span>{children}{count > 0 && <span className="count" aria-label={`${count} items`}>{count}</span>}</NavLink>
  );
  return (
    <nav className="nav" aria-label="Main">
      <L to="/" icon={'📊'}>Dashboard</L>
      <L to="/leads" icon={'✨'}>Leads</L>
      <L to="/recovery" icon={'🚨'} count={recCount}>Recovery queue</L>
      <L to="/inbox" icon={'💬'}>Inbox</L>
      <div className="nav-section">CRM</div>
      <L to="/contacts" icon={'👤'}>Contacts</L>
      <L to="/companies" icon={'🏢'}>Companies</L>
      <L to="/opportunities" icon={'🎯'}>Opportunities</L>
      <L to="/appointments" icon={'📅'}>Appointments</L>
      <L to="/payments" icon={'💳'}>Payments</L>
      <div className="nav-section">Workspace</div>
      <L to="/team" icon={'👥'}>Team</L>
      {can('users.manage') && <L to="/settings/roles" icon={'🔐'}>Roles & permissions</L>}
      {can('pipeline.manage') && <L to="/settings/pipelines" icon={'🧱'}>Pipelines & fields</L>}
      <L to="/settings/rules" icon={'⚙️'}>Assignment rules</L>
      <L to="/integrations" icon={'🔌'}>Integrations</L>
      {can('audit.view') && <L to="/audit" icon={'📜'}>Audit log</L>}
      <L to="/settings/workspace" icon={'🌐'}>Workspace & web form</L>
    </nav>
  );
}

function AvailabilitySwitch() {
  const { me, refreshMe, toast } = useApp();
  const [run, busy] = useAction();
  const change = async (v) => {
    const out = await run(() => patch(`/users/${me.user.id}/availability`, { availability: v }));
    if (out) {
      const m = out.moved;
      const moved = m ? m.unacknowledged + m.acknowledgedMoved : 0;
      toast(`Status: ${AVAIL[v]}${moved ? ` — ${moved} of your lead(s) were reassigned` : ''}${m?.acknowledgedKept ? ` — ${m.acknowledgedKept} acknowledged lead(s) stay with you (workspace rule)` : ''}`, 'success');
      refreshMe();
    }
  };
  return (
    <label className="row" style={{ gap: 6 }}>
      <span className="small muted hide-sm">My status</span>
      <select value={me.user.availability} disabled={busy} onChange={(e) => change(e.target.value)} style={{ width: 'auto' }} aria-label="My availability">
        {Object.entries(AVAIL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
    </label>
  );
}

function Bell() {
  const [open, setOpen] = useState(false);
  const { data, reload } = useApi('/notifications', { live: ['notification', 'leads'] });
  const nav = useNavigate();
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const unread = data?.unread || 0;
  return (
    <div className="bell" ref={ref} style={{ position: 'relative' }}>
      <button className="btn ghost" aria-expanded={open} aria-label={`Notifications, ${unread} unread`} onClick={() => setOpen(!open)}>
        <span aria-hidden>{'🔔'}</span>{unread > 0 && <span className="dot" aria-hidden>{unread}</span>}
      </button>
      {open && (
        <div className="dropdown" role="dialog" aria-label="Notifications">
          <div className="row" style={{ padding: '10px 14px', justifyContent: 'space-between' }}>
            <strong>Notifications</strong>
            {unread > 0 && <button className="btn sm" onClick={() => post('/notifications/read-all').then(reload)}>Mark all read</button>}
          </div>
          {(data?.items || []).length === 0 && <p className="muted small" style={{ padding: '0 14px 12px' }}>Nothing yet.</p>}
          {(data?.items || []).map((n) => (
            <a key={n.id} href={n.link || '#'} className={`item ${n.read_at ? '' : 'unread'}`} onClick={(e) => { e.preventDefault(); setOpen(false); if (n.link) nav(n.link); }}>
              <div style={{ fontWeight: 600 }}>{n.title}</div>
              {n.body && <div className="small muted">{n.body}</div>}
              <div className="tiny muted">{ago(n.created_at)}</div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Layout() {
  const { me, setMe, online } = useApp();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => setOpen(false), [loc.pathname]);
  const logout = async () => { await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {}); setMe(null); nav('/login'); };
  return (
    <div className="app">
      <a href="#main" className="skip-link">Skip to content</a>
      {open && <div className="scrim" onClick={() => setOpen(false)} aria-hidden />}
      <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="Sidebar">
        <div className="brand"><Wordmark light /></div>
        <div className="ws-name">{me.workspace.name}</div>
        <Nav onNavigate={() => setOpen(false)} />
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="btn ghost menu-btn" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)}>{'☰'}</button>
          {!online && <span className="badge b-warn" role="status">Reconnecting live updates…</span>}
          <span className="spacer" />
          <AvailabilitySwitch />
          <Bell />
          <NavLink to="/profile" className="btn ghost hide-sm" aria-label="My profile">{me.user.name}</NavLink>
          <button className="btn sm" onClick={logout}>Log out</button>
        </header>
        <main id="main" className="content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
      <Toasts />
    </div>
  );
}
