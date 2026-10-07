export const SCHEMA_VERSION = 3;

export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS cabinet_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  timezone TEXT NOT NULL,
  format TEXT NOT NULL,
  config_version TEXT NOT NULL,
  schedule_json TEXT NOT NULL,
  destinations_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schedule_slots (
  plan_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  slot_utc TEXT NOT NULL,
  slot_key TEXT NOT NULL,
  publication_kind TEXT NOT NULL,
  expected_media TEXT,
  brief TEXT,
  topic TEXT,
  topic_state TEXT NOT NULL DEFAULT 'unknown',
  plan_status TEXT NOT NULL DEFAULT 'planned',
  config_version TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  edition_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, destination_id, slot_utc)
);

CREATE INDEX IF NOT EXISTS schedule_slots_week ON schedule_slots(slot_utc);
CREATE INDEX IF NOT EXISTS schedule_slots_project ON schedule_slots(project_id, slot_utc);

CREATE TABLE IF NOT EXISTS editions (
  edition_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  slot_key TEXT,
  plan_id TEXT,
  format TEXT NOT NULL,
  topic TEXT,
  brief TEXT,
  body_text TEXT,
  body_removed_at TEXT,
  prompt_version TEXT,
  models_json TEXT,
  cost_usd REAL,
  aggregate_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS editions_project ON editions(project_id, created_at);

CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id TEXT PRIMARY KEY,
  edition_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  status TEXT NOT NULL,
  post_id TEXT,
  external_id TEXT,
  vk_group_id TEXT,
  retry_at TEXT,
  failure_reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (edition_id) REFERENCES editions(edition_id)
);

CREATE INDEX IF NOT EXISTS deliveries_edition ON deliveries(edition_id);
CREATE INDEX IF NOT EXISTS deliveries_status ON deliveries(project_id, status);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  project_id TEXT,
  edition_id TEXT,
  delivery_id TEXT,
  stage TEXT NOT NULL,
  code TEXT,
  message TEXT NOT NULL,
  attempt INTEGER,
  recovery TEXT,
  retry_at TEXT,
  created_at TEXT NOT NULL,
  incident_id TEXT
);

CREATE INDEX IF NOT EXISTS events_edition ON events(edition_id, created_at);

CREATE TABLE IF NOT EXISTS incidents (
  incident_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  stage TEXT NOT NULL,
  code TEXT,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  count INTEGER NOT NULL DEFAULT 1,
  edition_id TEXT,
  destination_id TEXT,
  recovery TEXT,
  next_retry_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS incidents_open ON incidents(status, last_seen_at);

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  plan_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
`;

export const MIGRATION_V2_SQL = `
CREATE TABLE IF NOT EXISTS batches (
  batch_id TEXT PRIMARY KEY,
  local_date TEXT NOT NULL,
  period TEXT NOT NULL,
  timezone TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  first_slot_utc TEXT,
  last_slot_utc TEXT,
  before_at_utc TEXT NOT NULL,
  deadline_at_utc TEXT,
  expected_editions INTEGER NOT NULL DEFAULT 0,
  expected_deliveries INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (local_date, period)
);

CREATE TABLE IF NOT EXISTS batch_members (
  member_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  slot_utc TEXT NOT NULL,
  edition_id TEXT,
  delivery_id TEXT,
  added_revision INTEGER NOT NULL DEFAULT 1,
  removed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES batches(batch_id),
  FOREIGN KEY (plan_id) REFERENCES schedule_slots(plan_id)
);

CREATE INDEX IF NOT EXISTS batch_members_batch ON batch_members(batch_id, slot_utc);
`;

