-- LeadGuard database schema (PostgreSQL 14+ / Neon).
-- Idempotent: safe to run on every server start (CREATE ... IF NOT EXISTS).
-- Every business table carries workspace_id; every query filters by it.

-- ============ Workspaces, users, roles, sessions ============
CREATE TABLE IF NOT EXISTS workspaces (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  timezone      text NOT NULL DEFAULT 'Asia/Karachi',
  webhook_token text NOT NULL UNIQUE,          -- unguessable token used in webhook + public form URLs
  default_currency text NOT NULL DEFAULT 'usd',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  permissions  text[] NOT NULL DEFAULT '{}',
  is_system    boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email           text NOT NULL,
  name            text NOT NULL,
  password_hash   text,                            -- null until an invite is accepted
  level           text NOT NULL CHECK (level IN ('owner','admin','user')),
  role_id         uuid REFERENCES roles(id) ON DELETE SET NULL,
  availability    text NOT NULL DEFAULT 'available' CHECK (availability IN ('available','busy','on_leave','offline')),
  active          boolean NOT NULL DEFAULT true,
  timezone        text,
  telegram_chat_id text,
  telegram_link_code text,
  dashboard_prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
  failed_logins   int NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  invite_token_hash text,
  invite_expires_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, email)
);
-- an email may own only one login (simplifies login; each workspace is still isolated)
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   text PRIMARY KEY,                  -- sha256 of the cookie value; raw token never stored
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  user_agent   text
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

-- ============ CRM ============
CREATE TABLE IF NOT EXISTS companies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  domain       text,
  phone        text,
  custom       jsonb NOT NULL DEFAULT '{}'::jsonb,
  version      int NOT NULL DEFAULT 1,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS companies_ws_idx ON companies (workspace_id, name);

CREATE TABLE IF NOT EXISTS contacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id   uuid REFERENCES companies(id) ON DELETE SET NULL,
  first_name   text NOT NULL,
  last_name    text NOT NULL DEFAULT '',
  email        text,
  phone        text,                               -- E.164, e.g. +923001234567
  owner_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  tags         text[] NOT NULL DEFAULT '{}',
  custom       jsonb NOT NULL DEFAULT '{}'::jsonb,
  source       text,
  opted_out    boolean NOT NULL DEFAULT false,
  opted_out_at timestamptz,
  version      int NOT NULL DEFAULT 1,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contacts_ws_idx ON contacts (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS contacts_phone_idx ON contacts (workspace_id, phone);
CREATE INDEX IF NOT EXISTS contacts_email_idx ON contacts (workspace_id, lower(email));

CREATE TABLE IF NOT EXISTS pipelines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  position     int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pipeline_id     uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  name            text NOT NULL,
  position        int NOT NULL DEFAULT 0,
  kind            text NOT NULL DEFAULT 'open' CHECK (kind IN ('open','won','lost')),
  required_fields text[] NOT NULL DEFAULT '{}',  -- built-in keys (value, close_date) or custom field keys
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stages_pipeline_idx ON stages (pipeline_id, position);

CREATE TABLE IF NOT EXISTS custom_fields (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity       text NOT NULL CHECK (entity IN ('contact','company','opportunity')),
  pipeline_id  uuid REFERENCES pipelines(id) ON DELETE CASCADE,  -- opportunity fields: null = all pipelines
  key          text NOT NULL,
  label        text NOT NULL,
  type         text NOT NULL CHECK (type IN ('text','number','date','dropdown','checkbox')),
  options      text[] NOT NULL DEFAULT '{}',
  position     int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, entity, key)
);

CREATE TABLE IF NOT EXISTS opportunities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pipeline_id     uuid NOT NULL REFERENCES pipelines(id),
  stage_id        uuid NOT NULL REFERENCES stages(id),
  contact_id      uuid NOT NULL REFERENCES contacts(id),
  title           text NOT NULL,
  value           numeric(14,2),
  currency        text NOT NULL DEFAULT 'usd',
  owner_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  close_date      date,
  tags            text[] NOT NULL DEFAULT '{}',
  custom          jsonb NOT NULL DEFAULT '{}'::jsonb,
  version         int NOT NULL DEFAULT 1,
  deleted_at      timestamptz,
  stage_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opps_ws_idx ON opportunities (workspace_id, pipeline_id, stage_id);
CREATE INDEX IF NOT EXISTS opps_contact_idx ON opportunities (contact_id);

