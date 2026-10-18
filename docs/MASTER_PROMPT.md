# LeadGuard: master build prompt

Use this prompt to build the whole platform with an AI coding assistant in a single pass, or to make changes later. If the repository already exists, paste this prompt together with the repository. It describes the system exactly as it is implemented in this repository, so the code and this document stay in agreement.

---

## ROLE AND GOAL

You are a senior full-stack engineer and technical architect. Build **LeadGuard**, a production-quality, multi-tenant web platform for small service companies (5–30 employees: real-estate agencies, solar installers, clinic patient-acquisition teams).

LeadGuard does four things:

- It guarantees that every incoming lead has exactly one accountable owner, and escalates the lead automatically when that owner ignores it.
- It provides a customizable CRM.
- It connects to real external services: Twilio WhatsApp/SMS, Stripe test mode, Google Calendar OAuth 2.0 and a Telegram bot.
- It records every important action in a tamper-resistant audit log.

Work autonomously and deliver the complete, running application in one go:

- server, client, database schema, seed data, automated smoke test, README and `.env.example`;
- no placeholders, TODOs, mock providers or hard-coded data where real stored data is required;
- code that a beginner can run on **Windows** with Node 20+ and deploy for free (Render web service + Neon PostgreSQL).

## NON-NEGOTIABLE RULES

1. Every business table has `workspace_id`. Every query filters by the caller's workspace, taken from the session and never from the request. A guessed id from another workspace returns 404.
2. Every permission is checked on the server (middleware plus per-record scope). Hiding a button is never the only protection.
3. Secrets (API keys, tokens, webhook secrets) are stored per workspace:
   - encrypted with AES-256-GCM (key derived from `ENCRYPTION_KEY`);
   - never sent to the browser, only masked to the last 4 characters;
   - never committed to git.
4. Webhooks verify the provider signature **before** changing anything. Forged or altered requests are rejected AND recorded (in the sync history and in the audit log).
5. Webhook processing is idempotent: provider event ids go into a `processed_webhooks` table with a primary-key conflict guard, inside the same transaction as the change.
6. All timers are stored as database deadlines, never only in memory. A background loop re-checks them, so a restart loses nothing.
7. Escalation can never double-fire:
   - due leads are claimed with `SELECT … FOR UPDATE SKIP LOCKED`;
   - each lead is processed in its own transaction and re-checked under the lock.
8. A lead is never without an owner. If nobody is available, it falls back to backup → manager → Owner.
9. Audit log and integration events are append-only. A DB trigger raises on UPDATE/DELETE, and no endpoint edits them.
10. All input is validated on the server with zod, and all SQL is parameterized (custom-field keys are sanitized to `[a-z0-9_]`).
11. CSRF protection:
    - cookies are httpOnly, `SameSite=Lax`, and `Secure` in production;
    - every state-changing `/api` call must carry `X-Requested-With: LeadGuard`;
    - when an `Origin` header is present, it must match the host.
12. No card data is ever stored. Payment details are entered only on Stripe's hosted Checkout.
13. Every UI action has loading, success and error states with human-readable messages. Every screen works at 390px width with no horizontal scrolling (tables become stacked cards). Everything is keyboard-usable, every input has a label, and color is never the only signal.

## STACK

| Part | Choice |
|---|---|
| Server | Node 20+, Express 4, ES modules, `pg` with plain SQL, `zod`, `helmet`, `express-rate-limit`, `dotenv`. Passwords use Node `crypto.scrypt` (salted, N=16384), so there are no native modules. |
| Client | React 18 + Vite 5 + react-router-dom 6, plain CSS (custom properties), no UI kit. |
| One process | In development, Express mounts Vite in middleware mode (one port, hot reload). In production, Express serves `client/dist`. One URL means no CORS problems. |
| Database | PostgreSQL (Neon). `schema.sql` is idempotent and is applied automatically at startup under an advisory lock. |
| Live updates | Server-Sent Events at `/api/events`. Payloads carry only `{topic, id}`; the browser re-fetches through permission-checked endpoints, so nothing leaks. Events are published only *after* the transaction commits (`onCommit` hook). |
| Worker | `setInterval` in the web process (`WORKER_INTERVAL_MS`, default 2000) that runs escalations, Telegram alert delivery, message retries and cleanup. |
| Hosting | Render free web service. `isProd` is set when `NODE_ENV=production` or `RENDER=true`. `APP_URL` falls back to `RENDER_EXTERNAL_URL`. |

