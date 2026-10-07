import { sendNotification } from '../../notifications.mjs';
import { logError, redact } from '../../logging.mjs';
import { TelegramRejection, publicationBackoffSeconds, sendTelegram } from '../../core.mjs';
import {
  listPendingOutbox,
  logReportDeliveryEvent,
  markReportSent,
} from './store.mjs';

export function resolveReportChatId(service, reportConfig, env) {
  if (reportConfig.mode === 'shadow') return 'shadow';
  if (reportConfig.mode === 'test') {
    const chatId = env[reportConfig.testChatIdEnv];
    if (!chatId) throw new Error(`Missing ${reportConfig.testChatIdEnv} for report test mode`);
    return chatId;
  }
  if (reportConfig.mode === 'owner') {
    const chatId = env[reportConfig.alertChatIdEnv];
    if (!chatId) throw new Error(`Missing ${reportConfig.alertChatIdEnv} for report owner mode`);
    return chatId;
  }
  return null;
}

export function telegramNotifyConfig(env, chatId) {
  const logDir = env.BOT_LOG_DIR || 'bot/data';
  return {
    token: env.TELEGRAM_BOT_TOKEN || '',
    alertChatId: chatId,
    chatId,
    statePath: `${logDir}/report-notify-state.json`,
    logDir,
  };
}

export async function processNotificationOutbox(db, service, reportConfig, env, now = new Date(), { notify = sendTelegram } = {}) {
  if (reportConfig.mode === 'off') return { processed: 0 };
  let destination;
  try {
    destination = resolveReportChatId(service, reportConfig, env);
  } catch {
    return { processed: 0, skipped: 'missing_chat' };
  }
  if (!destination) return { processed: 0 };
  // A crashed or timed-out send cannot safely be retried: Telegram may have accepted it.
  const stale = db.prepare(`SELECT outbox_id, report_id FROM notification_outbox
    WHERE status = 'sending' AND updated_at < ?`).all(new Date(now.getTime() - 120_000).toISOString());
  for (const row of stale) {
    await logError(telegramNotifyConfig(env, destination), {platform: 'telegram-report', reason: 'telegram_delivery_uncertain', postId: row.report_id});
    db.prepare(`UPDATE notification_outbox SET status = 'uncertain', updated_at = ? WHERE outbox_id = ? AND status = 'sending'`).run(now.toISOString(), row.outbox_id);
    db.prepare(`UPDATE reports SET delivery_status = 'uncertain' WHERE report_id = ?`).run(row.report_id);
    logReportDeliveryEvent(db, row.report_id, 'telegram_delivery_uncertain', 'Unconfirmed report delivery; inspect Telegram before retrying', now);
  }
  const pending = listPendingOutbox(db, now);
  let processed = 0;
  for (const row of pending) {
    const result = await deliverOutboxRow(db, row, destination, reportConfig, env, now, notify);
    if (result) processed += 1;
  }
  return { processed };
}

async function deliverOutboxRow(db, row, destination, reportConfig, env, now, notify) {
  const timestamp = now.toISOString();
  if (reportConfig.mode === 'shadow') {
    db.prepare(
      `UPDATE notification_outbox SET status = 'sent', updated_at = ?, destination = 'shadow'
       WHERE outbox_id = ?`,
    ).run(timestamp, row.outbox_id);
    markReportSent(db, row.report_id, now);
    logReportDeliveryEvent(db, row.report_id, 'shadow_delivered', row.headline, now);
    return true;
  }
  if (row.destination === 'shadow') {
    db.prepare(`UPDATE notification_outbox SET status = 'skipped', updated_at = ? WHERE outbox_id = ?`).run(timestamp, row.outbox_id);
    db.prepare(`UPDATE reports SET delivery_status = 'skipped:shadow' WHERE report_id = ?`).run(row.report_id);
    return false;
  }
  const claim = db.prepare(
    `UPDATE notification_outbox SET status = 'sending', attempts = attempts + 1, updated_at = ?
     WHERE outbox_id = ? AND status IN ('pending', 'retry_wait')`,
  ).run(timestamp, row.outbox_id);
  if (!claim.changes) return false;
  const config = telegramNotifyConfig(env, destination);
  const message = row.body_html;
  try {
    const notifyResult = await sendNotification(config, notify, message, (error) =>
      publicationBackoffSeconds(error, row.attempts + 1),
    );
    if (notifyResult.deferredUntil) {
      db.prepare(
        `UPDATE notification_outbox SET status = 'retry_wait', retry_at = ?, updated_at = ?
         WHERE outbox_id = ?`,
      ).run(new Date(notifyResult.deferredUntil).toISOString(), timestamp, row.outbox_id);
      return false;
    }
    db.prepare(
      `UPDATE notification_outbox SET status = 'sent', updated_at = ?, destination = ?
       WHERE outbox_id = ?`,
    ).run(timestamp, destination, row.outbox_id);
    markReportSent(db, row.report_id, now);
    return true;
  } catch (error) {
    await logError(config, {platform: 'telegram-report', reason: 'telegram_delivery_failed', postId: row.report_id}, error);
    const status =
      error instanceof TelegramRejection ? (error.kind === 'temporary' ? 'retry_wait' : 'failed') : 'uncertain';
    const retryAt =
      status === 'retry_wait'
        ? new Date(
            Date.now() + publicationBackoffSeconds(error, row.attempts + 1) * 1000,
          ).toISOString()
        : null;
    db.prepare(
      `UPDATE notification_outbox SET status = ?, retry_at = ?, last_error = ?, updated_at = ?
       WHERE outbox_id = ?`,
    ).run(status, retryAt, redact(error.message || error).slice(0, 300), timestamp, row.outbox_id);
    db.prepare(`UPDATE reports SET delivery_status = ? WHERE report_id = ?`).run(status, row.report_id);
    logReportDeliveryEvent(
      db,
      row.report_id,
      'telegram_delivery_failed',
      String(error.message || error),
      now,
    );
    return false;
  }
}
