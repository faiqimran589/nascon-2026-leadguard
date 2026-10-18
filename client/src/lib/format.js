// Formatting helpers. All times are shown in the user's own time zone (I3.5).
let TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
export const setTimeZone = (tz) => { if (tz) TZ = tz; };
export const userTimeZone = () => TZ;
export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function fmtDateTime(iso, opts = {}) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone: opts.tz || TZ, day: 'numeric', month: 'short', year: opts.year ? 'numeric' : undefined, hour: '2-digit', minute: '2-digit', ...opts.fmt }).format(new Date(iso));
}
export function fmtDate(iso) {
  if (!iso) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) { const [y, m, d] = iso.split('-'); return new Date(Date.UTC(+y, +m - 1, +d)).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }); }
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
}
export function fmtTime(iso, tz) { return new Intl.DateTimeFormat('en-GB', { timeZone: tz || TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); }
export function ago(iso) {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export function duration(sec) {
  if (sec === null || sec === undefined) return '—';
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60 ? `${sec % 60}s` : ''}`.trim();
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}
const ZERO = new Set(['jpy', 'krw', 'vnd', 'clp', 'pyg', 'ugx', 'xaf', 'xof']);
export function money(amount, currency = 'usd') {
  if (amount === null || amount === undefined) return '—';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: 2 }).format(amount); } catch { return `${amount} ${currency.toUpperCase()}`; }
}
// Compact money for headline figures: PKR 25.7M, $12.9K (full value stays in lists and tooltips).
export function moneyCompact(amount, currency = 'usd') {
  if (amount === null || amount === undefined) return '\u2014';
  if (Math.abs(amount) < 10000) return money(amount, currency);
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), notation: 'compact', maximumFractionDigits: 1 }).format(amount); } catch { return money(amount, currency); }
}
export const cents = (c, currency) => money(Number(c) / (ZERO.has(currency) ? 1 : 100), currency);
export const fullName = (o) => [o?.first_name, o?.last_name].filter(Boolean).join(' ') || '—';

// Local "YYYY-MM-DDTHH:mm" for a Date in a time zone (for datetime-local inputs).
export function toLocalInput(date, tz = TZ) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(date)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export const SOURCE = { web_form: 'Web form', whatsapp: 'WhatsApp', sms: 'SMS', manual: 'Manual' };
export const AVAIL = { available: 'Available', busy: 'Busy', on_leave: 'On leave', offline: 'Offline' };
export const AVAIL_TONE = { available: 'ok', busy: 'warn', on_leave: 'violet', offline: 'muted' };
export const LEAD_STATUS = { assigned: ['Awaiting acknowledgement', 'warn'], acknowledged: ['Acknowledged', 'ok'], converted: ['Converted', 'primary'], closed: ['Closed', 'muted'] };
export const PAY_STATUS = { pending: ['Awaiting payment', 'warn'], paid: ['Paid', 'ok'], failed: ['Failed', 'danger'], expired: ['Expired / abandoned', 'muted'], refunded: ['Refunded', 'violet'], partially_refunded: ['Partially refunded', 'violet'] };
export const MSG_STATUS = { received: ['Received', 'muted'], queued: ['Queued', 'muted'], sending: ['Sending', 'muted'], accepted: ['Accepted', 'muted'], sent: ['Sent', 'info'], delivered: ['Delivered', 'ok'], read: ['Read', 'ok'], failed: ['Failed', 'danger'], undelivered: ['Undelivered', 'danger'], canceled: ['Canceled', 'danger'] };
export const TIMEZONES = (() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return ['UTC', 'Asia/Karachi', 'Europe/London', 'America/New_York']; } })();
