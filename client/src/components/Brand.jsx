// Brand emblem (original design): a thin gold dial ring with minute ticks around an "LG" monogram.
export function Emblem({ size = 34, ring = '#c9a24a', ink = '#c9a24a' }) {
  const ticks = Array.from({ length: 12 }, (_, i) => i);
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden focusable="false">
      <circle cx="20" cy="20" r="18.5" fill="none" stroke={ring} strokeWidth="1.2" />
      {ticks.map((i) => {
        const a = (i / 12) * Math.PI * 2;
        const r1 = i % 3 === 0 ? 14.2 : 15.4;
        return <line key={i} x1={20 + Math.sin(a) * r1} y1={20 - Math.cos(a) * r1} x2={20 + Math.sin(a) * 16.6} y2={20 - Math.cos(a) * 16.6} stroke={ring} strokeWidth={i % 3 === 0 ? 1.4 : 0.8} strokeLinecap="round" />;
      })}
      <text x="20" y="24.2" textAnchor="middle" fontSize="11.5" fontFamily='"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif' fill={ink} letterSpacing="0.5">LG</text>
    </svg>
  );
}

export function Wordmark({ light = false }) {
  return (
    <span className={`wordmark ${light ? 'light' : ''}`}>
      <Emblem size={34} />
      <span>LEADGUARD</span>
    </span>
  );
}

// Decorative watch-dial ornament for the login hero (no data, purely visual).
export function Dial() {
  const ticks = Array.from({ length: 60 }, (_, i) => i);
  return (
    <svg className="lux-dial" viewBox="0 0 400 400" aria-hidden focusable="false">
      <defs>
        <linearGradient id="lgGold" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#e9d39a" /><stop offset="0.55" stopColor="#c9a24a" /><stop offset="1" stopColor="#8f6b22" />
        </linearGradient>
      </defs>
      <circle cx="200" cy="200" r="190" fill="none" stroke="url(#lgGold)" strokeWidth="1" opacity="0.55" />
      <circle cx="200" cy="200" r="150" fill="none" stroke="url(#lgGold)" strokeWidth="0.6" opacity="0.35" />
      {ticks.map((i) => {
        const a = (i / 60) * Math.PI * 2;
        const major = i % 5 === 0;
        const r1 = major ? 166 : 174;
        return <line key={i} x1={200 + Math.sin(a) * r1} y1={200 - Math.cos(a) * r1} x2={200 + Math.sin(a) * 182} y2={200 - Math.cos(a) * 182}
          stroke="url(#lgGold)" strokeWidth={major ? 2.2 : 0.9} strokeLinecap="round" opacity={major ? 0.9 : 0.5} />;
      })}
      <line x1="200" y1="200" x2="200" y2="78" stroke="url(#lgGold)" strokeWidth="2.4" strokeLinecap="round" opacity="0.85" />
      <line x1="200" y1="200" x2="292" y2="236" stroke="url(#lgGold)" strokeWidth="1.4" strokeLinecap="round" opacity="0.7" />
      <circle cx="200" cy="200" r="5" fill="url(#lgGold)" />
    </svg>
  );
}
