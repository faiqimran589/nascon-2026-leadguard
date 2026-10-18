// Creates a new workspace with sensible defaults (used by sign-up and the demo seed).
import { randomToken } from '../lib/crypto.js';
import { DEFAULT_ROLES } from './permissions.js';
import { audit } from './audit.js';

export async function createWorkspace(db, { workspaceName, ownerName, email, passwordHash, timezone }) {
  const { rows: [ws] } = await db.query(
    'INSERT INTO workspaces (name, timezone, webhook_token) VALUES ($1,$2,$3) RETURNING *',
    [workspaceName, timezone || 'Asia/Karachi', randomToken(18)]);
  const roles = {};
  for (const [name, perms] of Object.entries(DEFAULT_ROLES)) {
    const { rows: [r] } = await db.query(
      'INSERT INTO roles (workspace_id, name, permissions, is_system) VALUES ($1,$2,$3,$4) RETURNING *',
      [ws.id, name, perms, name === 'Admin']);
    roles[name] = r;
  }
  const { rows: [owner] } = await db.query(
    `INSERT INTO users (workspace_id, email, name, password_hash, level, role_id, timezone)
     VALUES ($1, lower($2), $3, $4, 'owner', $5, $6) RETURNING *`,
    [ws.id, email, ownerName, passwordHash, roles.Admin.id, timezone || null]);
  await db.query('INSERT INTO assignment_rules (workspace_id, manager_user_id) VALUES ($1,$2)', [ws.id, owner.id]);

  const { rows: [pipe] } = await db.query(
    "INSERT INTO pipelines (workspace_id, name, position) VALUES ($1,'Sales',0) RETURNING *", [ws.id]);
  const stages = [
    ['New', 'open', []], ['Qualified', 'open', []], ['Proposal sent', 'open', ['value']],
    ['Negotiation', 'open', ['value']], ['Won', 'won', ['value', 'close_date']], ['Lost', 'lost', []],
  ];
  for (const [i, [name, kind, req]] of stages.entries()) {
    await db.query('INSERT INTO stages (workspace_id, pipeline_id, name, position, kind, required_fields) VALUES ($1,$2,$3,$4,$5,$6)',
      [ws.id, pipe.id, name, i, kind, req]);
  }
  await audit(db, { workspaceId: ws.id, actor: owner, action: 'workspace.created', targetType: 'workspace', targetId: ws.id, targetLabel: ws.name });
  return { workspace: ws, owner, roles, pipeline: pipe };
}
