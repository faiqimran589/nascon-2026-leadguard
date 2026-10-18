// Server-Sent Events hub (Q11): pushes small "something changed" signals to browsers.
// Payloads carry only ids/types; the browser re-fetches through permission-checked APIs,
// so no data can leak to a user who is not allowed to see it.
import { onCommit } from '../db/pool.js';

const clients = new Map(); // workspaceId -> Set<{ userId, res }>

export function addClient(workspaceId, userId, res) {
  if (!clients.has(workspaceId)) clients.set(workspaceId, new Set());
  const c = { userId, res };
  clients.get(workspaceId).add(c);
  return () => clients.get(workspaceId)?.delete(c);
}

// topic examples: 'leads', 'messages', 'payments', 'appointments', 'crm', 'team', 'notification'
export function publish(workspaceId, topic, payload = {}, { userIds } = {}) {
  const set = clients.get(workspaceId);
  if (!set) return;
  const data = `event: change\ndata: ${JSON.stringify({ topic, ...payload })}\n\n`;
  for (const c of set) {
    if (userIds && !userIds.includes(c.userId)) continue;
    try { c.res.write(data); } catch { /* client gone */ }
  }
}

// Disconnect every stream of a user (e.g. after logout-all or deactivation).
export function kickUser(workspaceId, userId) {
  for (const c of clients.get(workspaceId) || []) {
    if (c.userId === userId) { try { c.res.end(); } catch { /* ignore */ } }
  }
}

setInterval(() => {
  for (const set of clients.values()) for (const c of set) { try { c.res.write(': ping\n\n'); } catch { /* ignore */ } }
}, 25_000).unref();

// Publish after the surrounding transaction commits (so browsers never re-fetch stale data).
export const emit = (db, ws, topic, payload, opts) => onCommit(db, () => publish(ws, topic, payload, opts));
