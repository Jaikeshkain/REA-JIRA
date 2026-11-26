-- Tracker schema (Phase 1). Mirrors JIRA_REQUIREMENTS.md §2.

CREATE TABLE IF NOT EXISTS tenants (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  tenant_id     INT NOT NULL REFERENCES tenants(id),
  email         TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_color  TEXT NOT NULL DEFAULT '#0c66e4',
  is_site_admin BOOLEAN NOT NULL DEFAULT false,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS priorities (
  id        SERIAL PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  position  INT NOT NULL,
  color     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id                  SERIAL PRIMARY KEY,
  tenant_id           INT NOT NULL REFERENCES tenants(id),
  key                 TEXT NOT NULL,
  name                TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  lead_id             INT REFERENCES users(id),
  default_assignee_id INT REFERENCES users(id),
  issue_counter       INT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id  INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('admin','member','viewer','guest')),
  PRIMARY KEY (project_id, user_id)
);

-- hierarchy_level: 1 = Epic, 0 = Story/Task, -1 = Subtask
CREATE TABLE IF NOT EXISTS issue_types (
  id               SERIAL PRIMARY KEY,
  project_id       INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  hierarchy_level  INT NOT NULL,
  color            TEXT NOT NULL
);

-- category: todo | in_progress | done (Jira: new / indeterminate / done)
CREATE TABLE IF NOT EXISTS statuses (
  id          SERIAL PRIMARY KEY,
  project_id  INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL CHECK (category IN ('todo','in_progress','done')),
  position    INT NOT NULL
);

