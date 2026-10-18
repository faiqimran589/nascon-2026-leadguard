// One definition per metric (Glossary §2.7, F5.2, Q12). Dashboard, drill-down lists and the
// recovery queue all use these same SQL fragments, so a figure always matches its records.
import { query } from '../db/pool.js';
import { can } from './permissions.js';
import { startOfDay, startOfMonth } from '../lib/time.js';

export const OPEN_LEAD = "l.status IN ('assigned','acknowledged')";

// Recovery queue item: unacknowledged beyond its window, escalated 2+ times, or idle too long.
export const RECOVERY_REASONS_SQL = `array_remove(ARRAY[
    CASE WHEN l.status = 'assigned' AND l.ack_deadline < now() THEN 'unacknowledged' END,
    CASE WHEN l.escalation_count >= 2 THEN 'escalated' END,
    CASE WHEN l.last_action_at < now() - make_interval(secs => r.idle_seconds) THEN 'idle' END
  ], NULL)`;
export const RECOVERY_WHERE = `${OPEN_LEAD} AND (
    (l.status = 'assigned' AND l.ack_deadline < now())
    OR l.escalation_count >= 2
    OR l.last_action_at < now() - make_interval(secs => r.idle_seconds))`;

// Visibility of leads: own leads unless the user may view all records.
export function leadScope(user, params, alias = 'l') {
  if (can(user, 'crm.view_all')) return 'TRUE';
  params.push(user.id);
  return `${alias}.owner_id = $${params.length}`;
}

export function dashboardScope(user, wantCompany) {
  return wantCompany && can(user, 'dashboard.company') ? 'company' : 'personal';
}

export async function dashboard(user, { scope, tz }) {
  const ws = user.workspace_id;
  const personal = scope === 'personal';
  const me = user.id;
  const today = startOfDay(tz);
  const month = startOfMonth(tz);
  const canValues = can(user, 'values.view');
  const { rows: [wsRow] } = await query('SELECT default_currency FROM workspaces WHERE id = $1', [ws]);

  const [newLeads, pipeline, response, recovery, escalations, team, appts, collected, projected] = await Promise.all([
    query(`SELECT count(*) AS n FROM leads l WHERE l.workspace_id = $1 AND l.created_at >= $2 ${personal ? 'AND l.owner_id = $3' : ''}`,
      personal ? [ws, today, me] : [ws, today]),
    query(`SELECT s.id, s.name, s.position, p.name AS pipeline, p.id AS pipeline_id, count(o.id) AS count, COALESCE(sum(o.value), 0) AS value
             FROM stages s JOIN pipelines p ON p.id = s.pipeline_id
             LEFT JOIN opportunities o ON o.stage_id = s.id AND o.deleted_at IS NULL ${personal ? 'AND o.owner_id = $2' : ''}
            WHERE s.workspace_id = $1 AND s.kind = 'open'
            GROUP BY s.id, p.id ORDER BY p.position, p.created_at, s.position`, personal ? [ws, me] : [ws]),
    query(`SELECT avg(extract(epoch FROM (l.first_acknowledged_at - l.first_assigned_at))) AS avg_s, count(*) AS n
             FROM leads l WHERE l.workspace_id = $1 AND l.first_acknowledged_at IS NOT NULL
              AND l.first_assigned_at >= now() - interval '30 days' ${personal ? 'AND l.first_acknowledged_by = $2' : ''}`,
      personal ? [ws, me] : [ws]),
    query(`SELECT count(*) AS n FROM leads l JOIN assignment_rules r ON r.workspace_id = l.workspace_id
            WHERE l.workspace_id = $1 AND ${RECOVERY_WHERE} ${personal ? 'AND l.owner_id = $2' : ''}`, personal ? [ws, me] : [ws]),
    query(`SELECT count(*) AS n FROM lead_assignments a WHERE a.workspace_id = $1 AND a.kind = 'escalation'
              AND a.created_at >= now() - interval '24 hours' ${personal ? 'AND (a.from_user_id = $2 OR a.to_user_id = $2)' : ''}`,
      personal ? [ws, me] : [ws]),
    query(`SELECT u.id, u.name, u.availability, u.level,
                  (SELECT count(*) FROM leads l WHERE l.owner_id = u.id AND ${OPEN_LEAD}) AS open_leads,
                  r.max_open_leads
             FROM users u JOIN assignment_rules r ON r.workspace_id = u.workspace_id
            WHERE u.workspace_id = $1 AND u.active AND u.password_hash IS NOT NULL ORDER BY u.name`, [ws]),
    query(`SELECT a.id, a.title, a.start_at, a.end_at, a.timezone, u.name AS employee, c.first_name || ' ' || c.last_name AS contact, a.contact_id
             FROM appointments a JOIN users u ON u.id = a.user_id JOIN contacts c ON c.id = a.contact_id
            WHERE a.workspace_id = $1 AND a.status = 'scheduled' AND a.start_at >= now() AND a.start_at < now() + interval '7 days'
              ${personal ? 'AND a.user_id = $2' : ''} ORDER BY a.start_at LIMIT 10`, personal ? [ws, me] : [ws]),
    // Collected revenue: payments confirmed by Stripe's webhook this month, minus confirmed refunds.
    query(`SELECT currency, sum(amount_cents - refunded_cents) AS cents, count(*) AS n
             FROM payments WHERE workspace_id = $1 AND paid_at >= $2 AND status IN ('paid','refunded','partially_refunded')
             ${personal ? 'AND requested_by = $3' : ''} GROUP BY currency`, personal ? [ws, month, me] : [ws, month]),
    // Projected: open pipeline value + payment requests not yet paid.
    query(`SELECT currency, sum(amount_cents) AS cents FROM payments WHERE workspace_id = $1 AND status = 'pending'
             ${personal ? 'AND requested_by = $2' : ''} GROUP BY currency`, personal ? [ws, me] : [ws]),
  ]);

  const availability = { available: 0, busy: 0, on_leave: 0, offline: 0 };
  team.rows.forEach((u) => { availability[u.availability]++; });
  const openValue = pipeline.rows.reduce((a, s) => a + Number(s.value), 0);

  return {
    scope,
    currency: wsRow.default_currency,
    generatedAt: new Date().toISOString(),
    newLeadsToday: Number(newLeads.rows[0].n),
    pipelineByStage: pipeline.rows.map((s) => ({ ...s, value: canValues ? Number(s.value) : null })),
    openPipelineValue: canValues ? openValue : null,
    valuesMasked: !canValues,
    avgFirstResponseSeconds: response.rows[0].avg_s === null ? null : Math.round(Number(response.rows[0].avg_s)),
    responseSample: Number(response.rows[0].n),
    recoveryQueue: Number(recovery.rows[0].n),
    escalations24h: Number(escalations.rows[0].n),
    availability,
    team: team.rows,
    upcomingAppointments: appts.rows,
    collectedThisMonth: collected.rows.map((r) => ({ currency: r.currency, cents: Number(r.cents), count: Number(r.n) })),
    projectedUnpaid: projected.rows.map((r) => ({ currency: r.currency, cents: Number(r.cents) })),
  };
}

