// Permission catalogue. Permissions are attached to roles; roles are attached to users.
// Base levels: owner (always everything), admin, user. "Manager" is just a role made of permissions.

export const PERMISSIONS = [
  { key: 'crm.view', label: 'View CRM records assigned to them', group: 'CRM records' },
  { key: 'crm.view_all', label: 'View all CRM records in the workspace', group: 'CRM records' },
  { key: 'crm.create', label: 'Create records', group: 'CRM records' },
  { key: 'crm.edit', label: 'Edit records (notes, stages, messages, payments, appointments)', group: 'CRM records' },
  { key: 'crm.delete', label: 'Delete records', group: 'CRM records' },
  { key: 'crm.export', label: 'Export records to CSV', group: 'CRM records' },
  { key: 'values.view', label: 'See opportunity values (otherwise masked)', group: 'CRM records' },
  { key: 'leads.reassign', label: 'Reassign leads and set other employees’ availability', group: 'Leads' },
  { key: 'rules.manage', label: 'Manage assignment & escalation rules', group: 'Configuration' },
  { key: 'pipeline.manage', label: 'Manage pipelines, stages and custom fields', group: 'Configuration' },
  { key: 'integrations.manage', label: 'Manage integrations and view sync history', group: 'Configuration' },
  { key: 'users.manage', label: 'Invite users and manage roles', group: 'Administration' },
  { key: 'audit.view', label: 'View the audit log', group: 'Administration' },
  { key: 'dashboard.company', label: 'See company-wide dashboard figures', group: 'Administration' },
];

export const ALL_PERMISSIONS = PERMISSIONS.map((p) => p.key);

export const DEFAULT_ROLES = {
  Admin: ALL_PERMISSIONS,
  Manager: ['crm.view', 'crm.view_all', 'crm.create', 'crm.edit', 'crm.delete', 'crm.export', 'values.view',
    'leads.reassign', 'audit.view', 'dashboard.company'],
  Sales: ['crm.view', 'crm.create', 'crm.edit', 'values.view'],
};

export function can(user, perm) {
  if (!user) return false;
  if (user.level === 'owner') return true;
  return user.permissions.includes(perm);
}

export function effectivePermissions(user) {
  return user.level === 'owner' ? ALL_PERMISSIONS : user.permissions;
}
