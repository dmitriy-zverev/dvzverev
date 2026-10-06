const app = document.getElementById('app');
if (!app || !('apiBase' in app.dataset)) {
  throw new Error('cabinet_app_missing');
}

function resolveApiBase(raw) {
  const trimmed = String(raw ?? '').trim().replace(/\/$/, '');
  if (!trimmed) {
    return window.location.origin;
  }
  try {
    const url = new URL(trimmed);
    const { hostname } = window.location;
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      url.hostname = hostname;
    }
    return url.origin;
  } catch {
    return trimmed;
  }
}

const apiBase = resolveApiBase(app.dataset.apiBase);

const state = {
  authenticated: false,
  refreshMs: 30000,
  backoffMs: 30000,
  timer: null,
  dataVersion: null,
};

function params() {
  return new URLSearchParams(window.location.search);
}

function setParam(key, value) {
  const next = params();
  if (!value) next.delete(key);
  else next.set(key, value);
  const query = next.toString();
  history.replaceState({}, '', query ? `?${query}` : window.location.pathname);
}

async function api(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = response.ok ? await response.json() : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || body.error || 'request_failed');
    error.status = response.status;
    error.body = body;
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) error.retryAfterSeconds = Number(retryAfter);
    throw error;
  }
  return body;
}

function escapeText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeAttr(value) {
  return escapeText(value).replace(/\r?\n/g, ' ');
}

function stopRefresh() {
  clearTimeout(state.timer);
  state.timer = null;
}

async function logout() {
  try {
    await api('/bot/api/v1/auth/logout', { method: 'POST' });
  } catch {
    // Clear local session even if API fails.
  }
  state.authenticated = false;
  stopRefresh();
  renderLogin();
}

function activeTab() {
  const tab = params().get('tab');
  if (tab === 'incidents') return 'incidents';
  if (tab === 'service') return 'service';
  return 'week';
}

function incidentOpenCount(incidents) {
  if (!incidents?.items?.length) return 0;
  return incidents.items.reduce((sum, item) => sum + (Number(item.count) || 1), 0);
}

const STALE_DATA_LABEL =
  'Данные устарели. Планировщик не отвечает или синхронизация давно не обновлялась.';

function renderStaleIndicator(stale) {
  if (!stale) return '';
  return `
    <button type="button" class="stale-indicator" id="stale-indicator"
      aria-label="${escapeText(STALE_DATA_LABEL)}"
      title="${escapeText(STALE_DATA_LABEL)}">
      <svg class="stale-indicator-icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
        <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
      </svg>
    </button>`;
}

function renderHeartbeatPill(data) {
  const ok = Boolean(data?.service?.heartbeat?.ok);
  const stale = Boolean(data?.service?.stale);
  const mutedOffline = !ok && stale;
  const label = ok ? 'OK' : mutedOffline ? 'офлайн' : 'нет связи';
  const dotClass = ok ? ' is-ok' : mutedOffline ? ' is-muted' : ' is-bad';
  const pillClass = mutedOffline ? 'heartbeat-pill heartbeat-pill--muted' : 'heartbeat-pill';
  return `
    <button type="button" class="${pillClass}" id="heartbeat-pill" aria-label="Состояние сервиса: ${escapeText(label)}">
      <span class="heartbeat-dot${dotClass}" aria-hidden="true"></span>
      <span class="heartbeat-label">${escapeText(label)}</span>
    </button>`;
}

function renderCabinetTabs(openCount = 0) {
  const tab = activeTab();
  const badge =
    openCount > 0
      ? `<span class="cabinet-tab-badge">${escapeText(openCount)}</span>`
      : '';
  return `
    <nav class="cabinet-tabs" aria-label="Разделы">
      <button type="button" class="cabinet-tab${tab === 'week' ? ' is-active' : ''}" data-tab="week" aria-current="${tab === 'week' ? 'page' : 'false'}">Неделя</button>
      <button type="button" class="cabinet-tab${tab === 'incidents' ? ' is-active' : ''}" data-tab="incidents" aria-current="${tab === 'incidents' ? 'page' : 'false'}">Инциденты${badge}</button>
      <button type="button" class="cabinet-tab${tab === 'service' ? ' is-active' : ''}" data-tab="service" aria-current="${tab === 'service' ? 'page' : 'false'}">Сервис</button>
    </nav>`;
}