## FOLDER STRUCTURE

```
server/src/
  index.js            app, security middleware, route mounting, static/Vite, worker start
  config.js           env (DATABASE_URL, ENCRYPTION_KEY required; APP_URL, PORT, WORKER_INTERVAL_MS, SESSION_*)
  db/                 pool.js (query/one/tx/onCommit), schema.sql, migrate.js, seed.js
  lib/                crypto.js, http.js (async Router, HttpError, zod errors, paging), time.js (Intl tz), phone.js
  middleware/auth.js  sessions (sha256 token in DB), requireAuth, requirePerm, requireLevel, csrfGuard
  services/           permissions, audit, activity, events(SSE), notify, leads (engine), metrics,
                      crm (fields/filters/masking), messaging, payments, calendar, bootstrap, worker
  integrations/       http.js (timeout + retry with delay), store.js (encrypted config + event log),
                      twilio.js, stripe.js, google.js, telegram.js
  routes/             auth, team, crm, opportunities, config, leads, integrations, engage, webhooks, public
server/test/smoke.js  end-to-end API test (65 checks)
client/src/           main.jsx, styles.css, lib/(api, app context, format), components/(ui, shared, Layout), pages/*
```

## DATA MODEL (PostgreSQL)

**Workspaces, users and access**

- `workspaces(id, name, timezone, webhook_token UNIQUE, default_currency)`. The token is used in public form and webhook URLs.
- `roles(workspace_id, name, permissions text[], is_system)`.
- `users(workspace_id, email, name, password_hash, level owner|admin|user, role_id, availability available|busy|on_leave|offline, active, timezone, telegram_chat_id, telegram_link_code, dashboard_prefs jsonb, failed_logins, locked_until, invite_token_hash, invite_expires_at)`. Email is unique by `lower(email)`.
- `sessions(token_hash PK, user_id, workspace_id, expires_at, last_seen_at)`. Sessions have an idle timeout and a maximum age.

**CRM**

- `companies(…, custom jsonb, version, deleted_at)`.
- `contacts(company_id, first_name, last_name, email, phone E.164, owner_id, tags text[], custom jsonb, source, opted_out, version, deleted_at)`.
- `pipelines`; `stages(pipeline_id, name, position, kind open|won|lost, required_fields text[])`.
- `custom_fields(entity contact|company|opportunity, pipeline_id NULL = all, key, label, type text|number|date|dropdown|checkbox, options[])`.
- `opportunities(pipeline_id, stage_id, contact_id, title, value numeric, currency = workspace currency, owner_id, close_date, tags, custom jsonb, version, deleted_at, stage_changed_at)`.
- `saved_lists(user_id, entity, filters jsonb)`. Criteria are re-evaluated on every open.

**Leads and assignment**

- `assignment_rules(workspace_id PK, max_open_leads, ack_window_seconds, escalation_levels jsonb [{type next_available|backup|manager, seconds}], backup_user_id, manager_user_id, idle_seconds, acknowledged_on_absence reassign|keep, rr_last_user_id)`.
- `leads(contact_id, opportunity_id, source web_form|whatsapp|sms|manual, title, message, status assigned|acknowledged|converted|closed, owner_id, assigned_at, first_assigned_at, ack_deadline, escalation_level, escalation_count, chain_exhausted, acknowledged_at, first_acknowledged_at, first_acknowledged_by, last_action_at, version)`.
- `lead_assignments(lead_id, from_user_id, to_user_id, kind initial|escalation|manual|absence|fallback, level, reason, actor_user_id)`.

**History and notifications**