// Daily trends for the dashboard charts. Days are calendar days in the viewer's time zone and
// every series uses the same definitions as the headline figures above.
export async function trends(user, { scope, tz, days = 14 }) {
  const ws = user.workspace_id;
  const personal = scope === 'personal';
  const n = Math.min(Math.max(days, 7), 90);
  const me = user.id;
  const { rows: [wsRow] } = await query('SELECT default_currency FROM workspaces WHERE id = $1', [ws]);
  const cur = wsRow.default_currency;
  // $1 ws, $2 tz, $3 days, $4 me (only referenced in personal mode)
  const base = personal ? [ws, tz, n, me] : [ws, tz, n];
  const daysCte = `WITH days AS (
      SELECT generate_series((now() AT TIME ZONE $2)::date - ($3::int - 1), (now() AT TIME ZONE $2)::date, interval '1 day')::date AS day)`;
  const since = `now() - make_interval(days => $3::int + 1)`;
  const [leads, esc, resp, rev, sources] = await Promise.all([
    query(`${daysCte} SELECT d.day, COALESCE(x.n, 0) AS v FROM days d LEFT JOIN (
             SELECT (created_at AT TIME ZONE $2)::date AS day, count(*) AS n FROM leads
              WHERE workspace_id = $1 AND created_at >= ${since} ${personal ? 'AND owner_id = $4' : ''} GROUP BY 1) x ON x.day = d.day ORDER BY d.day`, base),
    query(`${daysCte} SELECT d.day, COALESCE(x.n, 0) AS v FROM days d LEFT JOIN (
             SELECT (created_at AT TIME ZONE $2)::date AS day, count(*) AS n FROM lead_assignments
              WHERE workspace_id = $1 AND kind = 'escalation' AND created_at >= ${since} ${personal ? 'AND (from_user_id = $4 OR to_user_id = $4)' : ''} GROUP BY 1) x ON x.day = d.day ORDER BY d.day`, base),
    query(`${daysCte} SELECT d.day, x.v FROM days d LEFT JOIN (
             SELECT (first_assigned_at AT TIME ZONE $2)::date AS day, avg(extract(epoch FROM (first_acknowledged_at - first_assigned_at))) AS v FROM leads
              WHERE workspace_id = $1 AND first_acknowledged_at IS NOT NULL AND first_assigned_at >= ${since} ${personal ? 'AND first_acknowledged_by = $4' : ''} GROUP BY 1) x ON x.day = d.day ORDER BY d.day`, base),
    query(`${daysCte} SELECT d.day, COALESCE(x.cents, 0) AS v FROM days d LEFT JOIN (
             SELECT (paid_at AT TIME ZONE $2)::date AS day, sum(amount_cents - refunded_cents) AS cents FROM payments
              WHERE workspace_id = $1 AND currency = $${base.length + 1} AND status IN ('paid','refunded','partially_refunded') AND paid_at >= ${since}
              ${personal ? 'AND requested_by = $4' : ''} GROUP BY 1) x ON x.day = d.day ORDER BY d.day`, [...base, cur]),
    query(`SELECT source, count(*) AS n FROM leads WHERE workspace_id = $1 AND created_at >= now() - make_interval(days => $2::int)
             ${personal ? 'AND owner_id = $3' : ''} GROUP BY source ORDER BY n DESC`, personal ? [ws, n, me] : [ws, n]),
  ]);
  const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
  return {
    scope, days: n, currency: cur,
    labels: leads.rows.map((r) => iso(r.day)),
    leads: leads.rows.map((r) => Number(r.v)),
    escalations: esc.rows.map((r) => Number(r.v)),
    responseSeconds: resp.rows.map((r) => (r.v === null ? null : Math.round(Number(r.v)))),
    revenueCents: rev.rows.map((r) => Number(r.v)),
    sources: sources.rows.map((r) => ({ source: r.source, count: Number(r.n) })),
  };
}