function renderSiteHeader(openCount = 0, data = null) {
  return `
    <header class="cabinet-header" aria-label="Кабинет">
      <div class="cabinet-header-shell">
        <div class="cabinet-header-brand">
          <h1 class="cabinet-header-title">Редакционный кабинет</h1>
        </div>
        ${renderCabinetTabs(openCount)}
        <div class="cabinet-header-actions">
          ${data ? renderStaleIndicator(Boolean(data.service?.stale)) : ''}
          ${data ? renderHeartbeatPill(data) : ''}
          <a class="cabinet-header-home" href="/">На сайт</a>
          <button type="button" class="cabinet-header-logout" id="logout">Выйти</button>
        </div>
      </div>
    </header>`;
}

function renderServiceSection(data) {
  const heartbeat = data.service?.heartbeat || {};
  return `
    <section class="service" aria-label="Состояние сервиса">
      <div class="panel-head">
        <h2>Сервис</h2>
        <button type="button" class="panel-refresh" id="refresh">Обновить</button>
      </div>
      <p><strong>Heartbeat:</strong> ${heartbeat.ok ? 'OK' : 'нет связи'}
        ${heartbeat.updatedAt ? `<span class="meta"> · ${escapeText(heartbeat.updatedAt)}</span>` : ''}
        ${heartbeat.ageSeconds != null ? `<span class="meta"> · возраст ${escapeText(heartbeat.ageSeconds)} с</span>` : ''}</p>
      <p class="meta">Обновлено: ${escapeText(data.as_of || '—')} · data_version ${escapeText(data.data_version)}
        · scheduler ${escapeText(data.scheduler_last_seen_at || '—')}</p>
      ${
        Object.keys(data.service?.pauses || {}).length
          ? `<p class="meta">Паузы: ${escapeText(JSON.stringify(data.service.pauses))}</p>`
          : ''
      }
      ${
        (data.service?.cooldowns || []).length
          ? `<p class="meta">Cooldown: ${escapeText(JSON.stringify(data.service.cooldowns))}</p>`
          : ''
      }
    </section>`;
}

function renderIncidentsSection(incidents) {
  return `
    <section class="incidents" aria-label="Ошибки">
      <div class="panel-head">
        <h2>Инциденты</h2>
        <button type="button" class="panel-refresh" id="refresh">Обновить</button>
      </div>
      ${
        incidents.items.length
          ? incidents.items
              .map(
                (item) =>
                  `<article class="card"><div class="card-head"><strong>${escapeText(item.projectId)}</strong><span class="meta">×${item.count}</span></div><p>${escapeText(item.message)}</p><p class="meta">${escapeText(item.stage)} · ${escapeText(item.lastSeenAt)}</p></article>`,
              )
              .join('')
          : '<p class="meta">Открытых инцидентов нет.</p>'
      }
    </section>`;
}

function renderLogin(message = '') {
  app.className = 'cabinet cabinet--gate';
  app.innerHTML = `
    <section class="login" aria-labelledby="login-title">
      <p class="login-eyebrow"><span aria-hidden="true">◈</span> Редакция</p>
      <h1 id="login-title">Редакционный кабинет</h1>
      <p class="login-lead">Доступ только для владельца.</p>
      ${message ? `<p class="error-banner login-error" role="alert">${escapeText(message)}</p>` : ''}
      <form id="login-form" class="login-form">
        <label class="login-field">
          <span class="login-field-label">Пароль</span>
          <input type="password" name="password" autocomplete="current-password" required />
        </label>
        <button type="submit" class="login-submit">Войти</button>
      </form>
      <p class="login-footer"><a class="login-site-link" href="/">← На сайт</a></p>
    </section>`;
  document.getElementById('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = new FormData(event.target).get('password');
    try {
      await api('/bot/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ password }) });
      state.authenticated = true;
      await boot();
    } catch (error) {
      if (error.status === 429) {
        const retry = error.retryAfterSeconds;
        renderLogin(
          retry
            ? `Слишком много попыток. Повторите через ${retry} с.`
            : 'Слишком много попыток входа. Подождите и повторите.',
        );
        return;
      }
      renderLogin('Неверный пароль.');
    }
  });
}