- `activities(contact_id, opportunity_id, lead_id, type, actor_user_id, body, data jsonb)`. This is the timeline. Value changes are flagged `data.sensitive='value'` and masked on read.
- `notifications` (in-app bell).
- `audit_log(actor_user_id NULL = system, actor_label, action, target_type, target_id, target_label, before jsonb, after jsonb)`. Append-only trigger.

**Integrations**

- `integrations(workspace_id, provider twilio|meta|stripe|google|telegram, config_enc, last_success_at, last_error_at, last_error)`.
- `integration_events(provider, direction inbound|outbound, kind, result ok|error|rejected|duplicate|retrying, reference, http_status, detail)`. Append-only trigger.
- `processed_webhooks(workspace_id, provider, event_id) PK`.
- `conversations(contact_id, channel, opportunity_id, unread_count) UNIQUE(workspace, contact, channel)`.
- `messages(conversation_id, direction, body, status, provider_sid UNIQUE per workspace, error_code, error_message, attempts, next_attempt_at, sent_by)`.
- `payments(opportunity_id, contact_id, requested_by, amount_cents, currency, status pending|paid|failed|expired|refunded|partially_refunded, refunded_cents, checkout_session_id UNIQUE, payment_intent_id, checkout_url, last_error, paid_at, expires_at)`.
- `calendar_connections(user_id PK, google_email, tokens_enc, expires_at, status connected|needs_reconnect, last_error)`.
- `oauth_states(state, user_id, expires_at)`.
- `appointments(contact_id, opportunity_id, user_id, title, notes, start_at/end_at timestamptz UTC, timezone, google_event_id, status scheduled|cancelled, version)`.
- `alert_outbox(user_id, lead_id, text, status pending|sent|failed|skipped, attempts, next_attempt_at, last_error)`.

## FEATURES BY REQUIREMENT

### F1. Accounts, roles and permissions

- **Sign-up** creates the workspace, the default roles (Admin = all, Manager, Sales), the Owner, the assignment rules and a default "Sales" pipeline (New, Qualified, Proposal sent* [value], Negotiation* [value], Won [value, close_date], Lost).
- **Login protection:** rate limit per IP, plus account lock after 5 failures for 5 minutes. "Log out", "Log out everywhere" and a password change all end sessions.
- **Invites:** create a 7-day tokenized link (no email service is needed). Only the Owner can grant the Admin level. An Admin cannot modify the Owner or their own role.
- **Permissions:** `crm.view`, `crm.view_all`, `crm.create`, `crm.edit`, `crm.delete`, `crm.export`, `values.view`, `leads.reassign`, `rules.manage`, `pipeline.manage`, `integrations.manage`, `users.manage`, `audit.view`, `dashboard.company`. The Owner always has all of them.
- **Record scope:** without `crm.view_all`, a user sees only records where they are owner (contacts / leads / opportunities, plus opportunities of contacts they own).
- **F1.4 value masking:** without `values.view`, the value is null and `value_masked` is true. This applies to lists, detail pages, board totals, the dashboard, CSV export (`***`) and activity entries. Filtering or setting by value returns 403.

### F2. Customizable CRM

- Contacts belong to a company and have many opportunities. The contact page is the **complete customer view**:
  - conversation with the composer;
  - opportunities, payments, appointments and leads;
  - assigned employee and status;
  - custom fields;
  - the timeline.
- Custom fields are created in the UI. Opportunity fields can be limited to one pipeline, so two pipelines show different field sets. Values are validated by type.
- Stage-required fields are enforced on create, PATCH, board move and convert. A blocked move returns 422 with a `missing[]` list. The UI then opens a "fill required fields and move" dialog.
- Pipelines and stages support add, rename, reorder (up/down) and kind (open, won, lost). A stage that still holds opportunities can only be deleted with `?moveTo=`, and the move is logged on every opportunity. A pipeline must keep at least one open stage.
- Deleting a field removes its values from all records and from stage requirements.
- The board supports native drag and drop, plus an accessible per-card "Move to" select.
- The filter builder offers field / operator / value rows (owner incl. `me`, stage, pipeline, tag, date with on/before/after/last N days, number comparisons, custom fields, checkbox). Results can be saved as a list, which re-runs on open and refreshes live.
- Optimistic concurrency: each PATCH sends `version`. A mismatch returns 409 "Someone else changed this… reload".
- Soft delete:
  - deleting a contact also deletes its opportunities and closes its open leads, while payments and audit entries are kept;
  - deleting a company unlinks its contacts.

