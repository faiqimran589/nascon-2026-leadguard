// App-wide state: current user, permissions, live updates (SSE), toasts.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { get } from './api.js';
import { setTimeZone } from './format.js';

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

export function AppProvider({ children }) {
  const [me, setMe] = useState(undefined); // undefined = loading, null = logged out
  const [toasts, setToasts] = useState([]);
  const [online, setOnline] = useState(true);

  const toast = useCallback((text, type = 'info', link) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-3), { id, text, type, link }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), type === 'error' ? 8000 : 5000);
  }, []);

  const refreshMe = useCallback(async () => {
    try {
      const d = await get('/auth/me');
      setTimeZone(d.user?.effectiveTimezone);
      setMe(d.user ? d : null);
    } catch { setMe(null); }
  }, []);

  useEffect(() => { refreshMe(); }, [refreshMe]);
  useEffect(() => {
    const h = () => setMe(null);
    window.addEventListener('lg:unauthorized', h);
    return () => window.removeEventListener('lg:unauthorized', h);
  }, []);

  // One EventSource per tab; components subscribe through useLive().
  useEffect(() => {
    if (!me?.user) return undefined;
    const es = new EventSource('/api/events');
    es.addEventListener('change', (e) => {
      let d; try { d = JSON.parse(e.data); } catch { return; }
      window.dispatchEvent(new CustomEvent('lg:change', { detail: d }));
      if (d.topic === 'notification') toast(d.title + (d.body ? ` — ${d.body}` : ''), 'info', d.link);
      if (d.topic === 'team') refreshMe();
    });
    es.onopen = () => setOnline(true);
    es.onerror = () => setOnline(false);
    return () => es.close();
  }, [me?.user?.id, toast, refreshMe]); // eslint-disable-line react-hooks/exhaustive-deps

  const can = useCallback((p) => !!me?.user?.permissions?.includes(p), [me]);
  const value = useMemo(() => ({ me, setMe, refreshMe, can, toast, toasts, setToasts, online }), [me, refreshMe, can, toast, toasts, online]);
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

// Re-run cb when the server signals a change on one of the topics (Q11: no manual refresh).
export function useLive(topics, cb) {
  const ref = useRef(cb);
  ref.current = cb;
  const key = topics.join(',');
  useEffect(() => {
    let t = null;
    const h = (e) => {
      if (!key.split(',').includes(e.detail.topic)) return;
      clearTimeout(t);
      t = setTimeout(() => ref.current(e.detail), 150); // coalesce bursts
    };
    window.addEventListener('lg:change', h);
    return () => { window.removeEventListener('lg:change', h); clearTimeout(t); };
  }, [key]);
}

// Data loader with loading/error state that keeps showing old data while refreshing.
export function useApi(path, { live = [], skip = false } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: !skip });
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path || skip) return;
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await get(path);
      if (n === seq.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (n === seq.current) setState((s) => ({ data: s.data, error, loading: false }));
    }
  }, [path, skip]);
  useEffect(() => { load(); }, [load]);
  useLive(live, load);
  return { ...state, reload: load, setData: (fn) => setState((s) => ({ ...s, data: typeof fn === 'function' ? fn(s.data) : fn })) };
}

// Runs an action with busy state + success/error toasts.
export function useAction() {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, { success, onError } = {}) => {
    setBusy(true);
    try {
      const out = await fn();
      if (success) toast(typeof success === 'function' ? success(out) : success, 'success');
      return out;
    } catch (e) {
      if (onError && onError(e) === true) return undefined;
      toast(e.message, 'error');
      return undefined;
    } finally { setBusy(false); }
  }, [toast]);
  return [run, busy];
}
