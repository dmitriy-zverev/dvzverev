import { createHash } from 'node:crypto';
import { getMeta, setMeta } from './db.mjs';
import { addDaysYmd, localSlotToUtc } from './time.mjs';
import { sendTelegram } from '../core.mjs';

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function summarizeWeek(db, weekStart, now = new Date()) {
  const end = addDaysYmd(weekStart, 6);
  const from = localSlotToUtc(weekStart, '00:00', 'Europe/Moscow').toISOString();
  const to = localSlotToUtc(addDaysYmd(weekStart, 7), '00:00', 'Europe/Moscow').toISOString();
  const rows = db
    .prepare(
      `SELECT s.project_id, p.title, w.status, w.error, s.slot_utc, s.plan_status,
        (SELECT d.status FROM deliveries d
          WHERE d.edition_id = s.edition_id AND d.platform = 'vk'
          ORDER BY d.updated_at DESC LIMIT 1) AS delivery_status
       FROM schedule_slots s
       JOIN projects p USING(project_id)
       LEFT JOIN vk_weekly_posts w USING(plan_id)
       WHERE s.slot_utc >= ? AND s.slot_utc < ?
         AND s.publication_kind IN ('text','image','gif')
         AND s.plan_status != 'cancelled' AND p.enabled = 1
       ORDER BY s.slot_utc, s.project_id`,
    )
    .all(from, to);

  const deferredStatuses = new Set(['deferred', 'scheduled', 'sent']);
  const groupsMap = new Map();
  const holes = [];
  let deferred = 0;
  let actionable = 0;
  const nowMs = now.getTime();
  for (const row of rows) {
    const published = row.plan_status === 'sent' || row.delivery_status === 'sent';
    const status = published ? 'sent' : row.status || 'pending';
    const past = Date.parse(row.slot_utc) <= nowMs;
    const isDeferred = deferredStatuses.has(status);
    if (isDeferred) deferred += 1;
    // Past unpublished slots are elapsed — not prepare holes.
    else if (!past) {
      actionable += 1;
      holes.push({
        title: row.title,
        when: new Date(row.slot_utc).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }),
        status,
        error: row.error || '',
      });
    }
    const group = groupsMap.get(row.project_id) || {
      title: row.title,
      total: 0,
      deferred: 0,
      problems: [],
    };
    group.total += 1;
    if (isDeferred) group.deferred += 1;
    else if (!past && row.error) group.problems.push(row.error);
    groupsMap.set(row.project_id, group);
  }

  return {
    end,
    total: rows.length,
    deferred,
    missing: actionable,
    groups: [...groupsMap.values()].map((group) => ({
      title: group.title,
      total: group.total,
      deferred: group.deferred,
      problems: [...new Set(group.problems)].slice(0, 3).join(', '),
    })),
    holes,
  };
}

/** One digest per weekly job — never spam per-slot alerts. */
export async function notifyWeeklyPrepareDigest(
  db,
  {
    weekStart,
    source = 'schedule',
    env = process.env,
    notify = sendTelegram,
    now = new Date(),
  } = {},
) {
  const chatId = env.BOT_ALERT_CHAT_ID;
  if (!chatId || !env.TELEGRAM_BOT_TOKEN) return { skipped: 'missing_telegram' };

  const fingerprint = createHash('sha256')
    .update(`weekly-digest:${weekStart}:${source}`)
    .digest('hex')
    .slice(0, 24);
  const dedupeKey = `weekly_prepare_notify:${fingerprint}`;
  if (getMeta(db, dedupeKey)) return { skipped: 'deduped' };

  const snapshot = summarizeWeek(db, weekStart);
  const sourceLabel = source === 'button' ? 'кнопка кабинета' : 'воскресенье 20:00';
  const lines = [
    `<b>Неделя VK</b> ${escapeHtml(weekStart)} — ${escapeHtml(snapshot.end)}`,
    `Источник: ${sourceLabel}`,
    `Всего слотов: ${snapshot.total} · отложено: <b>${snapshot.deferred}</b> · не готово: <b>${snapshot.missing}</b>`,
  ];
  for (const group of snapshot.groups) {
    lines.push(
      `· ${escapeHtml(group.title)}: ${group.deferred}/${group.total}` +
        (group.problems ? ` · проблемы: ${escapeHtml(group.problems)}` : ''),
    );
  }
  if (snapshot.holes.length) {
    lines.push('Остались:');
    for (const hole of snapshot.holes.slice(0, 12)) {
      lines.push(
        `· ${escapeHtml(hole.title)} · ${escapeHtml(hole.when)} · ${escapeHtml(hole.status)}${
          hole.error ? ` (${escapeHtml(hole.error)})` : ''
        }`,
      );
    }
  }
  const baseUrl = env.BOT_CABINET_PUBLIC_URL || 'https://www.dvzverev.ru/bot/';
  lines.push(`<a href="${escapeHtml(baseUrl)}?tab=week">Открыть неделю в кабинете</a>`);

  try {
    await notify(
      { token: env.TELEGRAM_BOT_TOKEN, chatId, alertChatId: chatId },
      lines.join('\n'),
    );
    setMeta(db, dedupeKey, now.toISOString());
    return { sent: true, ...snapshot };
  } catch (error) {
    return { error: String(error.message || error) };
  }
}