### F3. Lead engine (`services/leads.js`)

**Intake.** Leads arrive from three places, each with a source label:

- the public form `/form/:workspaceToken` (rate limited, honeypot, email or phone required);
- an inbound WhatsApp/SMS message from an unknown number;
- manual entry.

Contacts are matched by normalized phone or lower-cased email.

**Assignment.** Inside one transaction:

1. Lock `assignment_rules FOR UPDATE`. Lock order is always lead row first, then rules, so there are no deadlocks.
2. Choose round-robin among *available* employees: `availability = 'available'`, active, joined, and open leads (assigned + acknowledged) below `max_open_leads`. Remember `rr_last_user_id`.
3. If nobody qualifies, fall back to the backup, then the manager, then the Owner.
4. `setOwner()` then does all of the following:
   - updates the lead (`assigned_at`, `first_assigned_at`, `ack_deadline = now() + seconds`, level, counts);
   - inserts into `lead_assignments`;
   - sets the contact owner (so conversations follow);
   - writes the activity and the audit entry;
   - sends the in-app notification and SSE event;
   - on an escalation, queues the Telegram alert.

**Acknowledge.** Run `UPDATE … WHERE owner_id = me AND status = 'assigned'`. Any recorded action by the owner (note, call log, message, stage change, opportunity, payment request, appointment, edit) also acknowledges, through `recordLeadAction()`. That function also refreshes `last_action_at` for idle detection.

**Escalation chain.** Levels are configurable (1–6), each with its own seconds. When a window expires, the lead moves to the level's target:

- `next_available`: round-robin, excluding everyone who already held the lead;
- `backup`: only if not on leave or offline;
- `manager`: falls back to the Owner if absent.

Unresolvable levels are skipped. When the chain is exhausted, `chain_exhausted` is set, the lead stays with its owner, and the manager and Owner are notified. The lead then appears in the recovery queue.

**Absence (F3.6).** Setting On leave or Offline (or deactivating a user) immediately reassigns their unacknowledged leads. Acknowledged leads follow the workspace rule: `reassign` (the new owner must acknowledge) or `keep`. The rule is shown on the Rules page and on the lead page, and the API returns the counts of moved and kept leads.

**Manual reassign.** Requires `leads.reassign`. The target cannot be On leave or Offline. Manual reassignments are counted separately from escalations.

**Recovery queue.** One SQL definition is shared by the page and the dashboard. A lead appears when any of these holds, with reason badges:

- `status = 'assigned' AND ack_deadline < now()`;
- `escalation_count >= 2`;
- `last_action_at < now() - idle_seconds`.

**F3.9 / I4.** Every escalation queues an `alert_outbox` row. The worker delivers it with a lease, retries up to 3 times (5s, 15s), and records the outcome. A missing integration or unlinked user is recorded as `skipped` with the reason, and Admins can retry from the Integrations page.

### F4. Audit log

The audit log records these events: `workspace.created`, `lead.created/assigned/acknowledged/escalated/reassigned/escalation_exhausted/converted/closed`, `user.invited/joined/updated/role_changed/availability_changed/telegram_linked`, `role.created/permissions_changed/deleted`, `pipeline.*`, `stage.*`, `field.*`, `rules.updated`, `workspace.updated`, `integration.connected/updated/disconnected`, `calendar.connected/disconnected`, `contact.deleted/opted_out/opted_in`, `company.deleted`, `opportunity.deleted`, `payment.<status>`, `export.*`, `auth.password_changed/locked`, `webhook.rejected`.

Each entry stores the actor (or System), the time, the target, and before/after values.

The audit page requires `audit.view`. It filters by event group, actor and date range. It is read-only and backed by the DB trigger.

### F5. Dashboard (`services/metrics.js`, one definition per figure)

