import { randomUUID } from 'node:crypto';
import { redact } from '../../logging.mjs';

export function reportIdempotencyKey(localDate, period, reportKind, revision) {
  return `${localDate}:${period}:${reportKind}:${revision}`;
}

export function findReportByKey(db, idempotencyKey) {
  return db.prepare('SELECT * FROM reports WHERE idempotency_key = ?').get(idempotencyKey);
}

export function insertReport(db, payload, now) {
  const timestamp = now.toISOString();
  db.prepare(
    `INSERT INTO reports (
      report_id, batch_id, local_date, period, report_kind, revision, idempotency_key,
      headline, body_html, body_plain, snapshot_json, delivery_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
  ).run(
    payload.reportId,
    payload.batchId,
    payload.localDate,
    payload.period,
    payload.reportKind,
    payload.revision,
    payload.idempotencyKey,
    payload.headline,
    payload.bodyHtml,
    payload.bodyPlain,
    JSON.stringify(payload.snapshot),
    timestamp,
  );
  return payload.reportId;
}

export function markReportSent(db, reportId, now) {
  db.prepare(
    `UPDATE reports SET delivery_status = 'sent', sent_at = ? WHERE report_id = ?`,
  ).run(now.toISOString(), reportId);
}

export function markReportSkipped(db, reportId, now, reason) {
  db.prepare(
    `UPDATE reports SET delivery_status = ?, sent_at = ? WHERE report_id = ?`,
  ).run(`skipped:${reason}`, now.toISOString(), reportId);
}

export function enqueueOutbox(db, { reportId, destination, bodyHtml }, now) {
  const outboxId = randomUUID();
  const timestamp = now.toISOString();
  db.prepare(
    `INSERT INTO notification_outbox (
      outbox_id, report_id, channel, destination, body_html, status, created_at, updated_at
    ) VALUES (?, ?, 'telegram', ?, ?, 'pending', ?, ?)`,
  ).run(outboxId, reportId, destination, bodyHtml, timestamp, timestamp);
  return outboxId;
}

export function listBatchReports(db, localDate, period) {
  return db
    .prepare(
      `SELECT report_id, report_kind, revision, headline, delivery_status, created_at, sent_at
       FROM reports WHERE local_date = ? AND period = ?
       ORDER BY created_at ASC`,
    )
    .all(localDate, period)
    .map((row) => ({
      id: row.report_id,
      kind: row.report_kind,
      revision: row.revision,
      headline: row.headline,
      status: row.delivery_status,
      createdAt: row.created_at,
      sentAt: row.sent_at,
    }));
}

export function listPendingOutbox(db, now, limit = 8) {
  const timestamp = now.toISOString();
  return db
    .prepare(
      `SELECT o.*, r.headline
       FROM notification_outbox o
       JOIN reports r ON r.report_id = o.report_id
       WHERE o.status IN ('pending', 'retry_wait')
         AND (o.retry_at IS NULL OR o.retry_at <= ?)
       ORDER BY o.created_at ASC
       LIMIT ?`,
    )
    .all(timestamp, limit);
}

export function logReportDeliveryEvent(db, reportId, code, message, now) {
  const text = redact(message).slice(0, 500);
  db.prepare(
    `INSERT INTO events (
      event_id, project_id, edition_id, delivery_id, stage, code, message, created_at
    ) VALUES (?, NULL, NULL, NULL, 'report', ?, ?, ?)`,
  ).run(
    randomUUID(),
    code,
    reportId ? `${text} (report=${reportId})` : text,
    now.toISOString(),
  );
}
