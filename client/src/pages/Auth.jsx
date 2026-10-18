// Login, sign-up, invitation acceptance (F1.1).
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get, post } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { browserTimeZone } from '../lib/format.js';
import { Button, Field, ErrorNotice, Toasts, Loading } from '../components/ui.jsx';
import { Dial, Wordmark } from '../components/Brand.jsx';

function Shell({ title, subtitle, children }) {
  return (
    <div className="lux">
      <aside className="lux-hero" aria-label="About LeadGuard">
        <Dial />
        <div className="lux-hero-inner">
          <Wordmark light />
          <div className="lux-copy">
            <p className="lux-eyebrow">Lead assurance platform</p>
            <h2 className="lux-title">Every lead.<br />Every moment.<br /><em>Accounted for.</em></h2>
            <p className="lux-sub">Timed acknowledgement, automatic escalation and a tamper-proof history — with WhatsApp, Stripe and Google Calendar built in.</p>
          </div>
          <ul className="lux-points">
            <li><span>01</span>One accountable owner for every lead</li>
            <li><span>02</span>Escalates on its own when ignored</li>
            <li><span>03</span>Every action recorded, nothing lost</li>
          </ul>
          <p className="lux-foot">NASCON 2026 · Built with precision</p>
        </div>
      </aside>
      <main className="lux-panel">
        <div className="lux-form">
          <div className="lux-mobile-brand"><Wordmark /></div>
          <h1 className="lux-h1">{title}</h1>
          {subtitle && <p className="lux-lead">{subtitle}</p>}
          {children}
        </div>
      </main>
      <Toasts />
    </div>
  );
}

function useSubmit(fn) {
  const { refreshMe } = useApp();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await fn(); await refreshMe(); nav('/'); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return { submit, busy, error };
}

export function Login() {
  const [f, setF] = useState({ email: '', password: '' });
  const [show, setShow] = useState(false);
  const { submit, busy, error } = useSubmit(() => post('/auth/login', f));
  return (
    <Shell title="Welcome back" subtitle="Sign in to your workspace.">
      <form onSubmit={submit} className="stack lux-fields">
        <ErrorNotice error={error} />
        <Field label="Email">{(a) => <input {...a} type="email" autoComplete="email" placeholder="you@company.com" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required autoFocus />}</Field>
        <Field label="Password">{(a) => (
          <div className="pw-wrap">
            <input {...a} type={show ? 'text' : 'password'} autoComplete="current-password" placeholder="••••••••" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required />
            <button type="button" className="pw-toggle" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>{show ? 'Hide' : 'Show'}</button>
          </div>
        )}</Field>
        <Button type="submit" className="primary big lux-submit" busy={busy}>Sign in</Button>
        <div className="lux-divider"><span>New to LeadGuard?</span></div>
        <Link className="btn big lux-secondary" to="/signup">Create a workspace</Link>
      </form>
    </Shell>
  );
}

export function Signup() {
  const [f, setF] = useState({ workspaceName: '', name: '', email: '', password: '', timezone: browserTimeZone() });
  const { submit, busy, error } = useSubmit(() => post('/auth/signup', f));
  const bind = (k) => ({ value: f[k], onChange: (e) => setF({ ...f, [k]: e.target.value }) });
  return (
    <Shell title="Create your workspace" subtitle="You will be the Owner. Invite your team afterwards.">
      <form onSubmit={submit} className="stack lux-fields">
        <ErrorNotice error={error} />
        <Field label="Company name">{(a) => <input {...a} {...bind('workspaceName')} required minLength={2} autoFocus />}</Field>
        <Field label="Your name">{(a) => <input {...a} {...bind('name')} required autoComplete="name" />}</Field>
        <Field label="Email">{(a) => <input {...a} type="email" {...bind('email')} required autoComplete="email" />}</Field>
        <Field label="Password" help="At least 8 characters">{(a) => <input {...a} type="password" {...bind('password')} required minLength={8} autoComplete="new-password" />}</Field>
        <p className="small muted" style={{ margin: 0 }}>Time zone: {f.timezone}</p>
        <Button type="submit" className="primary big lux-submit" busy={busy}>Create workspace</Button>
        <p className="small lux-alt">Already have an account? <Link to="/login">Sign in</Link></p>
      </form>
    </Shell>
  );
}

export function AcceptInvite() {
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [f, setF] = useState({ name: '', password: '' });
  useEffect(() => { get(`/auth/invite/${token}`).then((d) => { setInfo(d); setF((x) => ({ ...x, name: d.name })); }).catch(setLoadErr); }, [token]);
  const { submit, busy, error } = useSubmit(() => post('/auth/accept-invite', { token, ...f, timezone: browserTimeZone() }));
  if (loadErr) return <Shell title="Invitation"><ErrorNotice error={loadErr} /><p><Link to="/login">Go to login</Link></p></Shell>;
  if (!info) return <Shell title="Invitation"><Loading /></Shell>;
  return (
    <Shell title={`Join ${info.workspace}`} subtitle={`You were invited as ${info.email}. Choose a password to finish.`}>
      <form onSubmit={submit} className="stack lux-fields">
        <ErrorNotice error={error} />
        <Field label="Your name">{(a) => <input {...a} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />}</Field>
        <Field label="Password" help="At least 8 characters">{(a) => <input {...a} type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={8} autoComplete="new-password" autoFocus />}</Field>
        <Button type="submit" className="primary big lux-submit" busy={busy}>Join workspace</Button>
      </form>
    </Shell>
  );
}
