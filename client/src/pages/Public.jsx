// Public pages: lead capture web form (F3.1) and Stripe return page.
import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { get, api } from '../lib/api.js';
import { Button, Field, ErrorNotice, Loading } from '../components/ui.jsx';

export function PublicForm() {
  const { token } = useParams();
  const [ws, setWs] = useState(null);
  const [err, setErr] = useState(null);
  const [f, setF] = useState({ name: '', email: '', phone: '', message: '', website: '' });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [fieldErr, setFieldErr] = useState({});
  useEffect(() => { get(`/public/forms/${token}`).then(setWs).catch(setErr); }, [token]);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null); setFieldErr({});
    try { const r = await api(`/public/forms/${token}`, { method: 'POST', body: f }); setDone(r.message); }
    catch (x) { setErr(x); setFieldErr(x.data?.fields || {}); } finally { setBusy(false); }
  };
  const bind = (k) => ({ value: f[k], onChange: (e) => setF({ ...f, [k]: e.target.value }) });
  return (
    <div className="auth-wrap">
      <main className="auth-card">
        {!ws && !err && <Loading />}
        {!ws && err && <ErrorNotice error={err} />}
        {ws && done && <div className="notice ok" role="status"><span aria-hidden>{'✅'}</span> {done}</div>}
        {ws && !done && (
          <>
            <h1>Contact {ws.workspace}</h1>
            <p className="muted">Leave your details and we will get back to you quickly.</p>
            <form onSubmit={submit} className="stack" noValidate>
              <ErrorNotice error={err} />
              <Field label="Your name *" error={fieldErr.name}>{(a) => <input {...a} {...bind('name')} required autoComplete="name" />}</Field>
              <Field label="Email" error={fieldErr.email}>{(a) => <input {...a} type="email" {...bind('email')} autoComplete="email" />}</Field>
              <Field label="Phone (WhatsApp)" help="e.g. +923001234567" error={fieldErr.phone}>{(a) => <input {...a} type="tel" {...bind('phone')} autoComplete="tel" />}</Field>
              <Field label="How can we help?">{(a) => <textarea {...a} {...bind('message')} maxLength={3000} />}</Field>
              <div aria-hidden style={{ position: 'absolute', left: '-5000px' }}><label>Website<input tabIndex={-1} autoComplete="off" {...bind('website')} /></label></div>
              <Button type="submit" className="primary big" busy={busy}>Send request</Button>
            </form>
          </>
        )}
      </main>
    </div>
  );
}

export function PayThanks() {
  const [sp] = useSearchParams();
  const ok = sp.get('status') === 'success';
  return (
    <div className="auth-wrap">
      <main className="auth-card">
        <h1>{ok ? 'Thank you for your payment' : 'Payment not completed'}</h1>
        <p>{ok ? 'Your payment was submitted to Stripe. You will receive a confirmation shortly.' : 'You left the payment page before paying. You can use the same link again until it expires.'}</p>
      </main>
    </div>
  );
}
