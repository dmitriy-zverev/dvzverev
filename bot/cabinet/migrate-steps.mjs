export function applyMigrationV3(db) {
  ensureColumn(db, 'batches', 'before_locked_at', 'TEXT');
  ensureColumn(db, 'batches', 'baseline_editions', 'INTEGER');
  ensureColumn(db, 'batches', 'baseline_deliveries', 'INTEGER');
  ensureColumn(db, 'batches', 'members_added', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'batches', 'members_removed', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'batches', 'lifecycle', "TEXT NOT NULL DEFAULT 'scheduled'");
  db.exec(`
CREATE TABLE IF NOT EXISTS reports (
  report_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  local_date TEXT NOT NULL,
  period TEXT NOT NULL,
  report_kind TEXT NOT NULL,
  revision INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  headline TEXT NOT NULL,
  body_html TEXT NOT NULL,
  body_plain TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  sent_at TEXT,
  FOREIGN KEY (batch_id) REFERENCES batches(batch_id)
);
CREATE INDEX IF NOT EXISTS reports_batch ON reports(batch_id, report_kind, revision);
CREATE TABLE IF NOT EXISTS notification_outbox (
  outbox_id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'telegram',
  destination TEXT NOT NULL,
  body_html TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (report_id) REFERENCES reports(report_id)
);
CREATE INDEX IF NOT EXISTS notification_outbox_status ON notification_outbox(status, retry_at);
`);
}