| Figure | Definition | Drill-down |
|---|---|---|
| New leads today | `created_at` ≥ start of today in the user's time zone | `/leads?preset=new_today` |
| Average time to first response | `first_acknowledged_at − first_assigned_at`, last 30 days; personal view uses `first_acknowledged_by = me` | none |
| Recovery queue count | Same SQL as the recovery page | Recovery queue |
| Escalations in 24 hours | Count of escalation rows; the drill-down lists the same rows | Escalations page |
| Employee availability | Count per status, plus each employee's open leads | none |
| Open pipeline value by stage | Open stages only; counts instead of values when masked | Stage-filtered list |
| Upcoming appointments | Next 7 days | Appointments page |
| Payments received this month | Collected revenue (`paid_at` this month, minus refunds), per currency | `/payments?preset=collected_month` |
| Projected revenue | Open pipeline plus pending payment requests | none |

Scope: users with `dashboard.company` can switch between Company and Just me; everyone else gets personal figures. Show/hide choices are stored in `users.dashboard_prefs`, so they are remembered across devices. Everything refreshes live over SSE.

## INTEGRATIONS (each workspace enters its own credentials on the Integrations page)

The Integrations page shows, for each provider:

- status (not connected / connected / error);
- last success time and recent errors;
- what it can and cannot do;
- step-by-step setup instructions;
- copyable webhook URLs (`/webhooks/twilio/:token/inbound|status`, `/webhooks/stripe/:token`, Google redirect `/oauth/google/callback`);
- buttons to test, change credentials or disconnect.

Saving runs a live test first (Twilio account fetch, Stripe `/v1/balance`, Telegram `getMe`), and nothing is saved on failure. Live Stripe keys are refused. The Synchronization history tab lists every inbound and outbound event, with filters. The Escalation alerts tab lists alert deliveries, with retry. Outbound calls use a 10s timeout and retry 429/5xx/network errors with a delay. Permanent errors are translated into plain English (for example Twilio 63015 means "phone has not joined the sandbox"). One provider failing never breaks the rest.

### Meta WhatsApp Cloud API (I1 alternative; used instead of Twilio when connected)

