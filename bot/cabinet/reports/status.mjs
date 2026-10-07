import { resolveReportConfig } from '../batches.mjs';

export function readReportOperatorState(db, service) {
  const reportConfig = resolveReportConfig(service);
  const pending = db
    .prepare(
      `SELECT COUNT(*) AS count FROM notification_outbox
       WHERE status IN ('pending', 'retry_wait', 'failed', 'uncertain')`,
    )
    .get().count;
  const lastSent = db
    .prepare(
      `SELECT sent_at, headline FROM reports
       WHERE delivery_status = 'sent'
       ORDER BY sent_at DESC LIMIT 1`,
    )
    .get();
  const failed = db
    .prepare(`SELECT COUNT(*) AS count FROM notification_outbox WHERE status = 'failed'`)
    .get().count;
  return {
    mode: reportConfig.mode,
    pending,
    failed,
    lastSentAt: lastSent?.sent_at || null,
    lastHeadline: lastSent?.headline || null,
  };
}
