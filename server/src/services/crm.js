// Shared CRM rules: custom field validation, stage-required fields, visibility scopes,
// value masking (F1.4) and the safe, parameterised filter builder used by lists & saved lists (F2.6).
import { HttpError } from '../lib/http.js';
import { can } from './permissions.js';

export const BUILTIN_REQUIRABLE = { value: 'Value', close_date: 'Expected close date' };

export async function loadFields(db, workspaceId, entity, pipelineId) {
  const { rows } = await db.query(
    `SELECT * FROM custom_fields WHERE workspace_id = $1 AND entity = $2
       AND ($3::uuid IS NULL OR pipeline_id IS NULL OR pipeline_id = $3) ORDER BY position, created_at`,
    [workspaceId, entity, pipelineId || null]);
  return rows;
}

// Validates and normalises a custom-values object against the field definitions.
export function validateCustom(input, fields, { partialBase = {} } = {}) {
  if (!input) return partialBase;
  if (typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Custom fields must be an object');
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  const out = { ...partialBase };
  for (const [k, raw] of Object.entries(input)) {
    const f = byKey[k];
    if (!f) throw new HttpError(400, `Unknown custom field "${k}" for this record`);
    if (raw === null || raw === '' || raw === undefined) { delete out[k]; continue; }
    let v = raw;
    switch (f.type) {
      case 'number':
        v = Number(raw);
        if (!Number.isFinite(v)) throw new HttpError(400, `${f.label} must be a number`);
        break;
      case 'date':
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw)) || Number.isNaN(Date.parse(raw))) throw new HttpError(400, `${f.label} must be a date (YYYY-MM-DD)`);
        break;
      case 'checkbox':
        if (typeof raw !== 'boolean') throw new HttpError(400, `${f.label} must be true or false`);
        break;
      case 'dropdown':
        if (!f.options.includes(String(raw))) throw new HttpError(400, `${f.label} must be one of: ${f.options.join(', ')}`);
        v = String(raw);
        break;
      default:
        v = String(raw).slice(0, 2000);
    }
    out[k] = v;
  }
  return out;
}

export function missingRequired(stage, opp, fields) {
  const missing = [];
  for (const key of stage.required_fields || []) {
    if (BUILTIN_REQUIRABLE[key]) {
      const v = opp[key];
      if (v === null || v === undefined || v === '') missing.push({ key, label: BUILTIN_REQUIRABLE[key] });
    } else {
      const f = fields.find((x) => x.key === key);
      if (!f) continue;
      const v = opp.custom?.[key];
      if (v === null || v === undefined || v === '' || (f.type === 'checkbox' && v !== true)) missing.push({ key, label: f.label });
    }
  }
  return missing;
}

// Record visibility (F1.2/I1.6): own records unless crm.view_all.
export function contactScope(user, params, alias = 'c') {
  if (!can(user, 'crm.view')) throw new HttpError(403, 'You do not have permission to view CRM records.');
  if (can(user, 'crm.view_all')) return 'TRUE';
  params.push(user.id);
  return `${alias}.owner_id = $${params.length}`;
}

export function oppScope(user, params, alias = 'o', contactAlias = 'c') {
  if (!can(user, 'crm.view')) throw new HttpError(403, 'You do not have permission to view CRM records.');
  if (can(user, 'crm.view_all')) return 'TRUE';
  params.push(user.id);
  return `(${alias}.owner_id = $${params.length} OR ${contactAlias}.owner_id = $${params.length})`;
}

export function maskOpp(user, o) {
  if (!o || can(user, 'values.view')) return o;
  return { ...o, value: null, value_masked: true };
}

export function maskActivity(user, a) {
  if (a.data?.sensitive === 'value' && !can(user, 'values.view')) return { ...a, body: 'Value changed (hidden — you do not have permission to see values)', data: {} };
  return a;
}

// ---------- Filter builder ----------
const BASE_FIELDS = {
  contacts: {
    owner_id: { col: 'c.owner_id', type: 'uuid', label: 'Owner' },
    company_id: { col: 'c.company_id', type: 'uuid', label: 'Company' },
    tag: { col: 'c.tags', type: 'tags', label: 'Tag' },
    source: { col: 'c.source', type: 'text', label: 'Source' },
    email: { col: 'c.email', type: 'text', label: 'Email' },
    created_at: { col: 'c.created_at', type: 'date', label: 'Created' },
    opted_out: { col: 'c.opted_out', type: 'bool', label: 'Opted out' },
  },
  opportunities: {
    pipeline_id: { col: 'o.pipeline_id', type: 'uuid', label: 'Pipeline' },
    stage_id: { col: 'o.stage_id', type: 'uuid', label: 'Stage' },
    owner_id: { col: 'o.owner_id', type: 'uuid', label: 'Owner' },
    contact_id: { col: 'o.contact_id', type: 'uuid', label: 'Contact' },
    tag: { col: 'o.tags', type: 'tags', label: 'Tag' },
    value: { col: 'o.value', type: 'number', label: 'Value', sensitive: true },
    close_date: { col: 'o.close_date', type: 'date', label: 'Close date' },
    created_at: { col: 'o.created_at', type: 'date', label: 'Created' },
    stage_kind: { col: 's.kind', type: 'text', label: 'Stage type' },
  },
};