CREATE TABLE IF NOT EXISTS saved_lists (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  entity       text NOT NULL CHECK (entity IN ('contacts','opportunities','leads')),
  filters      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- criteria are re-evaluated every time the list opens
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ============ Leads & assignment ============
CREATE TABLE IF NOT EXISTS assignment_rules (
  workspace_id        uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  max_open_leads      int NOT NULL DEFAULT 10,
  ack_window_seconds  int NOT NULL DEFAULT 120,
  escalation_levels   jsonb NOT NULL DEFAULT '[{"type":"next_available","seconds":120},{"type":"backup","seconds":120},{"type":"manager","seconds":300}]'::jsonb,
  backup_user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  manager_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  idle_seconds        int NOT NULL DEFAULT 86400,
  acknowledged_on_absence text NOT NULL DEFAULT 'reassign' CHECK (acknowledged_on_absence IN ('reassign','keep')),
  rr_last_user_id     uuid,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leads (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id           uuid NOT NULL REFERENCES contacts(id),
  opportunity_id       uuid REFERENCES opportunities(id) ON DELETE SET NULL,
  source               text NOT NULL CHECK (source IN ('web_form','whatsapp','sms','manual')),
  title                text NOT NULL,
  message              text,
  status               text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','acknowledged','converted','closed')),
  owner_id             uuid REFERENCES users(id),
  assigned_at          timestamptz,           -- last time the system/manager assigned it
  first_assigned_at    timestamptz,
  ack_deadline         timestamptz,           -- null when acknowledged or chain exhausted
  escalation_level     int NOT NULL DEFAULT 0,
  escalation_count     int NOT NULL DEFAULT 0,
  chain_exhausted      boolean NOT NULL DEFAULT false,
  acknowledged_at      timestamptz,
  first_acknowledged_at timestamptz,
  first_acknowledged_by uuid REFERENCES users(id),
  last_action_at       timestamptz NOT NULL DEFAULT now(),
  version              int NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leads_deadline_idx ON leads (ack_deadline) WHERE status = 'assigned' AND ack_deadline IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_ws_idx ON leads (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS leads_owner_idx ON leads (workspace_id, owner_id, status);

CREATE TABLE IF NOT EXISTS lead_assignments (
  id           bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lead_id      uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_user_id uuid REFERENCES users(id),
  to_user_id   uuid REFERENCES users(id),
  kind         text NOT NULL CHECK (kind IN ('initial','escalation','manual','absence','fallback')),
  level        int NOT NULL DEFAULT 0,
  reason       text,
  actor_user_id uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_assign_idx ON lead_assignments (workspace_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS lead_assign_lead_idx ON lead_assignments (lead_id, created_at);

-- ============ Activity timeline (F2.7) ============
CREATE TABLE IF NOT EXISTS activities (
  id             bigserial PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id     uuid REFERENCES contacts(id) ON DELETE CASCADE,
  opportunity_id uuid REFERENCES opportunities(id) ON DELETE CASCADE,
  lead_id        uuid REFERENCES leads(id) ON DELETE CASCADE,
  type           text NOT NULL,   -- note, call, stage_change, assignment, escalation, acknowledged, field_edit, message, payment, appointment, lead_created
  actor_user_id  uuid REFERENCES users(id),
  body           text,
  data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activities_contact_idx ON activities (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS activities_opp_idx ON activities (opportunity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS activities_lead_idx ON activities (lead_id, created_at DESC);

-- ============ In-app notifications ============
CREATE TABLE IF NOT EXISTS notifications (
  id           bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        text NOT NULL,
  body         text,
  link         text,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);

-- ============ Audit log (F4) — append-only ============
CREATE TABLE IF NOT EXISTS audit_log (
  id            bigserial PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  actor_user_id uuid REFERENCES users(id),      -- null = system
  actor_label   text NOT NULL,
  action        text NOT NULL,
  target_type   text,
  target_id     text,
  target_label  text,
  before        jsonb,
  after         jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_ws_idx ON audit_log (workspace_id, created_at DESC);

-- ============ Integrations (I5) ============
CREATE TABLE IF NOT EXISTS integrations (
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider        text NOT NULL CHECK (provider IN ('twilio','stripe','google','telegram')),
  config_enc      text NOT NULL,                  -- AES-256-GCM encrypted JSON (secrets never leave the server)
  public_config   jsonb NOT NULL DEFAULT '{}'::jsonb,  -- non-secret values safe to show (masked hints)
  connected_by    uuid REFERENCES users(id),
  last_success_at timestamptz,
  last_error_at   timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, provider)
);

CREATE TABLE IF NOT EXISTS integration_events (
  id           bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  provider     text NOT NULL,
  direction    text NOT NULL CHECK (direction IN ('inbound','outbound')),
  kind         text NOT NULL,
  result       text NOT NULL CHECK (result IN ('ok','error','rejected','duplicate','retrying')),
  reference    text,
  http_status  int,
  detail       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS integ_events_idx ON integration_events (workspace_id, provider, created_at DESC);

-- Provider event IDs already processed (idempotency for webhooks: Twilio MessageSid+status, Stripe event.id)
CREATE TABLE IF NOT EXISTS processed_webhooks (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider     text NOT NULL,
  event_id     text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, provider, event_id)
);

-- ============ Messaging (I1) ============
CREATE TABLE IF NOT EXISTS conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('whatsapp','sms')),
  opportunity_id  uuid REFERENCES opportunities(id) ON DELETE SET NULL,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  unread_count    int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, contact_id, channel)
);

CREATE TABLE IF NOT EXISTS messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction       text NOT NULL CHECK (direction IN ('inbound','outbound')),
  body            text NOT NULL,
  status          text NOT NULL,   -- received | queued | sending | sent | delivered | read | failed | undelivered
  provider_sid    text,
  error_code      text,
  error_message   text,
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  sent_by         uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_sid_unique ON messages (workspace_id, provider_sid) WHERE provider_sid IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS messages_retry_idx ON messages (next_attempt_at) WHERE next_attempt_at IS NOT NULL;

-- ============ Payments (I2) ============
CREATE TABLE IF NOT EXISTS payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  opportunity_id     uuid NOT NULL REFERENCES opportunities(id),
  contact_id         uuid NOT NULL REFERENCES contacts(id),
  requested_by       uuid REFERENCES users(id),
  amount_cents       bigint NOT NULL CHECK (amount_cents > 0),
  currency           text NOT NULL,
  description        text,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','expired','refunded','partially_refunded')),
  refunded_cents     bigint NOT NULL DEFAULT 0,
  checkout_session_id text UNIQUE,
  payment_intent_id  text,
  checkout_url       text,
  last_error         text,
  paid_at            timestamptz,
  expires_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_ws_idx ON payments (workspace_id, created_at DESC);

-- ============ Calendar (I3) ============
CREATE TABLE IF NOT EXISTS calendar_connections (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  google_email   text,
  tokens_enc     text NOT NULL,          -- encrypted {access_token, refresh_token}
  expires_at     timestamptz,
  status         text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','needs_reconnect')),
  last_error     text,
  connected_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state        text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS appointments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id),
  opportunity_id  uuid REFERENCES opportunities(id) ON DELETE SET NULL,
  user_id         uuid NOT NULL REFERENCES users(id),   -- employee whose calendar holds the event
  title           text NOT NULL,
  notes           text,
  start_at        timestamptz NOT NULL,                 -- stored in UTC (unambiguous)
  end_at          timestamptz NOT NULL,
  timezone        text NOT NULL,                        -- the zone the time was entered in
  google_event_id text,
  status          text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled')),
  created_by      uuid REFERENCES users(id),
  version         int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at)
);
CREATE INDEX IF NOT EXISTS appts_ws_idx ON appointments (workspace_id, start_at);

-- ============ Telegram alert outbox (I4) ============
CREATE TABLE IF NOT EXISTS alert_outbox (
  id              bigserial PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lead_id         uuid REFERENCES leads(id) ON DELETE CASCADE,
  text            text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
CREATE INDEX IF NOT EXISTS alert_outbox_due_idx ON alert_outbox (next_attempt_at) WHERE status = 'pending';

-- ============ Tamper resistance (F4.3): history tables reject UPDATE and DELETE ============
CREATE OR REPLACE FUNCTION forbid_history_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; entries cannot be changed or deleted', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_history_change();

DROP TRIGGER IF EXISTS integration_events_append_only ON integration_events;
CREATE TRIGGER integration_events_append_only BEFORE UPDATE OR DELETE ON integration_events
  FOR EACH ROW EXECUTE FUNCTION forbid_history_change();
