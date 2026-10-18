// Lightweight SVG charts (no library). Follows the house chart rules:
// thin 2px lines, ~10% area wash, hairline solid gridlines, >=8px end-dots with a 2px surface ring,
// crosshair + tooltip listing every series, keyboard support (arrow keys), legend for 2+ series,
// selective direct labels, text in ink colours (never the series colour), and a table view.
import { useEffect, useMemo, useRef, useState } from 'react';

// Validated categorical palette for charts (green, gold) on the white card surface.
export const SERIES = { green: '#1f7a55', gold: '#b8862b' };
const INK = { primary: '#14171a', secondary: '#4f4a40', muted: '#857d6f', grid: '#ece8df', base: '#d6cfbf', surface: '#ffffff' };

function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceMax(v) {
  if (!(v > 0)) return 4;
  const exp = 10 ** Math.floor(Math.log10(v));
  const f = v / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

export function compact(n) {
  if (n === null || n === undefined) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '')}K`;
  return String(Math.round(n * 10) / 10);
}

const dayLabel = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
};

function TableView({ labels, series, fmt }) {
  return (
    <div className="table-wrap" style={{ marginTop: 8 }}>
      <table className="table">
        <thead><tr><th scope="col">Day</th>{series.map((s) => <th key={s.key} scope="col" className="right">{s.label}</th>)}</tr></thead>
        <tbody>{labels.map((l, i) => <tr key={l}><td>{dayLabel(l)}</td>{series.map((s) => <td key={s.key} className="right" style={{ fontVariantNumeric: 'tabular-nums' }}>{s.values[i] === null ? '—' : fmt(s.values[i])}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

// Line / area chart over days. series: [{ key, label, color, values: number|null[] , area?: boolean }]
export function TrendChart({ title, subtitle, labels, series, fmt = compact, tickFmt = compact, height = 210, empty = 'No data in this period yet.' }) {
  const [ref, width] = useWidth();
  const [idx, setIdx] = useState(null);
  const [table, setTable] = useState(false);
  const pad = { l: 44, r: 18, t: 14, b: 26 };
  const w = width; const h = height;
  const iw = w - pad.l - pad.r; const ih = h - pad.t - pad.b;
  const all = series.flatMap((s) => s.values.filter((v) => v !== null));
  const hasData = all.some((v) => v > 0);
  const integers = all.every((v) => Number.isInteger(v));
  let yMax = niceMax(Math.max(0, ...all));
  if (integers && yMax < 40) yMax = Math.max(4, Math.ceil(Math.max(1, ...all) / 4) * 4); // whole-number ticks for counts
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const x = (i) => pad.l + (labels.length <= 1 ? iw / 2 : (i / (labels.length - 1)) * iw);
  const y = (v) => pad.t + ih - (v / yMax) * ih;
  const every = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor(iw / 72))));

  const paths = useMemo(() => series.map((s) => {
    let d = ''; let area = ''; let segStart = null; let prev = null;
    s.values.forEach((v, i) => {
      if (v === null) { if (segStart !== null && s.area) area += `L${x(prev)},${y(0)}Z`; segStart = null; return; }
      if (segStart === null) { d += `M${x(i)},${y(v)}`; if (s.area) area += `M${x(i)},${y(0)}L${x(i)},${y(v)}`; segStart = i; } else { d += `L${x(i)},${y(v)}`; if (s.area) area += `L${x(i)},${y(v)}`; }
      prev = i;
    });
    if (segStart !== null && s.area) area += `L${x(prev)},${y(0)}Z`;
    let last = null;
    for (let i = s.values.length - 1; i >= 0; i--) if (s.values[i] !== null) { last = i; break; }
    return { ...s, d, area, last };
  }), [series, w, h, yMax]); // eslint-disable-line react-hooks/exhaustive-deps

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * w;
    const i = Math.round(((px - pad.l) / iw) * (labels.length - 1));
    setIdx(Math.max(0, Math.min(labels.length - 1, i)));
  };
  const onKey = (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); setIdx((i) => Math.min(labels.length - 1, (i ?? labels.length - 1) + 1)); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); setIdx((i) => Math.max(0, (i ?? labels.length - 1) - 1)); }
    if (e.key === 'Escape') setIdx(null);
  };
  const tipLeft = idx === null ? 0 : Math.min(Math.max(x(idx) - 70, 4), w - 144);

  return (
    <section className="card chart-card" aria-label={title}>
      <div className="card-header" style={{ marginBottom: 4 }}>
        <div><h2 style={{ marginBottom: 2 }}>{title}</h2>{subtitle && <div className="small muted">{subtitle}</div>}</div>
        <button className="btn ghost sm" aria-pressed={table} onClick={() => setTable(!table)}>{table ? 'Chart' : 'Table'}</button>
      </div>
      {series.length > 1 && (
        <div className="legend" aria-hidden>
          {series.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}
        </div>
      )}
      {table ? <TableView labels={labels} series={series} fmt={fmt} /> : (
        <div ref={ref} className="chart-box" style={{ position: 'relative' }}>
          {!hasData && <div className="chart-empty"><span style={{ padding: '2px 10px', borderRadius: 999 }}>{empty}</span></div>}
          <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" tabIndex={0}
            aria-label={`${title}. ${series.map((s) => `${s.label}: latest ${s.values[s.values.length - 1] ?? 'no data'}`).join('; ')}. Use arrow keys to read each day.`}
            onPointerMove={onMove} onPointerLeave={() => setIdx(null)} onKeyDown={onKey} onFocus={() => setIdx(labels.length - 1)} onBlur={() => setIdx(null)}
            style={{ display: 'block', touchAction: 'pan-y', outline: 'none' }}>
            {ticks.map((t, i) => (
              <g key={i}>
                <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} stroke={i === 0 ? INK.base : INK.grid} strokeWidth="1" />
                <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill={INK.muted} style={{ fontVariantNumeric: 'tabular-nums' }}>{tickFmt(t)}</text>
              </g>
            ))}
            {labels.map((l, i) => ((i % every === 0 && (labels.length - 1 - i) * (iw / Math.max(1, labels.length - 1)) > 56) || i === labels.length - 1) && (
              <text key={l} x={x(i)} y={h - 6} textAnchor={i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'} fontSize="11" fill={INK.muted}>{dayLabel(l)}</text>
            ))}
            {paths.map((p) => p.area && <path key={`a-${p.key}`} d={p.area} fill={p.color} opacity="0.1" />)}
            {paths.map((p) => <path key={`l-${p.key}`} d={p.d} fill="none" stroke={p.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />)}
            {idx === null && hasData && paths.map((p) => p.last !== null && (
              <circle key={`e-${p.key}`} cx={x(p.last)} cy={y(p.values[p.last])} r="4" fill={p.color} stroke={INK.surface} strokeWidth="2" />
            ))}
            {idx === null && series.length === 1 && paths[0].last !== null && hasData && (
              <text x={Math.min(x(paths[0].last), w - pad.r) - 6} y={Math.max(pad.t + 10, y(paths[0].values[paths[0].last]) - 12)} textAnchor="end" fontSize="12" fontWeight="600" fill={INK.primary} stroke={INK.surface} strokeWidth="4" paintOrder="stroke" strokeLinejoin="round">{fmt(paths[0].values[paths[0].last])}</text>
            )}
            {idx !== null && (
              <g>
                <line x1={x(idx)} x2={x(idx)} y1={pad.t} y2={pad.t + ih} stroke={INK.base} strokeWidth="1" />
                {paths.map((p) => p.values[idx] !== null && <circle key={`h-${p.key}`} cx={x(idx)} cy={y(p.values[idx])} r="4.5" fill={p.color} stroke={INK.surface} strokeWidth="2" />)}
              </g>
            )}
          </svg>
          {idx !== null && (
            <div className="chart-tip" style={{ left: tipLeft }} role="status">
              <div className="tiny muted">{dayLabel(labels[idx])}</div>
              {series.map((s) => (
                <div key={s.key} className="tip-row"><i style={{ background: s.color }} /><strong>{s.values[idx] === null ? '—' : fmt(s.values[idx])}</strong><span className="muted">{s.label}</span></div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// Horizontal bars for a small set of categories (single colour, value at the tip).
export function BarList({ title, subtitle, items, color = SERIES.green, fmt = compact, empty = 'No data yet.' }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const total = items.reduce((a, i) => a + i.value, 0);
  const [hover, setHover] = useState(null);
  return (
    <section className="card chart-card" aria-label={title}>
      <div className="card-header" style={{ marginBottom: 8 }}><div><h2 style={{ marginBottom: 2 }}>{title}</h2>{subtitle && <div className="small muted">{subtitle}</div>}</div></div>
      {!items.length ? <p className="muted">{empty}</p> : (
        <ul className="barlist">
          {items.map((it) => (
            <li key={it.label} tabIndex={0} onMouseEnter={() => setHover(it.label)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(it.label)} onBlur={() => setHover(null)}
              aria-label={`${it.label}: ${fmt(it.value)} (${Math.round((it.value / (total || 1)) * 100)}%)`}>
              <span className="bl-label">{it.label}</span>
              <span className="bl-track" aria-hidden>
                <span className="bl-fill" style={{ width: `${Math.max(1.5, (it.value / max) * 100)}%`, background: color, opacity: hover && hover !== it.label ? 0.55 : 1 }} />
              </span>
              <span className="bl-value">{fmt(it.value)}{hover === it.label && <span className="muted"> · {Math.round((it.value / (total || 1)) * 100)}%</span>}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
