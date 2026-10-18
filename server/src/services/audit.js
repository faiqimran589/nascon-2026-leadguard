// Audit log writer (F4). The table is append-only (enforced by a DB trigger).
export async function audit(db, { workspaceId, actor, action, targetType, targetId, targetLabel, before, after }) {
  await db.query(
    `INSERT INTO audit_log (workspace_id, actor_user_id, actor_label, action, target_type, target_id, target_label, before, after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [workspaceId, actor?.id || null, actor ? `${actor.name} <${actor.email}>` : 'System', action,
      targetType || null, targetId ? String(targetId) : null, targetLabel || null,
      before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after)],
  );
}

// Returns {before, after} containing only keys whose values changed.
export function diff(before, after, keys) {
  const b = {}; const a = {};
  for (const k of keys) {
    if (JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after?.[k] ?? null)) {
      b[k] = before?.[k] ?? null; a[k] = after?.[k] ?? null;
    }
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}