function toneForStatus(status) {
  if (status === 'sent' || status === 'partially_sent') return 'sent';
  if (['failed', 'exhausted', 'missed'].includes(status)) return 'failed';
  if (status === 'uncertain') return 'uncertain';
  if (status === 'retry_wait') return 'delayed';
  return 'default';
}

function slotChannelLabel(card) {
  const id = card.destinationId || '';
  if (id.endsWith('-vk')) return 'VK';
  const title = card.destinationTitle || '';
  const space = title.indexOf(' ');
  if (space > 0) return title.slice(0, space);
  return title || '—';
}

/** Short labels for calendar slots only; modal/tooltip keep full statusLabel from API. */
const SLOT_STATUS_SHORT = {
  planned: 'План',
  generating: 'Готов…',
  ready: 'Готов',
  sending: 'Отпр.',
  retry_wait: 'Задерж.',
  sent: 'Опубл.',
  failed: 'Ошибка',
  exhausted: 'Ошибка',
  uncertain: '?',
  missed: 'Проп.',
  cancelled: 'Отмен.',
  partially_sent: 'Частич.',
};

const SLOT_STATUS_SHORT_BY_LABEL = {
  Запланирован: 'План',
  Готовится: 'Готов…',
  'Готов к отправке': 'Готов',
  Отправляется: 'Отпр.',
  Задержан: 'Задерж.',
  Опубликован: 'Опубл.',
  'Не опубликован': 'Ошибка',
  'Исход неизвестен': '?',
  Пропущен: 'Проп.',
  Отменён: 'Отмен.',
  'Частично опубликован': 'Частич.',
};

function slotStatusShortLabel(card) {
  if (card.status && SLOT_STATUS_SHORT[card.status]) return SLOT_STATUS_SHORT[card.status];
  const label = card.statusLabel || '';
  if (SLOT_STATUS_SHORT_BY_LABEL[label]) return SLOT_STATUS_SHORT_BY_LABEL[label];
  if (label.length <= 8) return label;
  return label.slice(0, 7) + '…';
}

function formatDayTitle(ymd) {
  const label = formatWeekDateLabel(ymd);
  if (label) return label;
  if (!ymd || ymd.startsWith('—')) return ymd || '—';
  return ymd;
}

const RU_MONTH_SHORT = new Intl.DateTimeFormat('ru-RU', { month: 'short' });

