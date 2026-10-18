// Reusable, accessible UI building blocks.
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../lib/app.jsx';
import { LEAD_STATUS, PAY_STATUS, MSG_STATUS, AVAIL, AVAIL_TONE, duration } from '../lib/format.js';

export function Spinner({ label = 'Loading' }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

export function Loading({ text = 'Loading…' }) {
  return <div className="loading-block"><Spinner /> {text}</div>;
}

export function ErrorNotice({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="notice danger" role="alert">
      <span aria-hidden>{'⚠️'}</span>
      <div style={{ flex: 1 }}>{error.message || String(error)}</div>
      {onRetry && <button className="btn sm" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

export function Badge({ tone = 'muted', children, plain }) {
  return <span className={`badge b-${tone} ${plain ? 'plain' : ''}`}>{children}</span>;
}

export const LeadStatus = ({ s }) => { const [t, tone] = LEAD_STATUS[s] || [s, 'muted']; return <Badge tone={tone}>{t}</Badge>; };
export const PayStatus = ({ s }) => { const [t, tone] = PAY_STATUS[s] || [s, 'muted']; return <Badge tone={tone}>{t}</Badge>; };
export const MsgStatus = ({ s }) => { const [t, tone] = MSG_STATUS[s] || [s, 'muted']; return <Badge tone={tone}>{t}</Badge>; };
export const Avail = ({ s }) => <Badge tone={AVAIL_TONE[s]}>{AVAIL[s] || s}</Badge>;

export function Button({ busy, children, className = '', ...rest }) {
  return (
    <button className={`btn ${className}`} disabled={busy || rest.disabled} aria-busy={busy || undefined} {...rest}>
      {busy && <Spinner label="Working" />}{children}
    </button>
  );
}

export function Field({ label, help, error, children, className = '', id: idProp }) {
  const auto = useId();
  const id = idProp || auto;
  const child = typeof children === 'function' ? children({ id, 'aria-invalid': error ? 'true' : undefined, 'aria-describedby': help || error ? `${id}-d` : undefined }) : children;
  return (
    <div className={`field ${className}`}>
      {label && <label htmlFor={id}>{label}</label>}
      {child}
      {(help || error) && <div id={`${id}-d`} className={error ? 'error-text' : 'help'}>{error || help}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const prev = document.activeElement;
    const el = ref.current;
    const focusable = () => el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    (el.querySelector('[autofocus]') || focusable()[0])?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const f = [...focusable()].filter((x) => !x.disabled);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close dialog">{'✕'}</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Confirm({ title, message, confirmLabel = 'Confirm', danger, onConfirm, onClose, busy, children }) {
  return (
    <Modal title={title} onClose={onClose}>
      <p>{message}</p>
      {children}
      <div className="row end" style={{ marginTop: 16 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <Button className={danger ? 'danger' : 'primary'} busy={busy} onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </Modal>
  );
}

export function Toasts() {
  const { toasts, setToasts } = useApp();
  return (
    <div className="toasts" aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.type}`} role={t.type === 'error' ? 'alert' : 'status'}>
          <span aria-hidden>{t.type === 'error' ? '⚠️' : t.type === 'success' ? '✅' : '🔔'}</span>
          <div style={{ flex: 1 }}>
            {t.text} {t.link && <Link to={t.link} onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>Open</Link>}
          </div>
          <button className="btn ghost sm" style={{ color: '#fff', minHeight: 0, padding: 2 }} aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>{'✕'}</button>
        </div>
      ))}
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }) {
  if (!total) return null;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav className="pagination" aria-label="Pagination">
      <span className="muted small">{total} record{total === 1 ? '' : 's'} · page {page} of {pages}</span>
      <div className="row">
        <button className="btn sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>← Previous</button>
        <button className="btn sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next →</button>
      </div>
    </nav>
  );
}

// Responsive table: becomes stacked cards on phones (no horizontal scrolling).
export function Table({ columns, rows, onRowClick, rowKey = 'id', empty = 'Nothing here yet.', caption }) {
  if (!rows?.length) return <div className="table-wrap"><Empty>{empty}</Empty></div>;
  return (
    <div className="table-wrap">
      <table className="table responsive">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead><tr>{columns.map((c) => <th key={c.key} scope="col" className={c.className}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r[rowKey]} className={onRowClick ? 'clickable' : ''} onClick={onRowClick ? () => onRowClick(r) : undefined}>
              {columns.map((c) => <td key={c.key} data-label={c.label} className={`${c.className || ''} ${c.label ? '' : 'no-label'}`}>{c.render ? c.render(r) : r[c.key] ?? '—'}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)}>{t.label}</button>
      ))}
    </div>
  );
}

export function PageHeader({ title, subtitle, children }) {
  return (
    <div className="page-header">
      <div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
      {children && <div className="row">{children}</div>}
    </div>
  );
}

// Live countdown to an acknowledgement deadline. serverNow corrects for clock differences.
export function Countdown({ deadline, serverNow, total }) {
  const offset = useRef(serverNow ? new Date(serverNow).getTime() - Date.now() : 0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  if (!deadline) return null;
  const left = Math.round((new Date(deadline).getTime() - (now + offset.current)) / 1000);
  const overdue = left <= 0;
  const pct = total ? Math.max(0, Math.min(100, (left / total) * 100)) : null;
  const urgent = total ? left < total * 0.3 : left < 30;
  return (
    <span className="stack" style={{ gap: 4 }}>
      <span className="countdown" style={{ color: overdue ? 'var(--danger)' : urgent ? 'var(--warn)' : 'inherit' }} aria-live="off">
        {overdue ? `Overdue by ${duration(-left)}` : `${duration(left)} left to acknowledge`}
      </span>
      {pct !== null && <span className={`progress ${urgent ? 'danger' : ''}`} aria-hidden><span style={{ width: `${pct}%` }} /></span>}
    </span>
  );
}

export const ICON = {
  note: '📝', call: '📞', stage_change: '➡️', assignment: '👤', escalation: '⏫', acknowledged: '✅',
  field_edit: '✏️', message: '💬', payment: '💳', appointment: '📅', lead_created: '✨',
  contact_created: '👤', opportunity_created: '🎯', opt_out: '🚫', opt_in: '✔️', lead_closed: '🔒',
};
