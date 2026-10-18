// Time-zone helpers built on Intl (no extra library). Everything is stored in UTC (timestamptz).

export function isValidTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function parts(date, tz) {
  const out = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date)) out[p.type] = p.value;
  return out;
}

// Offset (ms) of tz from UTC at the given instant.
function offsetMs(date, tz) {
  const m = parts(date, tz);
  return Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour % 24, +m.minute, +m.second) - Math.floor(date.getTime() / 1000) * 1000;
}

// "2026-10-18T14:30" interpreted as wall-clock time in tz -> Date (UTC instant).
export function zonedToUtc(local, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) throw new Error('Invalid local date-time');
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const off1 = offsetMs(new Date(guess), tz);
  let utc = guess - off1;
  const off2 = offsetMs(new Date(utc), tz);
  if (off2 !== off1) utc = guess - off2;
  return new Date(utc);
}

export function startOfDay(tz, date = new Date()) {
  const m = parts(date, tz);
  return zonedToUtc(`${m.year}-${m.month}-${m.day}T00:00`, tz);
}

export function startOfMonth(tz, date = new Date()) {
  const m = parts(date, tz);
  return zonedToUtc(`${m.year}-${m.month}-01T00:00`, tz);
}