function formatWeekDateLabel(ymd) {
  if (!ymd || ymd === '—' || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return '';
  const date = new Date(`${ymd}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  const day = ymd.slice(8, 10);
  const month = RU_MONTH_SHORT.format(date).replace(/\.$/, '');
  return `${day} ${month}.`;
}

function formatWeekRange(startYmd, endYmd) {
  const start = formatWeekDateLabel(startYmd);
  const end = formatWeekDateLabel(endYmd);
  if (start && end) return `${start} — ${end}`;
  if (start) return start;
  if (end) return end;
  return '—';
}

function weekRangeIsoTitle(startYmd, endYmd) {
  if (formatWeekDateLabel(startYmd) && formatWeekDateLabel(endYmd)) {
    return `${startYmd} — ${endYmd}`;
  }
  return formatWeekRange(startYmd, endYmd);
}

function weekScheduleProblems(summary) {
  return (
    (Number(summary?.failed) || 0) +
    (Number(summary?.uncertain) || 0) +
    (Number(summary?.delayed) || 0)
  );
}

function weekKpiClass(tone, value) {
  const n = Number(value) || 0;
  if (tone === 'missed' || tone === 'problems') return n > 0 ? 'week-kpi--danger' : 'week-kpi--muted';
  if (tone === 'sent') return n > 0 ? 'week-kpi--ok' : 'week-kpi--muted';
  if (tone === 'planned') return 'week-kpi--accent';
  return 'week-kpi--muted';
}

function renderWeekKpi(label, value, tone) {
  const n = Number(value) || 0;
  return `<div class="week-kpi ${weekKpiClass(tone, n)}" role="listitem">
    <span class="week-kpi-value">${escapeText(n)}</span>
    <span class="week-kpi-label">${escapeText(label)}</span>
  </div>`;
}

function weekStatValueClass(tone, value) {
  const n = Number(value) || 0;
  if (n === 0) return 'week-stat-value week-stat-value--muted';
  if (tone === 'failed') return 'week-stat-value week-stat-value--danger week-stat-value--emphasis';
  if (tone === 'uncertain' || tone === 'delayed') return 'week-stat-value week-stat-value--warn week-stat-value--emphasis';
  if (tone === 'sent') return 'week-stat-value week-stat-value--ok';
  return 'week-stat-value';
}

function renderWeekStatCell(label, value, tone) {
  const n = Number(value) || 0;
  return `<div>
    <dt>${escapeText(label)}</dt>
    <dd class="${weekStatValueClass(tone, n)}">${escapeText(n)}</dd>
  </div>`;
}

let modalEscapeBound = false;

function closeModal() {
  const modal = document.getElementById('modal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
  const body = document.getElementById('modal-body');
  if (body) body.innerHTML = '';
}

function openModal() {
  const modal = document.getElementById('modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
}

function ensureModalEscape() {
  if (modalEscapeBound) return;
  modalEscapeBound = true;
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
  });
}

function bindModal() {
  document.getElementById('modal-backdrop')?.addEventListener('click', closeModal);
  document.getElementById('modal-close')?.addEventListener('click', closeModal);
}

function readSlotMeta(node) {
  return {
    editionId: node.dataset.edition,
    planId: node.dataset.plan,
    version: node.dataset.version,
    time: node.dataset.time,
    channel: node.dataset.channel,
    project: node.dataset.project,
    statusLabel: node.dataset.statusLabel,
    topic: node.dataset.topic || '',
    topicLabel: node.dataset.topicLabel || node.dataset.topic || '',
    brief: node.dataset.brief || '',
    publicationKind: node.dataset.kind,
    contentPreview: node.dataset.preview,
    vkUrl: node.dataset.vk,
    tone: node.dataset.tone,
  };
}

function renderSlotSummary(meta) {
  const kind = escapeText(meta.publicationKind || '—');
  const channel = escapeText(meta.channel || '—');
  const project = escapeText(meta.project || '—');
  const topicRaw = (meta.topicLabel || '').trim();
  const showTopic =
    topicRaw &&
    topicRaw !== (meta.project || '—') &&
    topicRaw !== 'Тема не задана' &&
    topicRaw !== 'тема ещё не выбрана';
  return `
    <header class="modal-head">
      <h2 id="modal-title" class="modal-title">
        <span class="modal-title-line modal-title-time">${escapeText(meta.time)}</span>
        <span class="modal-title-line modal-title-channel">${channel}</span>
        <span class="modal-title-line modal-title-project">${project}</span>
      </h2>
      <div class="modal-meta">
        <span class="modal-status-badge" data-tone="${escapeText(meta.tone || 'default')}">${escapeText(meta.statusLabel)}</span>
        <span class="modal-meta-kind">${kind}</span>
      </div>
      ${showTopic ? `<p class="modal-topic">${escapeText(topicRaw)}</p>` : ''}
      ${meta.contentPreview ? `<p class="modal-preview meta">${escapeText(meta.contentPreview)}</p>` : ''}
      ${meta.vkUrl ? `<p class="modal-link"><a href="${escapeText(meta.vkUrl)}" rel="noopener noreferrer">Открыть VK</a></p>` : ''}
    </header>`;
}

function renderOverview(data, incidents, errorMessage = '') {
  const tab = activeTab();
  const openCount = incidentOpenCount(incidents);
  const week = data.week;
  const project = params().get('project') || '';
  const status = params().get('status') || '';
  const summary = data.summary;
  const deliverySummary = data.deliverySummary || summary;
  const scheduleProblems = weekScheduleProblems(summary);
  const weekPanel =
    tab === 'week'
      ? `
    <section class="summary summary--week-stats" aria-label="Сводка недели: расписание и публикации">
      <p
        class="week-stats-lead meta"
        title="Слоты — материалы в календаре недели; публикации — фактические доставки на каналы."
      >
        <span class="week-stats-lead-icon" aria-hidden="true">◈</span>
        Неделя: что требует внимания
      </p>
      <div class="week-stats-kpis" role="list" aria-label="Ключевые показатели недели">
        ${renderWeekKpi('Пропущено', summary.missed, 'missed')}
        ${renderWeekKpi('Запланировано', summary.planned, 'planned')}
        ${renderWeekKpi('Опубликовано', summary.sent, 'sent')}
        ${renderWeekKpi('Проблемы', scheduleProblems, 'problems')}
      </div>
      <div class="week-stats-columns">
        <div class="week-stats-panel">
          <h2 class="week-stats-panel-title" id="week-summary-schedule">Календарь</h2>
          <dl class="week-stats-row" aria-labelledby="week-summary-schedule">
            ${renderWeekStatCell('Слоты', summary.materials, 'materials')}
            ${renderWeekStatCell('Готовятся', summary.readying, 'readying')}
            ${renderWeekStatCell('Задержаны', summary.delayed, 'delayed')}
            ${renderWeekStatCell('Ошибка', summary.failed, 'failed')}
            ${renderWeekStatCell('Неизвестно', summary.uncertain, 'uncertain')}
          </dl>
        </div>
        <div class="week-stats-panel">
          <h2 class="week-stats-panel-title" id="week-summary-delivery">Доставки</h2>
          <dl class="week-stats-row" aria-labelledby="week-summary-delivery">
            ${renderWeekStatCell('Доставок', deliverySummary.materials, 'materials')}
            ${renderWeekStatCell('Успешно', deliverySummary.sent, 'sent')}
            ${renderWeekStatCell('С задержкой', deliverySummary.delayed, 'delayed')}
            ${renderWeekStatCell('С ошибкой', deliverySummary.failed, 'failed')}
            ${renderWeekStatCell('Исход неясен', deliverySummary.uncertain, 'uncertain')}
          </dl>
        </div>
      </div>
    </section>
    <section class="toolbar toolbar--week-nav" aria-label="Навигация недели">
      <div class="toolbar-title">
        <h1 title="${escapeText(weekRangeIsoTitle(week.start, week.end))}">${escapeText(formatWeekRange(week.start, week.end))}</h1>
      </div>
      <div class="toolbar-controls">
        <div class="toolbar-group toolbar-nav" role="group" aria-label="Переключение недели">
          <button type="button" id="prev-week" aria-label="Предыдущая неделя">←</button>
          <button type="button" id="today-week">Сегодня</button>
          <button type="button" id="next-week" aria-label="Следующая неделя">→</button>
        </div>
        <div class="toolbar-group toolbar-filters">
          <select id="project-filter" aria-label="Проект">
            <option value="">Все проекты</option>
            ${data.projects
              .map(
                (item) =>
                  `<option value="${escapeText(item.id)}" ${item.id === project ? 'selected' : ''}>${escapeText(item.title)}</option>`,
              )
              .join('')}
          </select>
          <select id="status-filter" aria-label="Статус">
            <option value="">Все статусы</option>
            ${[
              ['planned', 'Запланирован'],
              ['retry_wait', 'Задержан'],
              ['sent', 'Опубликован'],
              ['failed', 'Не опубликован'],
              ['uncertain', 'Исход неизвестен'],
              ['missed', 'Пропущен'],
            ]
              .map(
                ([value, label]) =>
                  `<option value="${value}" ${value === status ? 'selected' : ''}>${escapeText(label)}</option>`,
              )
              .join('')}
          </select>
        </div>
        <button type="button" class="toolbar-refresh" id="refresh">Обновить</button>
      </div>
    </section>
    <section class="days-grid" aria-label="Календарь">
      ${data.days
        .map(
          (day) => `
        <div class="day-block">
          <h3 class="day-title" title="${escapeText(day.date)}">${escapeText(formatDayTitle(day.date))}</h3>
          <div class="day-slots">${day.cards.length ? day.cards.map(renderCard).join('') : '<p class="day-empty meta">—</p>'}</div>
        </div>`,
        )
        .join('')}
    </section>
    <div id="modal" class="modal hidden" aria-hidden="true">
      <button type="button" class="modal-backdrop" id="modal-backdrop" aria-label="Закрыть"></button>
      <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <button type="button" class="modal-close" id="modal-close" aria-label="Закрыть">×</button>
        <div id="modal-body" class="modal-body"></div>
      </div>
    </div>`
      : '';
  const incidentsPanel = tab === 'incidents' ? renderIncidentsSection(incidents) : '';
  const servicePanel = tab === 'service' ? renderServiceSection(data) : '';

  app.className = 'cabinet';
  app.innerHTML = `
    ${renderSiteHeader(openCount, data)}
    ${errorMessage ? `<div class="error-banner" role="alert">${escapeText(errorMessage)}</div>` : ''}
    ${weekPanel}
    ${incidentsPanel}
    ${servicePanel}`;

  document.getElementById('logout').onclick = () => logout();
  const openServiceTab = () => {
    if (tab === 'service') return;
    setParam('tab', 'service');
    loadOverview(true);
  };
  document.getElementById('stale-indicator')?.addEventListener('click', openServiceTab);
  document.getElementById('heartbeat-pill')?.addEventListener('click', openServiceTab);
  app.querySelectorAll('.cabinet-tab').forEach((node) => {
    node.addEventListener('click', () => {
      const next = node.dataset.tab;
      if (next === tab) return;
      setParam('tab', next === 'week' ? '' : next);
      loadOverview(true);
    });
  });

  if (tab === 'week') {
    document.getElementById('prev-week').onclick = () => shiftWeek(week.start, -7);
    document.getElementById('next-week').onclick = () => shiftWeek(week.start, 7);
    document.getElementById('today-week').onclick = () => setParam('week', '');
    document.getElementById('project-filter').onchange = (event) => {
      setParam('project', event.target.value);
      loadOverview(true);
    };
    document.getElementById('status-filter').onchange = (event) => {
      setParam('status', event.target.value);
      loadOverview(true);
    };
    document.getElementById('refresh').onclick = () => loadOverview(true);
    bindModal();
    ensureModalEscape();
    app.querySelectorAll('.slot').forEach((node) => {
      node.addEventListener('click', () => openSlot(readSlotMeta(node)));
    });
  } else {
    document.getElementById('refresh').onclick = () => loadOverview(true);
  }
}

function renderCard(card) {
  const tone = toneForStatus(card.status);
  const channel = slotChannelLabel(card);
  const project = card.projectTitle || '—';
  const kind = `${card.publicationKind || 'text'}${card.expectedMedia ? ` / ${card.expectedMedia}` : ''}`;
  const tip = `${card.time} · ${channel} · ${project} · ${card.statusLabel}`;
  const adHocClass = card.adHoc ? ' slot--adhoc' : '';
  const statusShort = slotStatusShortLabel(card);
  const statusFull = card.statusLabel || statusShort;
  const channelBadge =
    channel && channel !== '—'
      ? `<span class="slot-channel">${escapeText(channel)}</span>`
      : '';
  const releaseLine =
    card.adHoc && card.releaseLabel
      ? `<span class="slot-release">${escapeText(card.releaseLabel)}</span>`
      : '';
  return `<button type="button" class="slot${adHocClass}" data-tone="${tone}"
    data-edition="${escapeText(card.editionId || '')}"
    data-plan="${escapeText(card.planId || '')}"
    data-version="${escapeText(card.version ?? '')}"
    data-time="${escapeText(card.time)}"
    data-channel="${escapeText(channel)}"
    data-project="${escapeText(project)}"
    data-status-label="${escapeText(card.statusLabel)}"
    data-topic="${escapeAttr(card.topic || '')}"
    data-topic-label="${escapeAttr(card.topicLabel || '')}"
    data-brief="${escapeAttr(card.brief || '')}"
    data-kind="${escapeText(kind)}"
    data-preview="${escapeText(card.contentPreview || '')}"
    data-vk="${escapeText(card.vkUrl || '')}"
    data-adhoc="${card.adHoc ? '1' : '0'}"
    data-release-label="${escapeText(card.releaseLabel || '')}"
    title="${escapeText(tip)}"
    aria-label="${escapeText(tip)}">
    <span class="slot-top">
      <span class="slot-time">${escapeText(card.time)}</span>
      <span class="slot-badges">
        ${channelBadge}
        <span class="slot-status-pill" data-tone="${tone}" title="${escapeText(statusFull)}">${escapeText(statusShort)}</span>
      </span>
    </span>
    <span class="slot-project-row">
      <span class="slot-project">${escapeText(project)}</span>
    </span>
    ${releaseLine}
  </button>`;
}

function shiftWeek(startYmd, days) {
  const date = new Date(`${startYmd}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  setParam('week', date.toISOString().slice(0, 10));
  loadOverview(true);
}

async function openSlot(meta) {
  openModal();
  const body = document.getElementById('modal-body');
  body.innerHTML = `${renderSlotSummary(meta)}<div id="modal-extra" class="modal-extra"><p class="meta">Загрузка…</p></div>`;
  await loadSlotDetails(meta);
}

async function handlePlanFormSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const planId = form.dataset.planId;
  if (!planId) return;
  const payload = new FormData(form);
  try {
    await api(`/bot/api/v1/plans/${encodeURIComponent(planId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        topic: payload.get('topic'),
        brief: payload.get('brief'),
        expectedVersion: Number(payload.get('expectedVersion')),
      }),
    });
    closeModal();
    await loadOverview(true);
  } catch (error) {
    alert(error.body?.error === 'version_conflict' ? 'Конфликт версии, обновите страницу.' : 'Не удалось сохранить.');
  }
}

async function loadSlotDetails(meta) {
  const extra = document.getElementById('modal-extra');
  if (!extra) return;

  if (meta.editionId) {
    try {
      const detail = await api(`/bot/api/v1/editions/${encodeURIComponent(meta.editionId)}`);
      const releaseBadge = detail.adHoc && detail.releaseLabel
        ? `<p><span class="release-badge">${escapeText(detail.releaseLabel)}</span></p>`
        : '';
      extra.innerHTML = `
      <h3 class="modal-section">Выпуск</h3>
      ${releaseBadge}
      <p><strong>Статус:</strong> ${escapeText(detail.edition.statusLabel)}</p>
      ${detail.edition.brief ? `<p><strong>Бриф:</strong> ${escapeText(detail.edition.brief)}</p>` : ''}
      ${detail.edition.models ? `<p class="meta">Модели: ${escapeText(JSON.stringify(detail.edition.models))}</p>` : ''}
      ${detail.edition.costUsd != null ? `<p class="meta">Расход: $${escapeText(detail.edition.costUsd)}</p>` : ''}
      ${detail.edition.promptVersion ? `<p class="meta">Промпт: ${escapeText(detail.edition.promptVersion)}</p>` : ''}
      <pre class="modal-pre">${escapeText(detail.edition.bodyText || detail.edition.bodyNotice || 'Текст пока не сохранён')}</pre>
      ${detail.deliveries
        .map(
          (delivery) =>
            `<p>${escapeText(delivery.platform)}: ${escapeText(delivery.statusLabel)}${delivery.failureReason ? ` — ${escapeText(delivery.failureReason)}` : ''} ${delivery.vkUrl ? `<a href="${escapeText(delivery.vkUrl)}">VK</a>` : ''}</p>`,
        )
        .join('')}
      ${
        detail.events?.length
          ? `<h3 class="modal-section">История</h3>${detail.events.map((event) => `<p class="meta">${escapeText(event.createdAt)} · ${escapeText(event.stage)} · ${escapeText(event.message)}</p>`).join('')}`
          : ''
      }`;
    } catch (error) {
      extra.innerHTML = `<p class="error-banner" role="alert">Не удалось загрузить выпуск. ${escapeText(error.message)}</p>`;
    }
    return;
  }

  extra.innerHTML = `
    <form id="plan-form" class="modal-form" data-plan-id="${escapeText(meta.planId)}">
      <div class="modal-form-field">
        <label class="modal-form-label" for="plan-topic">Тема</label>
        <input id="plan-topic" name="topic" type="text" maxlength="500" value="${escapeText(meta.topic || '')}" autocomplete="off" />
      </div>
      <div class="modal-form-field">
        <label class="modal-form-label" for="plan-brief">Бриф</label>
        <textarea id="plan-brief" name="brief" rows="5" maxlength="4000" placeholder="Контекст и пожелания к материалу">${escapeText(meta.brief || '')}</textarea>
      </div>
      <input type="hidden" name="expectedVersion" value="${escapeText(meta.version)}" />
      <div class="modal-form-actions">
        <button type="submit" class="modal-form-submit">Сохранить</button>
      </div>
    </form>`;
  document.getElementById('plan-form').addEventListener('submit', handlePlanFormSubmit);
}

async function loadOverview(manual = false) {
  const week = params().get('week');
  const project = params().get('project');
  const status = params().get('status');
  const query = new URLSearchParams();
  if (week) query.set('week', week);
  if (project) query.set('project', project);
  if (status) query.set('status', status);
  try {
    const [overview, incidents] = await Promise.all([
      api(`/bot/api/v1/overview?${query}`),
      api(`/bot/api/v1/incidents?${project ? `project=${encodeURIComponent(project)}&` : ''}status=open`),
    ]);
    if (state.dataVersion && overview.data_version < state.dataVersion && !manual) {
      overview.service = { ...(overview.service || {}), stale: true };
    }
    state.dataVersion = overview.data_version;
    renderOverview(overview, incidents);
    state.backoffMs = 30000;
  } catch (error) {
    if (error.status === 401) {
      state.authenticated = false;
      renderLogin();
      return;
    }
    renderOverview(
      {
        week: { start: '—', end: '—', timezone: 'Europe/Moscow' },
        projects: [],
        summary: {
          materials: 0,
          planned: 0,
          readying: 0,
          sent: 0,
          delayed: 0,
          failed: 0,
          uncertain: 0,
          missed: 0,
        },
        days: [],
        service: { heartbeat: { ok: false }, stale: true },
        as_of: null,
        data_version: 0,
        scheduler_last_seen_at: null,
      },
      { items: [] },
      error.body?.message || 'API недоступен. Расписание не показано как пустое.',
    );
    state.backoffMs = Math.min(state.backoffMs * 2, 300000);
  }
  scheduleRefresh();
}

function scheduleRefresh() {
  clearTimeout(state.timer);
  if (document.hidden) return;
  state.timer = setTimeout(() => loadOverview(false), state.backoffMs);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.authenticated) loadOverview(false);
});

async function boot() {
  try {
    const sessionResponse = await fetch(`${apiBase}/bot/api/v1/auth/session`, {
      credentials: 'include',
    });
    if (!sessionResponse.ok) {
      renderLogin('API недоступен. Запустите pnpm cabinet:api.');
      return;
    }
    const session = await sessionResponse.json();
    if (!session.authenticated) {
      renderLogin();
      return;
    }
    state.authenticated = true;
    await loadOverview(true);
  } catch {
    renderLogin('API недоступен. Запустите pnpm cabinet:api.');
  }
}

boot();
