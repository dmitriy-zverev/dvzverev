import { escapeHtml } from '../../content.mjs';
import { redact } from '../../logging.mjs';

const PERIOD_LABEL = { morning: 'УТРО', evening: 'ВЕЧЕР' };
const MAX_HTML_CHARS = 3700;

export function renderReport({ reportKind, snapshot, reportConfig, now = new Date() }) {
  const { batch, members, progress, deliverySummary } = snapshot;
  const before = reportKind === 'before';
  const period = PERIOD_LABEL[batch.period] || batch.period.toUpperCase();
  const date = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' })
    .format(new Date(`${batch.localDate}T12:00:00Z`));
  const title = before ? 'План публикаций' : reportKind === 'recovery' ? 'Восстановление'
    : progress.needsAttention || progress.sent < progress.total ? 'Нужна проверка' : 'Итоги публикаций';
  const headline = `${before ? '🗓' : progress.needsAttention ? '⚠️' : '✅'} ${period} · ${date} · ${title}`;
  const blocks = [];
  const add = (plain, html = escapeHtml(plain)) => blocks.push({ plain, html });
  const timeZone = batch.timezone || reportConfig.timezone || 'Europe/Moscow';
  const cabinetUrl = `${reportConfig.publicSiteUrl}/bot/?date=${batch.localDate}&batch=${batch.period}`;
  const footer = isSafeReportUrl(cabinetUrl)
    ? { plain: `Открыть календарь: ${cabinetUrl}`, html: `<a href="${escapeHtml(cabinetUrl)}">Открыть календарь →</a>` }
    : null;

  if (!members.length) add('В этой серии публикаций нет.');
  else {
    if (before) {
      const materials = new Set(members.map(m => m.editionId || m.planId)).size;
      add(`Запланировано: ${materials} · доставок: ${members.length}`,
        `<b>Запланировано: ${materials}</b> · доставок: ${members.length}`);
    } else {
      add(`Опубликовано: ${progress.sent}/${progress.total}\nОшибки: ${progress.failed} · задержано: ${progress.delayed}\nОжидает: ${progress.pending} · неизвестный исход: ${progress.uncertain}`,
        `<b>Опубликовано: ${progress.sent}/${progress.total}</b>\nОшибки: ${progress.failed} · задержано: ${progress.delayed}\nОжидает: ${progress.pending} · неизвестный исход: ${progress.uncertain}`);
    }
    const ordered = before ? members : [...members].sort((a, b) => problemScore(b) - problemScore(a));
    for (const member of ordered) {
      const label = short(member.projectTitle, 90);
      const status = before ? `${member.time} · ${formatKind(member)}` : outcome(member, timeZone);
      const lines = [status];
      if (member.topic) lines.push(short(member.topicLabel || member.topic, 140));
      if (!before && member.deliveryStatus !== 'sent' && member.failureReason) {
        lines.push(`Причина: ${short(redact(member.failureReason), 160)}`);
      }
      let plain = `${label}\n${lines.join('\n')}`;
      let html = `<b>${escapeHtml(label)}</b>\n${lines.map(escapeHtml).join('\n')}`;
      if (!before && member.deliveryStatus === 'sent' && isSafePostUrl(member.vkUrl)) {
        plain += `\nОткрыть пост: ${member.vkUrl}`;
        html += `\n<a href="${escapeHtml(member.vkUrl)}">Открыть пост →</a>`;
      } else if (!before && member.deliveryStatus === 'sent') {
        plain += '\nСсылка на пост пока недоступна';
        html += '\nСсылка на пост пока недоступна';
      }
      add(plain, html);
    }
    if (before) {
      const ready = members.filter(m => ['ready', 'sent'].includes(m.materialStatus)).length;
      const preparing = members.filter(m => ['generating', 'sending'].includes(m.materialStatus)).length;
      add(`Готово: ${ready} · готовится: ${preparing} · осталось: ${members.length - ready - preparing}`);
      if (batch.lastSlotUtc) {
        add(`Итог после ${clock(batch.lastSlotUtc, timeZone)} · контроль до ${clock(new Date(Date.parse(batch.lastSlotUtc) + (reportConfig.batchDeadlineMinutes ?? 45) * 60_000), timeZone)} МСК`);
      }
    } else {
      const costs = new Map(members.filter(m => m.editionId).map(m => [m.editionId, m.costUsd]));
      const known = [...costs.values()].filter(Number.isFinite);
      const unknown = costs.size - known.length;
      if (costs.size) add(`Генерация: ${known.length ? '$' + known.reduce((a, b) => a + b, 0).toFixed(4) : 'стоимость неизвестна'}${unknown && known.length ? ` · без цены: ${unknown}` : ''}`);
      if (reportKind === 'deadline' && !progress.allTerminal) add(`Серия ещё не завершена. Сводка на ${clock(now, timeZone)}.`);
      if (reportKind === 'late_final') add('Окончательный итог после задержки.');
      if (reportKind === 'recovery') add(`Сервис восстановлен. Сводка на ${clock(now, timeZone)}.`);
    }
    if (batch.membersAdded || batch.membersRemoved) add(`Изменения плана: добавлено ${batch.membersAdded || 0} · отменено ${batch.membersRemoved || 0}`);
  }
  // Keep complete blocks: slicing rendered HTML can break tags, entities and links.
  const selected = [];
  let size = headline.length + (footer?.html.length || 0) + 120;
  for (const block of blocks) {
    if (size + block.html.length + 2 > MAX_HTML_CHARS) break;
    selected.push(block);
    size += block.html.length + 2;
  }
  if (selected.length < blocks.length) selected.push({ plain: 'Полный список — в календаре.', html: 'Полный список — в календаре.' });
  if (footer) selected.push(footer);
  return { headline, bodyPlain: selected.map(b => b.plain).join('\n\n'), bodyHtml: selected.map(b => b.html).join('\n\n'), deliverySummary };
}