const OPS = {
  uuid: ['eq', 'neq', 'is_empty', 'not_empty'],
  text: ['eq', 'neq', 'contains', 'is_empty', 'not_empty'],
  number: ['eq', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'not_empty'],
  date: ['on', 'before', 'after', 'last_days', 'is_empty', 'not_empty'],
  bool: ['is_true', 'is_false'],
  tags: ['has_tag', 'not_tag'],
};

export function filterFieldCatalog(entity, customFields) {
  const base = Object.entries(BASE_FIELDS[entity]).map(([key, f]) => ({ key, label: f.label, type: f.type, ops: OPS[f.type] }));
  const custom = customFields.map((f) => {
    const t = { number: 'number', date: 'date', checkbox: 'bool' }[f.type] || 'text';
    return { key: `custom.${f.key}`, label: f.label, type: t, ops: OPS[t], options: f.options };
  });
  return [...base, ...custom];
}

export function buildFilters(entity, filters, params, { user, customFields, alias }) {
  if (!Array.isArray(filters)) return [];
  if (filters.length > 15) throw new HttpError(400, 'Too many filter criteria (max 15)');
  const clauses = [];
  for (const f of filters) {
    if (!f || typeof f.field !== 'string' || typeof f.op !== 'string') throw new HttpError(400, 'Invalid filter');
    let def;
    if (f.field.startsWith('custom.')) {
      const key = f.field.slice(7);
      const cf = customFields.find((x) => x.key === key);
      if (!cf) throw new HttpError(400, `Unknown field "${key}" in filter`);
      const raw = `(${alias}.custom->>'${key.replace(/[^a-z0-9_]/g, '')}')`;
      if (cf.type === 'number') def = { col: `(CASE WHEN ${raw} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN ${raw}::numeric END)`, type: 'number' };
      else if (cf.type === 'date') def = { col: `(CASE WHEN ${raw} ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN ${raw}::date END)`, type: 'date' };
      else if (cf.type === 'checkbox') def = { col: `COALESCE(${raw}::boolean, false)`, type: 'bool' };
      else def = { col: raw, type: 'text' };
    } else {
      def = BASE_FIELDS[entity][f.field];
      if (!def) throw new HttpError(400, `Unknown filter field "${f.field}"`);
      if (def.sensitive && !can(user, 'values.view')) throw new HttpError(403, 'You do not have permission to filter by opportunity value.');
    }
    if (!OPS[def.type].includes(f.op)) throw new HttpError(400, `Operator "${f.op}" is not valid for ${f.field}`);
    let v = f.value;
    if (def.type === 'uuid' && v === 'me') v = user.id;
    const p = (val) => { params.push(val); return `$${params.length}`; };
    const textCol = def.type === 'uuid' ? `${def.col}::text` : def.col;
    switch (f.op) {
      case 'eq': clauses.push(def.type === 'text' ? `lower(${def.col}) = lower(${p(String(v))})` : `${textCol} = ${p(String(v))}`); break;
      case 'neq': clauses.push(`(${textCol} IS DISTINCT FROM ${p(String(v))})`); break;
      case 'contains': clauses.push(`${def.col} ILIKE ${p(`%${String(v).replace(/[%_\\]/g, '\\$&')}%`)}`); break;
      case 'gt': case 'gte': case 'lt': case 'lte': {
        const n = Number(v); if (!Number.isFinite(n)) throw new HttpError(400, `Filter value for ${f.field} must be a number`);
        clauses.push(`${def.col} ${{ gt: '>', gte: '>=', lt: '<', lte: '<=' }[f.op]} ${p(n)}`); break;
      }
      case 'on': case 'before': case 'after': {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new HttpError(400, `Filter value for ${f.field} must be a date`);
        clauses.push(`${def.col}::date ${{ on: '=', before: '<', after: '>' }[f.op]} ${p(v)}::date`); break;
      }
      case 'last_days': {
        const n = parseInt(v, 10); if (!(n > 0 && n < 3660)) throw new HttpError(400, 'Days must be a positive number');
        clauses.push(`${def.col} >= now() - make_interval(days => ${p(n)})`); break;
      }
      case 'is_empty': clauses.push(`(${def.col} IS NULL${def.type === 'text' ? ` OR ${def.col} = ''` : ''})`); break;
      case 'not_empty': clauses.push(`(${def.col} IS NOT NULL${def.type === 'text' ? ` AND ${def.col} <> ''` : ''})`); break;
      case 'is_true': clauses.push(`${def.col} = true`); break;
      case 'is_false': clauses.push(`${def.col} = false`); break;
      case 'has_tag': clauses.push(`${p(String(v).trim().toLowerCase())} = ANY(${def.col})`); break;
      case 'not_tag': clauses.push(`NOT (${p(String(v).trim().toLowerCase())} = ANY(${def.col}))`); break;
      default: throw new HttpError(400, 'Unknown operator');
    }
  }
  return clauses;
}

export function normTags(tags) {
  if (!tags) return [];
  return [...new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
}

// CSV export cell (guards against spreadsheet formula injection).
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = Array.isArray(v) ? v.join('; ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
