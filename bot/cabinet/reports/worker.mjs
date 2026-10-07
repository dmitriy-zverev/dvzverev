import { randomUUID } from 'node:crypto';
import { resolveReportConfig } from '../batches.mjs';
import { getMeta, setMeta, withTransaction } from '../db.mjs';
import { addDaysYmd, zonedParts, formatDateYmd } from '../time.mjs';
import { processNotificationOutbox, resolveReportChatId } from './outbox.mjs';
import { formatReportTelegramHtml, renderReport } from './render.mjs';
import { readBatchReportSnapshot } from './snapshot.mjs';
import { enqueueOutbox, findReportByKey, insertReport, logReportDeliveryEvent, reportIdempotencyKey } from './store.mjs';
export async function runReportWorker(db, service, env, now = new Date()) {
  const reportConfig = resolveReportConfig(service);
  if (reportConfig.mode === 'off') return { mode: 'off', processed: 0 };
  const deliveryReady = reportDeliveryReady(reportConfig, env);
  const outbox = deliveryReady
    ? await processNotificationOutbox(db, service, reportConfig, env, now)
    : { processed: 0 };
  if (!deliveryReady) {
    logReportDeliveryEvent(
      db,
      null,
      'report_config_invalid',
      `Missing Telegram chat for mode ${reportConfig.mode}`,
      now,
    );
    return { skipped: 'missing_chat', ...outbox };
  }
  const queued = withTransaction(db, () => {
    maybeEmitRecoveryReports(db, service, reportConfig, env, now);
    return evaluateScheduledReports(db, service, reportConfig, env, now);
  });
  return { ...outbox, queued };
}

function reportDeliveryReady(reportConfig, env) {
  if (reportConfig.mode === 'shadow') return true;
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  try {
    resolveReportChatId(null, reportConfig, env);
    return true;
  } catch {
    return false;
  }
}

function evaluateScheduledReports(db, service, reportConfig, env, now) {
  const timeZone = reportConfig.timezone;
  const todayParts = zonedParts(now, timeZone);
  const todayYmd = formatDateYmd({
    year: Number(todayParts.year),
    month: Number(todayParts.month),
    day: Number(todayParts.day),
  });
  const fromDate = addDaysYmd(todayYmd, -7, timeZone);
  const toDate = addDaysYmd(todayYmd, 14, timeZone);
  const rows = db
    .prepare(
      `SELECT * FROM batches
       WHERE local_date >= ? AND local_date <= ? AND lifecycle != 'closed'
       ORDER BY local_date ASC, period ASC`,
    )
    .all(fromDate, toDate);
  let queued = 0;
  for (const row of rows) {
    // Initial rollout must not send a week of retrospective before/after reports.
    if (row.local_date < todayYmd && !row.before_locked_at) {
      closeBatch(db, row.batch_id, now);
      continue;
    }
    queued += evaluateBatchRow(db, row, service, reportConfig, env, now);
  }
  return queued;
}

function evaluateBatchRow(db, batchRow, service, reportConfig, env, now) {
  const snapshot = readBatchReportSnapshot(
    db,
    batchRow.local_date,
    batchRow.period,
    reportConfig.timezone,
  );
  if (!snapshot) return 0;
  const batch = snapshot.batch;
  let queued = 0;
  queued += maybeSkipStaleBefore(db, batch, now);
  queued += maybeQueueBefore(db, service, batch, snapshot, reportConfig, env, now);
  queued += maybeQueueDeadline(db, service, batch, snapshot, reportConfig, env, now);
  queued += maybeQueueLateFinal(db, service, batch, snapshot, reportConfig, env, now);
  queued += maybeQueueAfter(db, service, batch, snapshot, reportConfig, env, now);
  if (snapshot.progress.allTerminal && snapshot.progress.total > 0) {
    closeBatch(db, batch.id, now);
  }
  return queued;
}

function maybeSkipStaleBefore(db, batch, now) {
  if (batch.beforeLockedAt || !batch.firstSlotUtc) return 0;
  if (Date.parse(batch.beforeAtUtc) > now.getTime()) return 0;
  if (now.getTime() <= Date.parse(batch.firstSlotUtc)) return 0;
  const key = reportIdempotencyKey(batch.localDate, batch.period, 'before', batch.revision);
  if (findReportByKey(db, key)) return 0;
  db.prepare(
    `INSERT INTO reports (
      report_id, batch_id, local_date, period, report_kind, revision, idempotency_key,
      headline, body_html, body_plain, snapshot_json, delivery_status, created_at, sent_at
    ) VALUES (?, ?, ?, ?, 'before', ?, ?, 'stale', '', '', '{}', 'skipped:stale_before', ?, ?)`,
  ).run(
    randomUUID(),
    batch.id,
    batch.localDate,
    batch.period,
    batch.revision,
    key,
    now.toISOString(),
    now.toISOString(),
  );
  db.prepare(
    `UPDATE batches SET before_locked_at = ?, lifecycle = 'active', updated_at = ?
     WHERE batch_id = ? AND before_locked_at IS NULL`,
  ).run(now.toISOString(), now.toISOString(), batch.id);
  return 0;
}