- **Configuration:** each workspace saves its `phoneNumberId`, `accessToken`, `appSecret` and an optional `graphVersion` (default v23.0), encrypted. The connection is tested with `GET /{phone-number-id}?fields=display_phone_number,verified_name`.
- **Webhook URL:** `/webhooks/meta/:token`.
  - **GET** performs the verification handshake. The `hub.verify_token` must equal `lg_` + the first 24 hex characters of sha256(`meta-verify:` + workspace token); this value is shown on the Integrations page.
  - **POST** verifies `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256(appSecret, raw body). It then iterates `entry[].changes[]` where `field` is `messages`, and ignores other `phone_number_id`s.
  - `value.messages[]` go to the shared `receiveMessage()` (de-duplicated by wamid; sender `+` + `from`; profile name taken from `contacts[]`).
  - `value.statuses[]` go to the shared `applyStatus()` (de-duplicated by `wamid:status`; the status never moves backwards; errors are explained).
- **Sending:** `POST /{phone-number-id}/messages` with `{messaging_product:'whatsapp', to: digits, type:'text', text:{body}}`, sharing the same store-first, retry and Retry-button logic as Twilio.
- **Error codes translated:** 190 (token expired), 131030 (number not in the test list), 131047 (outside the 24-hour window), 131026, 131056, 130429, 133010.

### Twilio (I1)

- **Inbound:**
  1. Verify `X-Twilio-Signature`: HMAC-SHA1 over the URL plus the sorted parameters, checked against `APP_URL + originalUrl` and against the request host.
  2. De-duplicate by MessageSid.
  3. Match the contact by phone, or create the contact and a lead.
  4. Store the message and bump unread.
  5. Mark opt-out on STOP and opt back in on START.
  6. Notify the owner.
  7. Reply with empty TwiML.
- **Outbound:**
  1. Store the message as `queued` first.
  2. Claim it with a lease and POST `Messages.json` with `StatusCallback`.
  3. On a transient failure, retry automatically after 10s and 30s; after 3 attempts the message is `failed` with the reason, and the UI offers a Retry button.
  4. Sending to an opted-out contact returns 409 with an explanation, and the composer is replaced by a notice.
- **Status callback:** verified and de-duplicated (`sid:status`). The status never moves backwards (queued < sending < sent < delivered < read; failed/undelivered are terminal) and stores the error code.

### Stripe (I2)

- **Payment request:** Checkout Session (`mode=payment`, `price_data`, `metadata.payment_id`, `payment_intent_data.metadata`, `expires_at` 30–1440 minutes, Idempotency-Key). The link can be copied, opened, sent over WhatsApp/SMS or cancelled (expire API).
- **Webhook:** raw body; `Stripe-Signature` verified by hand (HMAC-SHA256 of `t.body`, 5-minute tolerance); live-mode events refused. Handled events:

| Event | Effect on the payment |
|---|---|
| `checkout.session.completed` (`payment_status = paid`) | paid, with `paid_at` and payment intent stored |
| `checkout.session.async_payment_succeeded` | paid |
| `checkout.session.async_payment_failed` | failed |
| `checkout.session.expired` | expired, shown as "Expired / abandoned" |
| `payment_intent.payment_failed` | failed with the reason; a later success overrides it |
| `charge.refunded` | `refunded_cents`, and refunded or partially_refunded |

- **Traceability:** each payment shows the opportunity, contact, requester, the Stripe session/intent ids, and the collected versus awaiting totals.

### Google Calendar (I3)

- **Setup:** the per-workspace OAuth client is entered by an Admin. Each employee connects their own account from their Profile page.
- **Consent flow:** state stored in `oauth_states` (10 minutes); scopes `openid email https://www.googleapis.com/auth/calendar.events`; `access_type=offline`; `prompt=consent`.
- **Tokens:** encrypted and stored on the server only. They refresh automatically 60 seconds before expiry, and a 401 forces one refresh. If Google returns `invalid_grant`, the connection is set to `needs_reconnect` and shown on the Team, Profile and booking screens. Disconnecting revokes the token.
- **Booking:**
  1. Local time plus an IANA time zone is converted to UTC (`zonedToUtc` with Intl).
  2. Busy times are read from Google `events.list`, ignoring transparent and cancelled events.
  3. On an overlap the server returns 409 with the conflicts, and the user can "Book anyway" (`force`).
  4. The event is created on the primary calendar and the appointment is stored.
  5. Reschedule (PATCH, with version) and cancel (DELETE) update Google and write to the activity timeline.
  6. An employee without a calendar cannot be booked, and the screen says why.

### Telegram (I4)

- The bot token is checked with `getMe`, and the bot's username is stored.
- An employee links their chat through a deep link `t.me/<bot>?start=<code>`, then clicks "I pressed Start" (the server finds the code with `getUpdates`). A manual chat ID is also accepted, and a test alert can be sent.
- Each alert names the lead, the source, the reason and a link to the lead.

## API (all JSON under `/api` unless noted)

- **Auth:** `auth/signup|login|logout|logout-all|me|change-password|invite/:token|accept-invite`; `public/forms/:token` (GET, POST); `events` (SSE).
- **Team and profile:** `users`, `users/invite`, `users/:id`, `users/:id/availability`, `users/:id/reinvite`; `permissions`, `roles`; `me`, `me/telegram/*`; `notifications`.
- **CRM:** `contacts` (+ `/:id`, `/:id/notes`, `/:id/messages`, `filter-fields`); `companies`; `opportunities` (+ `/:id`, `/:id/move`, `/:id/payments`, `filter-fields`); `lists`; `export/contacts.csv`, `export/opportunities.csv`.
- **Configuration:** `pipelines`, `pipelines/:id/stages`, `pipelines/:id/stage-order`, `stages/:id`, `fields`, `rules`, `workspace`.
- **Leads, dashboard and audit:** `leads` (+ `/recovery`, `/escalations`, `/:id`, `/:id/ack|reassign|notes|convert|close`); `dashboard`; `audit`; `payments`, `payments/:id/expire|send`.
- **Engagement:** `conversations`, `messages/:id/retry`; `appointments` (+ `/:id`, `/:id/cancel`); `calendar/busy|connect|disconnect`.
- **Integrations:** `integrations`, `integrations/:provider` (PUT, DELETE), `integrations/:provider/test`, `integration-events`, `alerts`, `alerts/:id/retry`.
- **Outside `/api`:** `/webhooks/twilio/:token/inbound|status`, `/webhooks/stripe/:token`, `/oauth/google/callback`, `/api/health`.

