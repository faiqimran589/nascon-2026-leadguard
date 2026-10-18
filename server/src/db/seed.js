// Demo data for presentations:  npm run seed
// Creates the workspace "Sunrise Solar (Demo)" with a team, two pipelines with different custom fields,
// ~300 contacts (to show pagination), opportunities and leads that went through the real assignment engine.
// It does NOT fake integration data: messages, payments and appointments only come from the real providers.
import { tx, pool } from './pool.js';
import { migrate } from './migrate.js';
import { hashPassword } from '../lib/crypto.js';
import { createWorkspace } from '../services/bootstrap.js';
import { createLead, acknowledge } from '../services/leads.js';

const OWNER_EMAIL = process.env.SEED_EMAIL || 'owner@sunrise.demo';
const PASSWORD = process.env.SEED_PASSWORD || 'Demo@12345';

const FIRST = ['Ali', 'Ayesha', 'Hamza', 'Fatima', 'Usman', 'Zainab', 'Bilal', 'Hira', 'Omar', 'Mariam', 'Saad', 'Noor', 'Hassan', 'Iqra', 'Danish', 'Sana', 'Fahad', 'Amna', 'Taimur', 'Rabia'];
const LAST = ['Khan', 'Ahmed', 'Malik', 'Butt', 'Sheikh', 'Qureshi', 'Raza', 'Hussain', 'Chaudhry', 'Siddiqui', 'Iqbal', 'Mirza'];
const CITIES = ['Islamabad', 'Rawalpindi', 'Lahore', 'Karachi', 'Peshawar'];
const pick = (a, i) => a[i % a.length];