function maybeQueueBefore(db, service, batch, snapshot, reportConfig, env, now) {
  if (Date.parse(batch.beforeAtUtc) > now.getTime()) return 0;
  if (!snapshot.members.length && !reportConfig.reportEmptyBatches) return 0;
  if (batch.firstSlotUtc && now.getTime() > Date.parse(batch.firstSlotUtc) && !batch.beforeLockedAt) {
    return 0;
  }
  const key = reportIdempotencyKey(batch.localDate, batch.period, 'before', batch.revision);
  if (findReportByKey(db, key)) return 0;
  if (!queueReport(db, service, batch, snapshot, 'before', reportConfig, env, now, key)) return 0;
  if (!snapshot.members.length) {
    closeBatch(db, batch.id, now);
    return 1;
  }
  db.prepare(
    `UPDATE batches SET
      before_locked_at = COALESCE(before_locked_at, ?),
      baseline_editions = COALESCE(baseline_editions, expected_editions),
      baseline_deliveries = COALESCE(baseline_deliveries, expected_deliveries),
      lifecycle = 'active',
      updated_at = ?
     WHERE batch_id = ?`,
  ).run(now.toISOString(), now.toISOString(), batch.id);
  return 1;
}

function maybeQueueAfter(db, service, batch, snapshot, reportConfig, env, now) {
  if (!batch.beforeLockedAt) return 0;
  if (!snapshot.progress.allTerminal) return 0;
  if (!snapshot.members.length) return 0;
  const key = reportIdempotencyKey(batch.localDate, batch.period, 'after', batch.revision);
  if (findReportByKey(db, key)) return 0;
  if (hasReportKind(db, batch.id, 'late_final', batch.revision)) return 0;
  if (batch.deadlineAtUtc && now.getTime() >= Date.parse(batch.deadlineAtUtc)) {
    if (hasReportKind(db, batch.id, 'deadline', batch.revision)) return 0;
  }
  return queueReport(db, service, batch, snapshot, 'after', reportConfig, env, now, key) ? 1 : 0;
}

function maybeQueueDeadline(db, service, batch, snapshot, reportConfig, env, now) {
  if (!batch.beforeLockedAt || !batch.deadlineAtUtc) return 0;
  if (snapshot.progress.allTerminal) return 0;
  if (Date.parse(batch.deadlineAtUtc) > now.getTime()) return 0;
  const key = reportIdempotencyKey(batch.localDate, batch.period, 'deadline', batch.revision);
  if (findReportByKey(db, key)) return 0;
  return queueReport(db, service, batch, snapshot, 'deadline', reportConfig, env, now, key) ? 1 : 0;
}

function maybeQueueLateFinal(db, service, batch, snapshot, reportConfig, env, now) {
  if (!hasReportKind(db, batch.id, 'deadline', batch.revision)) return 0;
  if (!snapshot.progress.allTerminal) return 0;
  const key = reportIdempotencyKey(batch.localDate, batch.period, 'late_final', batch.revision);
  if (findReportByKey(db, key)) return 0;
  return queueReport(db, service, batch, snapshot, 'late_final', reportConfig, env, now, key) ? 1 : 0;
}

function hasReportKind(db, batchId, kind, revision) {
  return Boolean(
    db
      .prepare(
        `SELECT 1 AS ok FROM reports
         WHERE batch_id = ? AND report_kind = ? AND revision = ?
           AND delivery_status NOT LIKE 'skipped%'`,
      )
      .get(batchId, kind, revision),
  );
}

function queueReport(db, service, batch, snapshot, reportKind, reportConfig, env, now, idempotencyKey) {
  if (findReportByKey(db, idempotencyKey)) return false;
  const rendered = renderReport({ reportKind, snapshot, reportConfig, now });
  const reportId = randomUUID();
  insertReport(
    db,
    {
      reportId,
      batchId: batch.id,
      localDate: batch.localDate,
      period: batch.period,
      reportKind,
      revision: batch.revision,
      idempotencyKey,
      headline: rendered.headline,
      bodyHtml: formatReportTelegramHtml(rendered.headline, rendered.bodyHtml),
      bodyPlain: `${rendered.headline}\n${rendered.bodyPlain}`,
      snapshot: {
        asOf: snapshot.asOf,
        dataVersion: snapshot.dataVersion,
        deliverySummary: rendered.deliverySummary,
        progress: snapshot.progress,
      },
    },
    now,
  );
  const destination = resolveReportChatId(service, reportConfig, env) || 'shadow';
  enqueueOutbox(
    db,
    { reportId, destination, bodyHtml: formatReportTelegramHtml(rendered.headline, rendered.bodyHtml) },
    now,
  );
  return true;
}

function closeBatch(db, batchId, now) {
  db.prepare(`UPDATE batches SET lifecycle = 'closed', status = 'closed', updated_at = ? WHERE batch_id = ?`).run(
    now.toISOString(),
    batchId,
  );
}

function maybeEmitRecoveryReports(db, service, reportConfig, env, now) {
  const bootId = env.HOSTNAME || env.BOT_INSTANCE_ID || 'local';
  if (getMeta(db, 'report_worker_boot_id') === bootId) return 0;
  setMeta(db, 'report_worker_boot_id', bootId);
  const rows = db
    .prepare(`SELECT * FROM batches WHERE lifecycle = 'active' AND before_locked_at IS NOT NULL`)
    .all();
  let queued = 0;
  for (const row of rows) {
    const snapshot = readBatchReportSnapshot(
      db,
      row.local_date,
      row.period,
      reportConfig.timezone,
    );
    if (!snapshot || snapshot.progress.allTerminal) continue;
    const key = `${row.local_date}:${row.period}:recovery:${row.revision}:${bootId}`;
    if (findReportByKey(db, key)) continue;
    const batch = snapshot.batch;
    if (queueReport(db, service, batch, snapshot, 'recovery', reportConfig, env, now, key)) {
      queued += 1;
    }
  }
  return queued;
}
