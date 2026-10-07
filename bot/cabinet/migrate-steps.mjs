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

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