async function main() {
  await migrate();
  const exists = await pool.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [OWNER_EMAIL]);
  if (exists.rows.length) {
    console.log(`Demo workspace already exists. Log in as ${OWNER_EMAIL} / ${PASSWORD}`);
    return;
  }
  const pw = await hashPassword(PASSWORD);
  await tx(async (db) => {
    const { workspace: ws, owner, roles, pipeline: sales } = await createWorkspace(db, {
      workspaceName: 'Sunrise Solar (Demo)', ownerName: 'Nadia Owner', email: OWNER_EMAIL, passwordHash: pw, timezone: 'Asia/Karachi',
    });
    const W = ws.id;
    await db.query("UPDATE workspaces SET default_currency = 'pkr' WHERE id = $1", [W]);
    const { rows: [junior] } = await db.query("INSERT INTO roles (workspace_id, name, permissions) VALUES ($1,'Junior sales',$2) RETURNING *", [W, ['crm.view', 'crm.create', 'crm.edit']]);
    const mk = async (name, email, level, roleId, availability = 'available') => (await db.query(
      `INSERT INTO users (workspace_id, email, name, password_hash, level, role_id, availability, timezone) VALUES ($1,$2,$3,$4,$5,$6,$7,'Asia/Karachi') RETURNING *`,
      [W, email, name, pw, level, roleId, availability])).rows[0];
    const admin = await mk('Imran Admin', 'admin@sunrise.demo', 'admin', roles.Admin.id, 'offline');
    const mgr = await mk('Sara Manager', 'manager@sunrise.demo', 'user', roles.Manager.id, 'busy');
    const ayesha = await mk('Ayesha Sales', 'ayesha@sunrise.demo', 'user', roles.Sales.id);
    const bilal = await mk('Bilal Sales', 'bilal@sunrise.demo', 'user', roles.Sales.id);
    const omar = await mk('Omar Junior', 'omar@sunrise.demo', 'user', junior.id);
    const zara = await mk('Zara Backup', 'backup@sunrise.demo', 'user', roles.Sales.id, 'busy');
    await db.query("UPDATE users SET availability = 'offline' WHERE id = $1", [owner.id]);
    void admin;

    // Demo timings: escalation is visible within seconds.
    await db.query(`UPDATE assignment_rules SET max_open_leads = 8, ack_window_seconds = 45, idle_seconds = 3600,
        escalation_levels = $2, backup_user_id = $3, manager_user_id = $4 WHERE workspace_id = $1`,
    [W, JSON.stringify([{ type: 'next_available', seconds: 45 }, { type: 'backup', seconds: 45 }, { type: 'manager', seconds: 60 }]), zara.id, mgr.id]);

    // Second pipeline with its own fields (F2.3)
    const { rows: [inst] } = await db.query("INSERT INTO pipelines (workspace_id, name, position) VALUES ($1,'Installations',1) RETURNING *", [W]);
    const instStages = [];
    for (const [i, [n, k, req]] of [['Site survey', 'open', []], ['Design & quote', 'open', ['roof_size_m2']], ['Installation scheduled', 'open', ['panel_type', 'value']], ['Commissioned', 'won', ['site_survey_done']], ['Cancelled', 'lost', []]].entries()) {
      instStages.push((await db.query('INSERT INTO stages (workspace_id, pipeline_id, name, position, kind, required_fields) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [W, inst.id, n, i, k, req])).rows[0]);
    }
    const field = (entity, pipelineId, key, label, type, options = [], position = 0) => db.query(
      'INSERT INTO custom_fields (workspace_id, entity, pipeline_id, key, label, type, options, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [W, entity, pipelineId, key, label, type, options, position]);
    await field('contact', null, 'city', 'City', 'dropdown', CITIES, 1);
    await field('contact', null, 'preferred_language', 'Preferred language', 'dropdown', ['English', 'Urdu'], 2);
    await field('opportunity', sales.id, 'budget_range', 'Budget range', 'dropdown', ['< 500k', '500k - 1M', '1M+'], 1);
    await field('opportunity', sales.id, 'decision_maker', 'Decision maker reached', 'checkbox', [], 2);
    await field('opportunity', inst.id, 'roof_size_m2', 'Roof size (m²)', 'number', [], 1);
    await field('opportunity', inst.id, 'panel_type', 'Panel type', 'dropdown', ['Mono PERC', 'Bifacial', 'Thin film'], 2);
    await field('opportunity', inst.id, 'site_survey_done', 'Site survey done', 'checkbox', [], 3);
    await field('opportunity', inst.id, 'survey_date', 'Survey date', 'date', [], 4);
    await field('company', null, 'industry', 'Industry', 'dropdown', ['Residential', 'Commercial', 'Industrial'], 1);

    const companies = [];
    for (const [n, ind] of [['Margalla Textiles', 'Industrial'], ['Blue Area Offices', 'Commercial'], ['DHA Residents Assoc.', 'Residential'], ['Pindi Cold Storage', 'Industrial'], ['F-7 Medical Centre', 'Commercial']]) {
      companies.push((await db.query('INSERT INTO companies (workspace_id, name, domain, custom) VALUES ($1,$2,$3,$4) RETURNING *', [W, n, `${n.toLowerCase().replace(/[^a-z]/g, '')}.pk`, { industry: ind }])).rows[0]);
    }
    const { rows: salesStages } = await db.query('SELECT * FROM stages WHERE pipeline_id = $1 ORDER BY position', [sales.id]);
    const owners = [ayesha, bilal, omar, mgr];

    // ~300 contacts to show pagination & filters
    const contacts = [];
    for (let i = 0; i < 300; i++) {
      const fn = pick(FIRST, i); const ln = pick(LAST, i * 7 + 3);
      const { rows: [c] } = await db.query(
        `INSERT INTO contacts (workspace_id, first_name, last_name, email, phone, company_id, owner_id, tags, custom, source, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual', now() - make_interval(days => $10)) RETURNING *`,
        [W, fn, ln, `${fn}.${ln}${i}@example.pk`.toLowerCase(), `+92300${String(1000000 + i * 37).slice(0, 7)}`, i % 6 === 0 ? companies[i % 5].id : null,
          pick(owners, i).id, i % 4 === 0 ? ['vip'] : i % 3 === 0 ? ['residential', 'referral'] : ['residential'],
          { city: pick(CITIES, i), preferred_language: i % 3 ? 'Urdu' : 'English' }, i % 60]);
      contacts.push(c);
    }
    // Opportunities across both pipelines (respecting required fields)
    for (let i = 0; i < 40; i++) {
      const c = contacts[i * 3];
      const useInst = i % 3 === 0;
      const stage = useInst ? instStages[i % 4] : salesStages[i % 6];
      const value = 250000 + (i * 73000) % 2000000;
      const custom = useInst
        ? { roof_size_m2: 40 + (i % 9) * 15, panel_type: ['Mono PERC', 'Bifacial', 'Thin film'][i % 3], site_survey_done: stage.kind === 'won' || i % 2 === 0, survey_date: '2026-10-25' }
        : { budget_range: ['< 500k', '500k - 1M', '1M+'][i % 3], decision_maker: i % 2 === 0 };
      const { rows: [o] } = await db.query(
        `INSERT INTO opportunities (workspace_id, pipeline_id, stage_id, contact_id, title, value, currency, owner_id, close_date, custom, tags, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'pkr',$7,$8,$9,$10, now() - make_interval(days => $11)) RETURNING *`,
        [W, useInst ? inst.id : sales.id, stage.id, c.id, `${useInst ? 'Install' : 'Solar system'} — ${c.first_name} ${c.last_name}`, value, c.owner_id,
          stage.kind === 'won' || i % 2 ? '2026-11-15' : null, custom, i % 5 === 0 ? ['priority'] : [], i % 30]);
      await db.query("INSERT INTO activities (workspace_id, contact_id, opportunity_id, type, actor_user_id, body) VALUES ($1,$2,$3,'opportunity_created',$4,$5)",
        [W, c.id, o.id, c.owner_id, `Opportunity created in ${useInst ? 'Installations' : 'Sales'} → ${stage.name}`]);
    }
    // Leads through the real engine (round-robin among Ayesha, Bilal, Omar)
    const leadPeople = [['Kamran', 'Yousaf', 'web_form', 'Interested in a 10kW system for my house in F-10'], ['Mehwish', 'Tariq', 'manual', 'Walk-in, wants a site survey'], ['Junaid', 'Akhtar', 'web_form', 'Factory rooftop, ~500m²'], ['Laiba', 'Nawaz', 'manual', 'Referred by Ali Khan'], ['Asad', 'Mehmood', 'web_form', 'Net metering question']];
    for (const [i, [fn, ln, src, msg]] of leadPeople.entries()) {
      const lead = await createLead(db, { workspaceId: W, source: src, contact: { firstName: fn, lastName: ln, email: `${fn}.${ln}@example.pk`.toLowerCase(), phone: `+92321${5550000 + i}` }, message: msg, actor: src === 'manual' ? owner : null });
      if (i < 3) {
        const { rows: [u] } = await db.query('SELECT * FROM users WHERE id = $1', [lead.owner_id]);
        await db.query("UPDATE leads SET first_assigned_at = now() - make_interval(secs => $2), assigned_at = now() - make_interval(secs => $2) WHERE id = $1", [lead.id, 60 + i * 50]);
        await acknowledge(db, { workspaceId: W, leadId: lead.id, user: u, via: 'seed' });
      }
    }
    console.log('\nDemo workspace created: Sunrise Solar (Demo)');
    console.log(`  Owner   : ${OWNER_EMAIL}`);
    console.log('  Admin   : admin@sunrise.demo');
    console.log('  Manager : manager@sunrise.demo   (role Manager: reassign, company dashboard, audit)');
    console.log('  Sales   : ayesha@sunrise.demo, bilal@sunrise.demo');
    console.log('  Junior  : omar@sunrise.demo      (cannot see opportunity values)');
    console.log('  Backup  : backup@sunrise.demo');
    console.log(`  Password for all: ${PASSWORD}\n`);
  });
}

main().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