export function applyMigrationV4(db) {
  ensureColumn(db, 'editions', 'content_expires_at', 'TEXT');
  ensureColumn(db, 'editions', 'media_planned', 'TEXT');
  ensureColumn(db, 'editions', 'media_actual', 'TEXT');
  ensureColumn(db, 'editions', 'prompt_hashes_json', 'TEXT');
  ensureColumn(db, 'editions', 'experiment_variant', 'TEXT');
  ensureColumn(db, 'editions', 'is_external', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`
CREATE TABLE IF NOT EXISTS delivery_tombstones (
  tombstone_id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  edition_id TEXT,
  project_id TEXT NOT NULL,
  destination_id TEXT,
  platform TEXT,
  external_id TEXT,
  vk_group_id TEXT,
  slot_key TEXT,
  outcome TEXT NOT NULL,
  payload_hash TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS delivery_tombstones_expires ON delivery_tombstones(expires_at);

CREATE TABLE IF NOT EXISTS generation_runs (
  run_id TEXT PRIMARY KEY,
  edition_id TEXT,
  project_id TEXT NOT NULL,
  role TEXT NOT NULL,
  model TEXT,
  prompt_version_id TEXT,
  cost_usd REAL,
  latency_ms INTEGER,
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS generation_runs_edition ON generation_runs(edition_id, created_at);

CREATE TABLE IF NOT EXISTS prompt_versions (
  version_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  role TEXT NOT NULL,
  version_label TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_text TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'draft',
  activated_at TEXT,
  deactivated_at TEXT,
  parent_version_id TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'owner',
  UNIQUE (project_id, role, version_label)
);
CREATE INDEX IF NOT EXISTS prompt_versions_active ON prompt_versions(project_id, role, status);

CREATE TABLE IF NOT EXISTS post_features (
  edition_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  format TEXT,
  topic TEXT,
  language TEXT,
  body_length INTEGER,
  media_planned TEXT,
  media_actual TEXT,
  slot_local_time TEXT,
  slot_weekday INTEGER,
  model_text TEXT,
  model_review TEXT,
  model_media TEXT,
  prompt_version_id TEXT,
  prompt_hashes_json TEXT,
  experiment_id TEXT,
  experiment_variant TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS post_features_project ON post_features(project_id, published_at);

CREATE TABLE IF NOT EXISTS metric_imports (
  import_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  vk_group_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'preview',
  report_week TEXT,
  observed_at TEXT NOT NULL,
  period_from TEXT,
  period_to TEXT,
  metric_mode TEXT NOT NULL DEFAULT 'cumulative',
  filename TEXT,
  raw_bytes INTEGER,
  row_count INTEGER NOT NULL DEFAULT 0,
  valid_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  matched_count INTEGER NOT NULL DEFAULT 0,
  unknown_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  coverage_json TEXT,
  preview_json TEXT,
  commit_options_json TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  committed_at TEXT,
  reverted_at TEXT,
  content_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, source_hash)
);
CREATE INDEX IF NOT EXISTS metric_imports_project ON metric_imports(project_id, created_at);

CREATE TABLE IF NOT EXISTS metric_import_rows (
  row_id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  vk_group_id TEXT,
  vk_post_id TEXT,
  edition_id TEXT,
  delivery_id TEXT,
  match_kind TEXT,
  error_code TEXT,
  error_message TEXT,
  payload_json TEXT NOT NULL,
  excluded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (import_id) REFERENCES metric_imports(import_id)
);
CREATE INDEX IF NOT EXISTS metric_import_rows_import ON metric_import_rows(import_id, row_index);

CREATE TABLE IF NOT EXISTS metric_observations (
  observation_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  edition_id TEXT,
  delivery_id TEXT,
  vk_group_id TEXT NOT NULL,
  vk_post_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_hash TEXT,
  import_id TEXT,
  import_revision INTEGER,
  observed_at TEXT NOT NULL,
  period_from TEXT,
  period_to TEXT,
  metric_mode TEXT NOT NULL,
  published_at TEXT,
  views INTEGER,
  reach_total INTEGER,
  reach_organic INTEGER,
  reach_paid INTEGER,
  likes INTEGER,
  comments INTEGER,
  reposts INTEGER,
  saves INTEGER,
  clicks INTEGER,
  link_clicks INTEGER,
  subscribers_at_publish INTEGER,
  ad_spend REAL,
  promoted INTEGER,
  schema_version TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  replaced_by TEXT,
  anomaly_flags_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, vk_post_id, source, observed_at, metric_mode, period_from, period_to, revision)
);
CREATE INDEX IF NOT EXISTS metric_observations_active
  ON metric_observations(project_id, is_active, observed_at);
CREATE INDEX IF NOT EXISTS metric_observations_post
  ON metric_observations(vk_group_id, vk_post_id, is_active);

CREATE TABLE IF NOT EXISTS monthly_aggregates (
  aggregate_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  period_ym TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  segment_key TEXT NOT NULL DEFAULT 'all',
  value_json TEXT NOT NULL,
  coverage_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, period_ym, metric_key, segment_key)
);

CREATE TABLE IF NOT EXISTS experiments (
  experiment_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  factor TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  target_posts_per_variant INTEGER NOT NULL DEFAULT 20,
  start_at TEXT,
  end_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS experiment_assignments (
  assignment_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  plan_id TEXT,
  edition_id TEXT,
  variant TEXT NOT NULL,
  prompt_version_id TEXT,
  assigned_at TEXT NOT NULL,
  FOREIGN KEY (experiment_id) REFERENCES experiments(experiment_id)
);

CREATE TABLE IF NOT EXISTS analysis_jobs (
  job_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  dataset_hash TEXT NOT NULL,
  budget_usd REAL,
  cost_usd REAL,
  error_message TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (project_id, dataset_hash, status)
);

CREATE TABLE IF NOT EXISTS recommendations (
  recommendation_id TEXT PRIMARY KEY,
  job_id TEXT,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  observation TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  alternatives_json TEXT,
  prompt_role TEXT,
  prompt_diff_json TEXT,
  hypothesis TEXT,
  constraints_json TEXT,
  experiment_plan_json TEXT,
  decision_note TEXT,
  decided_at TEXT,
  decided_by TEXT,
  applied_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS recommendations_project ON recommendations(project_id, status, created_at);
`);
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