-- from_status_id NULL means "from any status" (team-managed default)
CREATE TABLE IF NOT EXISTS transitions (
  id              SERIAL PRIMARY KEY,
  project_id      INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  from_status_id  INT REFERENCES statuses(id) ON DELETE CASCADE,
  to_status_id    INT NOT NULL REFERENCES statuses(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS issues (
  id           SERIAL PRIMARY KEY,
  tenant_id    INT NOT NULL REFERENCES tenants(id),
  project_id   INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number       INT NOT NULL,
  key          TEXT NOT NULL,
  type_id      INT NOT NULL REFERENCES issue_types(id),
  status_id    INT NOT NULL REFERENCES statuses(id),
  priority_id  INT REFERENCES priorities(id),
  summary      TEXT NOT NULL,
  description  JSONB,
  assignee_id  INT REFERENCES users(id),
  reporter_id  INT REFERENCES users(id),
  creator_id   INT NOT NULL REFERENCES users(id),
  parent_id    INT REFERENCES issues(id) ON DELETE SET NULL,
  labels       TEXT[] NOT NULL DEFAULT '{}',
  due_date     DATE,
  start_date   DATE,
  story_points NUMERIC,
  rank         TEXT NOT NULL,
  resolution   TEXT,
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, number),
  UNIQUE (tenant_id, key)
);
CREATE INDEX IF NOT EXISTS issues_project_status ON issues(project_id, status_id, rank);
CREATE INDEX IF NOT EXISTS issues_assignee ON issues(assignee_id);

CREATE TABLE IF NOT EXISTS comments (
  id          SERIAL PRIMARY KEY,
  issue_id    INT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author_id   INT NOT NULL REFERENCES users(id),
  parent_id   INT REFERENCES comments(id) ON DELETE CASCADE,
  body        JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Immutable audit trail; drives History tab, activity stream and JQL history operators later.
CREATE TABLE IF NOT EXISTS changelog (
  id           SERIAL PRIMARY KEY,
  issue_id     INT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  actor_id     INT NOT NULL REFERENCES users(id),
  field        TEXT NOT NULL,
  from_value   TEXT,
  from_string  TEXT,
  to_value     TEXT,
  to_string    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS changelog_issue ON changelog(issue_id, created_at);

CREATE TABLE IF NOT EXISTS watchers (
  issue_id  INT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, user_id)
);

-- ---------------------------------------------------------------- Phase 2: sprints

-- Project feature toggles (Jira: Space settings → Features → Sprints / Estimation)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS sprints_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS sprint_counter INT NOT NULL DEFAULT 0;

-- state: future → active → closed (at most one active sprint per project)
CREATE TABLE IF NOT EXISTS sprints (
  id            SERIAL PRIMARY KEY,
  project_id    INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  goal          TEXT NOT NULL DEFAULT '',
  state         TEXT NOT NULL DEFAULT 'future' CHECK (state IN ('future','active','closed')),
  start_date    TIMESTAMPTZ,
  end_date      TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_sprint ON sprints(project_id) WHERE state = 'active';

ALTER TABLE issues ADD COLUMN IF NOT EXISTS sprint_id INT REFERENCES sprints(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS issues_sprint ON issues(sprint_id);

-- Sprint scope log: when an issue entered/left a sprint and its estimate then.
-- Drives burndown (scope over time) and the sprint report (committed vs added vs carried over).
CREATE TABLE IF NOT EXISTS sprint_scope (
  id          SERIAL PRIMARY KEY,
  sprint_id   INT NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
  issue_id    INT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at  TIMESTAMPTZ,
  points      NUMERIC,
  outcome     TEXT CHECK (outcome IN ('completed','not_completed','removed'))
);
CREATE INDEX IF NOT EXISTS sprint_scope_sprint ON sprint_scope(sprint_id);

-- ---------------------------------------------------------------- Phase 3: links + attachments

-- Global link types observed on the Jira site (JIRA_REQUIREMENTS §2.1). "A blocks B": A = outward, B = inward.
CREATE TABLE IF NOT EXISTS link_types (
  id        SERIAL PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  outward   TEXT NOT NULL,
  inward    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issue_links (
  id                SERIAL PRIMARY KEY,
  type_id           INT NOT NULL REFERENCES link_types(id),
  outward_issue_id  INT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  inward_issue_id   INT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  created_by        INT NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (type_id, outward_issue_id, inward_issue_id),
  CHECK (outward_issue_id <> inward_issue_id)
);
CREATE INDEX IF NOT EXISTS issue_links_out ON issue_links(outward_issue_id);
CREATE INDEX IF NOT EXISTS issue_links_in ON issue_links(inward_issue_id);

-- File bytes live outside the DB (ATTACHMENTS_DIR); the row keeps metadata + content hash.
CREATE TABLE IF NOT EXISTS attachments (
  id           SERIAL PRIMARY KEY,
  issue_id     INT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author_id    INT NOT NULL REFERENCES users(id),
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size         BIGINT NOT NULL,
  sha256       TEXT NOT NULL,
  storage_key  TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attachments_issue ON attachments(issue_id);

-- ---------------------------------------------------------------- Phase 3: filters + dashboards

-- share: private (owner only) | project (members of project_id) | site (everyone on the site)
CREATE TABLE IF NOT EXISTS filters (
  id           SERIAL PRIMARY KEY,
  tenant_id    INT NOT NULL REFERENCES tenants(id),
  owner_id     INT NOT NULL REFERENCES users(id),
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  jql          TEXT NOT NULL,
  share        TEXT NOT NULL DEFAULT 'private' CHECK (share IN ('private','project','site')),
  project_id   INT REFERENCES projects(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, owner_id, name),
  CHECK (share <> 'project' OR project_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS filter_favourites (
  filter_id  INT NOT NULL REFERENCES filters(id) ON DELETE CASCADE,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (filter_id, user_id)
);

CREATE TABLE IF NOT EXISTS dashboards (
  id           SERIAL PRIMARY KEY,
  tenant_id    INT NOT NULL REFERENCES tenants(id),
  owner_id     INT NOT NULL REFERENCES users(id),
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  share        TEXT NOT NULL DEFAULT 'private' CHECK (share IN ('private','project','site')),
  project_id   INT REFERENCES projects(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (share <> 'project' OR project_id IS NOT NULL)
);

-- type: filter-results | breakdown | created-vs-resolved | assigned-to-me ; config is type-specific JSON
CREATE TABLE IF NOT EXISTS gadgets (
  id            SERIAL PRIMARY KEY,
  dashboard_id  INT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  col           INT NOT NULL DEFAULT 0 CHECK (col IN (0, 1)),
  position      INT NOT NULL DEFAULT 0,
  config        JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS gadgets_dashboard ON gadgets(dashboard_id, col, position);

-- ---------------------------------------------------------------- Phase 3: custom fields + workflow rules

-- type: text | paragraph | number | date | select | multiselect | user
-- options (select/multiselect): [{"id":"o1","value":"S1 - Critical"}, ...]; issue_type_ids NULL = all work types
CREATE TABLE IF NOT EXISTS custom_fields (
  id              SERIAL PRIMARY KEY,
  project_id      INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  type            TEXT NOT NULL CHECK (type IN ('text','paragraph','number','date','select','multiselect','user')),
  options         JSONB NOT NULL DEFAULT '[]',
  required        BOOLEAN NOT NULL DEFAULT false,
  issue_type_ids  INT[],
  position        INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS custom_fields_name ON custom_fields(project_id, lower(name));

-- One row per (issue, field); empty values are deleted rather than stored
CREATE TABLE IF NOT EXISTS issue_custom_values (
  issue_id  INT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  field_id  INT NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  value     JSONB NOT NULL,
  PRIMARY KEY (issue_id, field_id)
);
CREATE INDEX IF NOT EXISTS issue_custom_values_field ON issue_custom_values(field_id);

-- Transition rules: validator (fields that must be filled) + condition (roles allowed; NULL = anyone who can transition)
ALTER TABLE transitions ADD COLUMN IF NOT EXISTS required_fields TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE transitions ADD COLUMN IF NOT EXISTS allowed_roles TEXT[];

-- ---------------------------------------------------------------- Phase 3: notifications

-- kind: assigned | mentioned (Direct)  ·  commented | status (Watching)
CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL PRIMARY KEY,
  tenant_id   INT NOT NULL REFERENCES tenants(id),
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id    INT NOT NULL REFERENCES users(id),
  issue_id    INT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('assigned','mentioned','commented','status')),
  data        JSONB NOT NULL DEFAULT '{}',
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, created_at DESC);

-- ---------------------------------------------------------------- Phase 4: automation

-- trigger: {"type":"issue_created"} | {"type":"issue_transitioned","toStatusId"?,"fromStatusId"?}
--          | {"type":"field_changed","field":"priority"} | {"type":"comment_added"}
-- actions: [{"type":"transition","statusId"} | {"type":"assign","to":"reporter|initiator|unassigned|<accountId>"}
--           | {"type":"set_field","field","value"} | {"type":"add_label","label"} | {"type":"comment","text"}]
CREATE TABLE IF NOT EXISTS automation_rules (
  id             SERIAL PRIMARY KEY,
  project_id     INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  trigger        JSONB NOT NULL,
  condition_jql  TEXT,
  actions        JSONB NOT NULL DEFAULT '[]',
  created_by     INT NOT NULL REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS automation_rules_project ON automation_rules(project_id) WHERE enabled;

-- Audit log: one row per rule evaluation that matched its trigger
CREATE TABLE IF NOT EXISTS automation_runs (
  id          SERIAL PRIMARY KEY,
  rule_id     INT NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  issue_id    INT REFERENCES issues(id) ON DELETE SET NULL,
  status      TEXT NOT NULL CHECK (status IN ('success','no_action','error')),
  message     TEXT NOT NULL DEFAULT '',
  actions     JSONB NOT NULL DEFAULT '[]',
  initiator_id INT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS automation_runs_rule ON automation_runs(rule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS automation_runs_issue ON automation_runs(issue_id, created_at DESC);

-- ---------------------------------------------------------------- Phase 4: email + scheduler

-- email_pref: immediate (batched each minute) | digest (daily) | off
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_pref TEXT NOT NULL DEFAULT 'immediate';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_digest_at TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS emailed_at TIMESTAMPTZ;

-- Outbox: every email is a row; the scheduler delivers queued rows (SMTP) or keeps them (dev outbox)
CREATE TABLE IF NOT EXISTS emails (
  id           SERIAL PRIMARY KEY,
  tenant_id    INT NOT NULL REFERENCES tenants(id),
  to_user_id   INT REFERENCES users(id) ON DELETE SET NULL,
  to_email     TEXT NOT NULL,
  kind         TEXT NOT NULL,
  subject      TEXT NOT NULL,
  text_body    TEXT NOT NULL,
  html_body    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','outbox','failed')),
  attempts     INT NOT NULL DEFAULT 0,
  error        TEXT,
  next_try_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS emails_queue ON emails(status, next_try_at);

-- Filter subscriptions: email a filter's results on a schedule (run with the subscriber's permissions)
CREATE TABLE IF NOT EXISTS filter_subscriptions (
  id               SERIAL PRIMARY KEY,
  filter_id        INT NOT NULL REFERENCES filters(id) ON DELETE CASCADE,
  user_id          INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  frequency        TEXT NOT NULL CHECK (frequency IN ('daily','weekly')),
  hour_utc         INT NOT NULL DEFAULT 8 CHECK (hour_utc BETWEEN 0 AND 23),
  weekday          INT CHECK (weekday BETWEEN 0 AND 6),
  email_when_empty BOOLEAN NOT NULL DEFAULT false,
  next_run_at      TIMESTAMPTZ NOT NULL,
  last_run_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (filter_id, user_id)
);

-- Scheduled automation rules ({"type":"scheduled","every":"hour|day|week"}) remember when they run next
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS recent_views (
  user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL,
  entity_id    INT NOT NULL,
  viewed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entity_type, entity_id)
);

-- ---------------------------------------------------------------- Phase 4: single sign-on (OIDC)
CREATE TABLE IF NOT EXISTS user_identities (
  issuer      TEXT NOT NULL,
  subject     TEXT NOT NULL,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject)
);
CREATE TABLE IF NOT EXISTS oidc_logins (
  state       TEXT PRIMARY KEY,
  nonce       TEXT NOT NULL,
  verifier    TEXT NOT NULL,
  next        TEXT NOT NULL DEFAULT '/',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sso_handoffs (
  code_hash   TEXT PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  next        TEXT NOT NULL DEFAULT '/',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- Phase 5: API tokens, webhooks, audit log
CREATE TABLE IF NOT EXISTS api_tokens (
  id            SERIAL PRIMARY KEY,
  user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  prefix        TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS webhooks (
  id          SERIAL PRIMARY KEY,
  tenant_id   INT NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  events      TEXT[] NOT NULL,
  project_id  INT REFERENCES projects(id) ON DELETE CASCADE,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  secret      TEXT NOT NULL,
  created_by  INT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              SERIAL PRIMARY KEY,
  webhook_id      INT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event           TEXT NOT NULL,
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','success','failed')),
  attempts        INT NOT NULL DEFAULT 0,
  next_try_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at      TIMESTAMPTZ,
  response_status INT,
  response_text   TEXT,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries (status, next_try_at);
CREATE TABLE IF NOT EXISTS audit_log (
  id          SERIAL PRIMARY KEY,
  tenant_id   INT NOT NULL REFERENCES tenants(id),
  actor_id    INT REFERENCES users(id) ON DELETE SET NULL,
  actor_name  TEXT,
  category    TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_tenant ON audit_log (tenant_id, id DESC);

-- ---------------------------------------------------------------- Phase 5: releases (versions) + components
CREATE TABLE IF NOT EXISTS versions (
  id            SERIAL PRIMARY KEY,
  project_id    INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  start_date    DATE,
  release_date  DATE,
  released      BOOLEAN NOT NULL DEFAULT false,
  released_at   TIMESTAMPTZ,
  archived      BOOLEAN NOT NULL DEFAULT false,
  position      INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS versions_name ON versions (project_id, lower(name));
CREATE TABLE IF NOT EXISTS issue_versions (
  issue_id    INT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  version_id  INT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, version_id)
);
CREATE INDEX IF NOT EXISTS issue_versions_version ON issue_versions (version_id);
CREATE TABLE IF NOT EXISTS components (
  id           SERIAL PRIMARY KEY,
  project_id   INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  lead_id      INT REFERENCES users(id) ON DELETE SET NULL,
  position     INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS components_name ON components (project_id, lower(name));
CREATE TABLE IF NOT EXISTS issue_components (
  issue_id      INT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  component_id  INT NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, component_id)
);
CREATE INDEX IF NOT EXISTS issue_components_component ON issue_components (component_id);
