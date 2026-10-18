// Login, sign-up, invitation acceptance (F1.1).
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get, post } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { browserTimeZone } from '../lib/format.js';
import { Button, Field, ErrorNotice, Toasts, Loading } from '../components/ui.jsx';

function Shell({ title, children }) {
  return (
    <div className="auth-wrap">
      <main className="auth-card">
        <div className="brand"><span className="brand-mark" aria-hidden style={{ color: '#fff' }}>{'✓'}</span>LeadGuard</div>
        <h1>{title}</h1>
        {children}
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
  const { submit, busy, error } = useSubmit(() => post('/auth/login', f));
  return (
    <Shell title="Log in">
      <p className="muted">Every lead gets an owner. Every action is traceable.</p>
      <form onSubmit={submit} className="stack">
        <ErrorNotice error={error} />
        <Field label="Email">{(a) => <input {...a} type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required autoFocus />}</Field>
        <Field label="Password">{(a) => <input {...a} type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required />}</Field>
        <Button type="submit" className="primary big" busy={busy}>Log in</Button>
        <p className="small">New company? <Link to="/signup">Create a workspace</Link></p>
      </form>
    </Shell>
  );
}

export function Signup() {
  const [f, setF] = useState({ workspaceName: '', name: '', email: '', password: '', timezone: browserTimeZone() });
  const { submit, busy, error } = useSubmit(() => post('/auth/signup', f));
  const bind = (k) => ({ value: f[k], onChange: (e) => setF({ ...f, [k]: e.target.value }) });
  return (
    <Shell title="Create your workspace">
      <p className="muted">You will be the Owner. You can invite your team afterwards.</p>
      <form onSubmit={submit} className="stack">
        <ErrorNotice error={error} />
        <Field label="Company name">{(a) => <input {...a} {...bind('workspaceName')} required minLength={2} autoFocus />}</Field>
        <Field label="Your name">{(a) => <input {...a} {...bind('name')} required autoComplete="name" />}</Field>
        <Field label="Email">{(a) => <input {...a} type="email" {...bind('email')} required autoComplete="email" />}</Field>
        <Field label="Password" help="At least 8 characters">{(a) => <input {...a} type="password" {...bind('password')} required minLength={8} autoComplete="new-password" />}</Field>
        <p className="small muted" style={{ margin: 0 }}>Time zone: {f.timezone}</p>
        <Button type="submit" className="primary big" busy={busy}>Create workspace</Button>
        <p className="small">Already have an account? <Link to="/login">Log in</Link></p>
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
    <Shell title={`Join ${info.workspace}`}>
      <p className="muted">You were invited as <strong>{info.email}</strong>. Choose a password to finish.</p>
      <form onSubmit={submit} className="stack">
        <ErrorNotice error={error} />
        <Field label="Your name">{(a) => <input {...a} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />}</Field>
        <Field label="Password" help="At least 8 characters">{(a) => <input {...a} type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={8} autoComplete="new-password" autoFocus />}</Field>
        <Button type="submit" className="primary big" busy={busy}>Join workspace</Button>
      </form>
    </Shell>
  );
}