## UI PAGES

- **Public:** Login, Sign-up, Accept invite, Public lead form, Payment thank-you.
- **Main app:**
  - **Dashboard:** clickable figures, scope toggle, Customize.
  - **Leads:** filters, live countdown, new lead.
  - **Lead detail:** ownership card with countdown and progress bar, Acknowledge, Reassign, Convert, Close, assignment history, notes.
  - **Recovery queue, Escalations.**
  - **Inbox:** conversation list and thread.
  - **Contacts:** search, filter builder, saved lists, CSV.
  - **Contact detail:** complete customer view.
  - **Companies.**
  - **Opportunities:** board or list, pipeline select, filters.
  - **Opportunity detail:** stage stepper, payments, appointments, timeline.
  - **Appointments, Payments.**
  - **Team:** availability, invite, edit, calendar and Telegram status.
  - **Roles & permissions:** matrix.
  - **Pipelines & fields.**
  - **Assignment rules:** "Use demo timings (30s)" button.
  - **Integrations:** three tabs.
  - **Audit log.**
  - **Workspace & web form:** form link, embed code, time zone, currency.
  - **Profile:** calendar, Telegram, time zone, password, sign out everywhere.
- **Top bar:** your own availability switch, notification bell (live), live-connection indicator.

## QUALITY BAR

- Pagination (25 per page, maximum 100) everywhere lists can grow. The seed creates 300 contacts.
- Every request shows spinners and busy buttons. Errors appear as toasts with `role=alert`. Forms show field-level errors from the server's zod `fields` map.
- Accessibility: skip link, focus trap in dialogs, Escape closes, visible focus ring, `aria-live` toasts, status badges carry text.
- Every time is shown in the user's time zone (profile setting, otherwise workspace default) and stored as `timestamptz`.

## DELIVERABLES TO GENERATE

1. All server and client code listed above, `package.json` (scripts: `dev`, `build`, `start`, `seed`, `migrate`, `test`) and `vite.config.js`.
2. `server/src/db/seed.js`: demo workspace "Sunrise Solar (Demo)" with:
   - owner, admin, manager, two sales, a junior (no `values.view`) and a backup, all with password `Demo@12345`;
   - 45-second timers;
   - a second "Installations" pipeline with its own fields and stage requirements;
   - 300 contacts and 40 opportunities;
   - 5 leads created through the real engine.
   No fake messages, payments or appointments.
3. `server/test/smoke.js`: an end-to-end test covering auth, CSRF, roles, isolation, round-robin, acknowledge, escalation, concurrent no-double-escalation, absence, recovery = dashboard, masking, filters, required fields, stale edit, signed/forged/duplicate Twilio and Stripe webhooks, refunds and audit immutability.
4. `README.md` (Windows-first setup, every account step by step, deploy to Render, demo script, troubleshooting), `.env.example`, `.gitignore` (`.env`, `node_modules`, `client/dist`, keeping `!.env.example`) and `.nvmrc`.

## HOW TO EXTEND (when asked for changes later)

- Read the relevant service first. Keep business rules in `services/`, provider code in `integrations/`, and HTTP in `routes/`.
- New tables go into `schema.sql` as `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, which keeps the migration idempotent.
- Every new endpoint needs: `requireAuth` (router level), `requirePerm(...)`, workspace filter, scope filter, zod validation, an audit entry for configuration or security changes, and `emit(db, ws, topic)` after commit.
- Run `npm test` against a running dev server after each change. All checks must stay green.