export function formatReportTelegramHtml(headline, bodyHtml) {
  return `<b>${escapeHtml(headline)}</b>\n\n${bodyHtml}`;
}

function short(value, limit) {
  const chars = Array.from(String(value || '').replace(/\s+/g, ' ').trim());
  return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : chars.join('');
}
function formatKind(member) {
  return ['video', 'gif'].includes(member.publicationKind) ? 'текст + GIF' : 'текст';
}
function clock(value, timeZone) {
  return new Intl.DateTimeFormat('ru-RU', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
}
function outcome(m, timeZone) {
  if (m.deliveryStatus === 'sent') return `✓ ${clock(m.sentAt || m.slotUtc, timeZone)} · ${formatKind(m)} · опубликован`;
  if (m.deliveryStatus === 'retry_wait') return `⏳ Задержан · ${m.retryAt ? 'повтор в ' + clock(m.retryAt, timeZone) : 'повтор запланирован'}`;
  if (m.deliveryStatus === 'uncertain') return '? Исход неизвестен · проверьте стену VK';
  if (m.deliveryStatus === 'cancelled') return '— Отменён';
  if (m.deliveryStatus === 'missed') return '✕ Пропущен';
  if (['failed', 'exhausted'].includes(m.deliveryStatus)) return '✕ Не опубликован';
  return '○ Ожидает публикации';
}
function problemScore(m) {
  return m.deliveryStatus === 'sent' ? 0 : m.deliveryStatus === 'uncertain' ? 4 : m.deliveryStatus === 'retry_wait' ? 3 : 2;
}
function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : null;
  } catch { return null; }
}
export function isSafePostUrl(value) {
  const url = safeUrl(value);
  return Boolean(url && ['vk.com', 'vk.ru'].includes(url.hostname) && /^\/wall-\d+_\d+$/.test(url.pathname) && !url.search && !url.hash);
}
export function isSafeReportUrl(value) {
  const url = safeUrl(value);
  return Boolean(url && (url.hostname === 'dvzverev.ru' || url.hostname.endsWith('.dvzverev.ru')));
}
