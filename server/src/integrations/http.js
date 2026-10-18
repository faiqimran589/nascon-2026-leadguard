// Outbound HTTP to providers with timeout and retry-with-delay for temporary failures (I5.5).
// Permanent failures (4xx other than 429) are returned immediately so the caller can explain them.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function providerFetch(url, options = {}, { retries = 2, timeoutMs = 10_000 } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      last = { ok: res.ok, status: res.status, json, text, transient: res.status === 429 || res.status >= 500 };
      if (!last.transient) return last;
    } catch (err) {
      last = { ok: false, status: 0, json: null, text: '', transient: true, networkError: err.name === 'TimeoutError' ? 'Provider did not respond in time' : `Cannot reach provider (${err.cause?.code || err.message})` };
    }
    if (attempt < retries) await sleep(500 * 3 ** attempt); // 0.5s, 1.5s
  }
  return last;
}

export function formBody(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) formBody(v, key, out);
    else if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? formBody(item, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, item)));
    else out.append(key, String(v));
  }
  return out;
}
