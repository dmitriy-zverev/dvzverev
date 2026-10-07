import { createHash } from 'node:crypto';
import { getMeta, setMeta } from '../db.mjs';
import { sendTelegram } from '../../core.mjs';
import { getPlanRevision } from './apply.mjs';

const DEDUPE_TTL_MS = 6 * 60 * 60 * 1000;

export async function notifyEditorialProposal(
  db,
  {
    jobId,
    revisionId,
    projectId,
    env = process.env,
    notify = sendTelegram,
    cabinetUrl = null,
    now = new Date(),
  } = {},
) {
  const chatId = env.BOT_ALERT_CHAT_ID;
  if (!chatId || !env.TELEGRAM_BOT_TOKEN) {
    return { skipped: 'missing_telegram' };
  }

  const fingerprint = createHash('sha256')
    .update(`editorial:${projectId}:${revisionId}`)
    .digest('hex')
    .slice(0, 24);
  const dedupeKey = `editorial_notify:${fingerprint}`;
  const last = getMeta(db, dedupeKey);
  if (last && Date.parse(last) > now.getTime() - DEDUPE_TTL_MS) {
    return { skipped: 'deduped' };
  }

  const revision = getPlanRevision(db, revisionId);
  if (!revision) return { skipped: 'revision_missing' };

  const baseUrl = cabinetUrl || env.BOT_CABINET_PUBLIC_URL || 'https://dvzverev.ru/bot/';
  const link = `${baseUrl}?tab=editorial&project=${encodeURIComponent(projectId)}&revision=${encodeURIComponent(revisionId)}`;
  const slots = revision.proposal?.calendar?.length || 0;
  const stale = revision.proposal?.metricsStale ? ' (метрики устарели)' : '';
  const html = [
    `<b>Редакция</b>: предложение на неделю ${revision.weekStart}`,
    `Проект: <code>${escapeHtml(projectId)}</code>${stale}`,
    `Слотов в календаре: ${slots}. Job: <code>${escapeHtml(jobId || '')}</code>`,
    `<a href="${escapeHtml(link)}">Открыть в кабинете</a>`,
  ].join('\n');

  const config = {
    token: env.TELEGRAM_BOT_TOKEN,
    chatId,
    alertChatId: chatId,
  };
  try {
    await notify(config, html);
    setMeta(db, dedupeKey, now.toISOString());
    if (jobId) {
      db.prepare(`UPDATE editorial_weekly_jobs SET notify_status = 'sent' WHERE job_id = ?`).run(
        jobId,
      );
    }
    return { sent: true };
  } catch (error) {
    if (jobId) {
      db.prepare(`UPDATE editorial_weekly_jobs SET notify_status = 'failed' WHERE job_id = ?`).run(
        jobId,
      );
    }
    return { error: String(error.message || error) };
  }
}

export async function notifyEditorialFailure(
  db,
  { projectId, jobId, message, env = process.env, notify = sendTelegram, now = new Date() } = {},
) {
  const chatId = env.BOT_ALERT_CHAT_ID;
  if (!chatId || !env.TELEGRAM_BOT_TOKEN) return { skipped: 'missing_telegram' };

  const fingerprint = createHash('sha256')
    .update(`editorial-fail:${projectId}:${message}`)
    .digest('hex')
    .slice(0, 24);
  const dedupeKey = `editorial_fail_notify:${fingerprint}`;
  const last = getMeta(db, dedupeKey);
  if (last && Date.parse(last) > now.getTime() - DEDUPE_TTL_MS) {
    return { skipped: 'deduped' };
  }

  // Log first, then notify (plan requirement).
  console.error(
    JSON.stringify({
      type: 'editorial_weekly_failure',
      projectId,
      jobId,
      message: String(message).slice(0, 500),
      at: now.toISOString(),
    }),
  );

  const config = {
    token: env.TELEGRAM_BOT_TOKEN,
    chatId,
    alertChatId: chatId,
  };
  try {
    await notify(
      config,
      `<b>Редакция</b>: анализ не создал предложение\nПроект: <code>${escapeHtml(projectId)}</code>\n${escapeHtml(String(message).slice(0, 300))}\nНезависимые посты продолжаются.`,
    );
    setMeta(db, dedupeKey, now.toISOString());
    return { sent: true };
  } catch (error) {
    return { error: String(error.message || error) };
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
