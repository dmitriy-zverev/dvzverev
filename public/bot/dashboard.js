const app = document.getElementById('app');
if (!app || !('apiBase' in app.dataset)) {
  throw new Error('cabinet_app_missing');
}

function resolveApiBase(raw) {
  const trimmed = String(raw ?? '')
    .trim()
    .replace(/\/$/, '');
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

const PUBLIC_ERROR = {
  service_unavailable: 'Сервис временно недоступен. Попробуйте позже.',
  load_failed: 'Не удалось загрузить данные. Обновите страницу позже.',
  schedule_failed: 'Не удалось загрузить расписание.',
  edition_load_failed: 'Не удалось загрузить выпуск.',
  save_failed: 'Не удалось сохранить.',
  version_conflict: 'Конфликт версии, обновите страницу.',
  wrong_password: 'Неверный пароль.',
};

function publicErrorMessage(error, kind) {
  const code = error?.body?.error;
  if (code === 'version_conflict') return PUBLIC_ERROR.version_conflict;
  if (code === 'data_unavailable') return PUBLIC_ERROR.schedule_failed;
  if (code === 'invalid_credentials') return PUBLIC_ERROR.wrong_password;
  if (kind === 'overview') return PUBLIC_ERROR.load_failed;
  if (kind === 'edition') return PUBLIC_ERROR.edition_load_failed;
  if (kind === 'login_boot') return PUBLIC_ERROR.service_unavailable;
  return PUBLIC_ERROR.service_unavailable;
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
  if (
    [
      'incidents',
      'service',
      'editorial',
      'analytics',
      'analytics-posts',
      'analytics-imports',
      'analytics-segments',
      'analytics-prompts',
    ].includes(tab)
  ) {
    return tab;
  }
  return 'week';
}

function isAnalyticsTab(tab = activeTab()) {
  return String(tab).startsWith('analytics');
}

function isEditorialTab(tab = activeTab()) {
  return tab === 'editorial';
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
    openCount > 0 ? `<span class="cabinet-tab-badge">${escapeText(openCount)}</span>` : '';
  const analyticsActive = isAnalyticsTab(tab);
  const editorialActive = isEditorialTab(tab);
  return `
    <nav class="cabinet-tabs" aria-label="Разделы">
      <button type="button" class="cabinet-tab${tab === 'week' ? ' is-active' : ''}" data-tab="week" aria-current="${tab === 'week' ? 'page' : 'false'}">Неделя</button>
      <button type="button" class="cabinet-tab${editorialActive ? ' is-active' : ''}" data-tab="editorial" aria-current="${editorialActive ? 'page' : 'false'}">Редакция</button>
      <button type="button" class="cabinet-tab${analyticsActive ? ' is-active' : ''}" data-tab="analytics" aria-current="${analyticsActive ? 'page' : 'false'}">Аналитика</button>
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
      ${
        data.service?.reports
          ? `<p><strong>Telegram-сводки:</strong> режим ${escapeText(data.service.reports.mode)}
        · в очереди ${escapeText(data.service.reports.pending)}
        · ошибок ${escapeText(data.service.reports.failed)}
        ${data.service.reports.lastSentAt ? `<span class="meta"> · последняя ${escapeText(data.service.reports.lastSentAt)}</span>` : ''}
        ${data.service.reports.lastHeadline ? `<span class="meta"> · ${escapeText(data.service.reports.lastHeadline)}</span>` : ''}</p>`
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

function renderAnalyticsSubnav(tab) {
  const items = [
    ['analytics', 'Обзор 30 дней'],
    ['analytics-posts', 'Все посты'],
    ['analytics-imports', 'Импорты и покрытие'],
    ['analytics-segments', 'Сегменты'],
    ['analytics-prompts', 'Промпты и эксперименты'],
  ];
  return `
    <nav class="analytics-subnav" aria-label="Аналитика">
      ${items
        .map(
          ([id, label]) =>
            `<button type="button" class="cabinet-tab${tab === id ? ' is-active' : ''}" data-analytics-tab="${id}">${escapeText(label)}</button>`,
        )
        .join('')}
    </nav>`;
}

function renderAnalyticsSection(bundle) {
  const tab = activeTab();
  const project = params().get('project') || '';
  const projects = bundle.projects || [];
  const overview = bundle.overview;
  const posts = bundle.posts;
  const imports = bundle.imports;
  const segments = bundle.segments;
  const recommendations = bundle.recommendations || [];
  const versions = bundle.versions || [];

  let body;
  if (bundle.error) {
    body = `<p class="error-banner" role="alert">${escapeText(bundle.error)}</p>`;
  } else if (tab === 'analytics' && overview) {
    const cov = overview.coverage || {};
    body = `
      <p class="meta">Окно: последние 30×24ч UTC · отображение дат — Москва</p>
      <p>Покрытие: ${escapeText(cov.withMetrics ?? 0)} из ${escapeText(cov.sent ?? 0)} отправленных
        ${cov.ratio != null ? `(${escapeText(Math.round(cov.ratio * 100))}%)` : ''}</p>
      <p class="meta">${escapeText(overview.definitions?.reachVsViews || '')}</p>
      <div class="week-stats-kpis">
        ${renderWeekKpi('Охват med', overview.summary?.organicReach?.median ?? '—', 'sent')}
        ${renderWeekKpi('Engagement med', overview.summary?.engagementRate?.median != null ? Number(overview.summary.engagementRate.median).toFixed(3) : '—', 'planned')}
        ${renderWeekKpi('Доставка', overview.summary?.deliverySuccess?.ratio != null ? `${Math.round(overview.summary.deliverySuccess.ratio * 100)}%` : '—', 'materials')}
      </div>
      <h3>Топ по organic reach</h3>
      ${(overview.top || []).map((p) => `<p class="meta">${escapeText(p.editionId)} · reach ${escapeText(p.reachOrganic)} · age ${escapeText(p.ageDays != null ? p.ageDays.toFixed(1) : '—')}д</p>`).join('') || '<p class="meta">Нет данных</p>'}
      <h3>Низ (только с метриками)</h3>
      ${(overview.bottom || []).map((p) => `<p class="meta">${escapeText(p.editionId)} · reach ${escapeText(p.reachOrganic)}</p>`).join('') || '<p class="meta">Нет данных</p>'}`;
  } else if (tab === 'analytics-posts' && posts) {
    body = `
      <p class="meta">Постов: ${escapeText(posts.total)} · без метрик не ранжируются как ноль</p>
      <div class="analytics-table">
        ${
          (posts.items || [])
            .map((p) => {
              const reach = p.metrics?.reachOrganic ?? '—';
              const eng =
                p.derived?.engagement?.value != null
                  ? Number(p.derived.engagement.value).toFixed(3)
                  : '—';
              const notice = p.bodyNotice || (p.bodyText ? p.bodyText.slice(0, 80) : '—');
              return `<article class="card"><div class="card-head"><strong>${escapeText(p.projectId)}</strong><span class="meta">${escapeText(p.publishedAt || '')}</span></div>
              <p>${escapeText(notice)}</p>
              <p class="meta">reach ${escapeText(reach)} · eng ${escapeText(eng)} · media ${escapeText(p.mediaActual || 'none')} · prompt ${escapeText(p.promptVersion)} · age ${escapeText(p.ageBucket || '—')}
              ${p.metrics?.promoted ? ' · paid' : ''}
              ${p.vkUrl ? ` · <a href="${escapeAttr(p.vkUrl)}" rel="noopener noreferrer">VK</a>` : ''}</p></article>`;
            })
            .join('') || '<p class="meta">Нет постов в окне</p>'
        }
      </div>`;
  } else if (tab === 'analytics-imports') {
    body = `
      <form id="import-form" class="login-form">
        <label>Проект
          <select name="projectId" required>
            <option value="">—</option>
            ${projects.map((p) => `<option value="${escapeAttr(p.id)}" ${p.id === project ? 'selected' : ''}>${escapeText(p.title || p.id)}</option>`).join('')}
          </select>
        </label>
        <label>VK group id <input name="vkGroupId" required placeholder="194579254"></label>
        <label>observed_at <input name="observedAt" type="datetime-local" required></label>
        <label>Файл CSV/JSON <input name="file" type="file" accept=".csv,.json,text/csv,application/json" required></label>
        <p class="meta">Пустая ячейка = «нет данных», не ноль. Шаблон: <a href="${escapeAttr(apiBase)}/bot/api/v1/imports/template">скачать</a></p>
        <button type="submit">Preview</button>
      </form>
      <div id="import-preview"></div>
      <h3>Покрытие</h3>
      <p class="meta">С метриками: ${escapeText(imports?.coverage?.withMetrics ?? 0)} / ${escapeText(imports?.coverage?.sent ?? 0)}</p>
      ${
        (imports?.imports || [])
          .map(
            (item) =>
              `<article class="card"><div class="card-head"><strong>${escapeText(item.status)}</strong><span class="meta">${escapeText(item.createdAt)}</span></div>
              <p class="meta">${escapeText(item.importId)} · rows ${escapeText(item.rowCount)} · matched ${escapeText(item.matchedCount)} · errors ${escapeText(item.errorCount)}</p></article>`,
          )
          .join('') || '<p class="meta">Импортов пока нет</p>'
      }`;
  } else if (tab === 'analytics-segments' && segments) {
    body =
      Object.entries(segments.segments || [])
        .map(([name, list]) => {
          return `<h3>${escapeText(name)}</h3>${(list || [])
            .map(
              (s) =>
                `<p class="meta">${escapeText(s.key)} · n=${escapeText(s.posts)} · coverage ${escapeText(s.coverageRatio != null ? Math.round(s.coverageRatio * 100) + '%' : '—')} · reach med ${escapeText(s.organicReach?.median ?? '—')}
              ${s.note ? ` · ${escapeText(s.note)}` : ''}</p>`,
            )
            .join('')}`;
        })
        .join('') || '<p class="meta">Нет сегментов</p>';
    body += `<p class="meta">${escapeText(segments.caution || '')}</p>`;
  } else if (tab === 'analytics-prompts') {
    body = `
      <div class="panel-head"><h3>Рекомендации</h3>
        <button type="button" id="run-analysis">Запустить анализ</button></div>
      ${
        recommendations
          .map(
            (r) => `<article class="card" data-rec="${escapeAttr(r.recommendationId)}">
            <div class="card-head"><strong>${escapeText(r.status)}</strong><span class="meta">${escapeText(r.projectId)}</span></div>
            <p>${escapeText(r.observation)}</p>
            <p class="meta">evidence: ${(r.evidence || []).map((e) => escapeText(e.editionId)).join(', ') || '—'}</p>
            ${r.status === 'proposed' ? `<button type="button" data-decide="reject">Отклонить</button>` : ''}
          </article>`,
          )
          .join('') || '<p class="meta">Рекомендаций нет</p>'
      }
      <h3>Версии промптов</h3>
      ${
        versions
          .map(
            (v) =>
              `<p class="meta">${escapeText(v.projectId)} / ${escapeText(v.role)} / ${escapeText(v.versionLabel)} · ${escapeText(v.status)} · ${escapeText(v.contentHash?.slice(0, 8))}</p>`,
          )
          .join('') || '<p class="meta">Версий нет</p>'
      }`;
  } else {
    body = '<p class="meta">Загрузка…</p>';
  }

  return `
    <section class="analytics" aria-label="Аналитика">
      <div class="panel-head">
        <h2>Аналитика</h2>
        <button type="button" class="panel-refresh" id="refresh">Обновить</button>
      </div>
      ${renderAnalyticsSubnav(tab)}
      <div class="toolbar-group toolbar-filters" style="margin:0.75rem 0">
        <select id="project-filter" aria-label="Проект">
          <option value="">Все проекты</option>
          ${projects
            .map(
              (item) =>
                `<option value="${escapeText(item.id)}" ${item.id === project ? 'selected' : ''}>${escapeText(item.title || item.id)}</option>`,
            )
            .join('')}
        </select>
      </div>
      ${body}
    </section>`;
}

function renderLogin(message = '') {
  closeModal();
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
      if (error.status === 401 || error.body?.error === 'invalid_credentials') {
        renderLogin(PUBLIC_ERROR.wrong_password);
        return;
      }
      renderLogin(publicErrorMessage(error, 'login_boot'));
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
  if (tone === 'missed' || tone === 'problems')
    return n > 0 ? 'week-kpi--danger' : 'week-kpi--muted';
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
  if (tone === 'uncertain' || tone === 'delayed')
    return 'week-stat-value week-stat-value--warn week-stat-value--emphasis';
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

let cachedClassicScrollbarWidth;

function measureClassicScrollbarWidth() {
  if (cachedClassicScrollbarWidth != null) return cachedClassicScrollbarWidth;
  const outer = document.createElement('div');
  outer.style.cssText =
    'visibility:hidden;overflow:scroll;width:100px;height:100px;position:absolute;top:-9999px';
  document.documentElement.appendChild(outer);
  const inner = document.createElement('div');
  inner.style.width = '100%';
  outer.appendChild(inner);
  cachedClassicScrollbarWidth = Math.max(0, outer.offsetWidth - inner.offsetWidth);
  outer.remove();
  return cachedClassicScrollbarWidth;
}

function pageHasVerticalScroll() {
  const doc = document.documentElement;
  return doc.scrollHeight > doc.clientHeight + 1;
}

function liveScrollbarWidth() {
  return Math.max(0, window.innerWidth - document.documentElement.clientWidth);
}

function syncPageScrollbarPadding() {
  if (!state.authenticated || document.body.classList.contains('modal-open')) return;
  const doc = document.documentElement;
  if (!pageHasVerticalScroll()) {
    doc.style.paddingRight = `${measureClassicScrollbarWidth()}px`;
  } else {
    doc.style.paddingRight = '';
  }
}

let scrollbarSyncBound = false;

function ensureScrollbarSync() {
  if (scrollbarSyncBound) return;
  scrollbarSyncBound = true;
  window.addEventListener('resize', () => {
    cachedClassicScrollbarWidth = undefined;
    syncPageScrollbarPadding();
  });
}

function closeModal() {
  // Always release the scroll lock, even if navigation already removed the DOM.
  document.body.classList.remove('modal-open');
  document.body.style.paddingRight = '';
  const modal = document.getElementById('modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
  }
  syncPageScrollbarPadding();
  const body = document.getElementById('modal-body');
  if (body) body.innerHTML = '';
}

function openModal() {
  const modal = document.getElementById('modal');
  if (!modal) return;
  const scrollbarCompensation = pageHasVerticalScroll() ? liveScrollbarWidth() : 0;
  if (scrollbarCompensation > 0) {
    document.body.style.paddingRight = `${scrollbarCompensation}px`;
  }
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
}

let modalEscapeBound = false;

function ensureModalEscape() {
  if (modalEscapeBound) return;
  modalEscapeBound = true;
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
  });
}

function bindModal() {
  const backdrop = document.getElementById('modal-backdrop');
  const button = document.getElementById('modal-close');
  if (backdrop) backdrop.onclick = closeModal;
  if (button) button.onclick = closeModal;
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

let editorialFeedback = '';

function editorialDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Europe/Moscow',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date);
}

function renderEditorialSection(bundle) {
  const project = params().get('project') || '';
  const projects = bundle.projects || [];
  const overview = bundle.overview;
  const revision = bundle.revision || overview?.latestRevision;
  const memory = bundle.memory || [];
  const series = bundle.series || [];
  const diversity = bundle.diversity;

  let body;
  if (bundle.error) {
    body = `<p class="error-banner" role="alert">${escapeText(bundle.error)}</p>`;
  } else if (!project) {
    body =
      '<div class="editorial-empty"><h3>Сначала выберите сообщество</h3><p class="meta">Посмотрите историю публикаций и соберите план на следующую неделю. У каждого сообщества своя редакционная память.</p></div>';
  } else {
    const proposal = revision?.proposal;
    const pilot = overview?.pilotStats || {};
    body = `
      <div class="panel-head">
        <p class="meta">Память 30 дней: ${escapeText(overview?.memoryCount ?? memory.length)} · серии: ${escapeText(overview?.seriesCount ?? series.length)}</p>
        <button type="button" id="editorial-run-job">Собрать план недели</button>
      </div>
      <p class="meta">Пилот: решений ${escapeText(pilot.decisions ?? 0)}, принято ${escapeText(pilot.accepted ?? 0)}, отклонено ${escapeText(pilot.rejected ?? 0)}${pilot.acceptanceRate != null ? ` · доля ${(pilot.acceptanceRate * 100).toFixed(0)}%` : ''}</p>
      ${proposal?.metricsStale || proposal?.overview?.missingData ? `<p class="meta" role="status">${escapeText(proposal?.overview?.missingData || 'Метрики устарели — нужен явный пересчёт после импорта')}</p>` : ''}
      <h3>Обзор</h3>
      <p>${escapeText(proposal?.overview?.summary || 'Предложения ещё нет')}</p>
      <p class="meta">План собирается по истории и редакционным правилам. Изменения попадут в расписание после утверждения.</p>
      <h3>Редакционные решения</h3>
      <div class="editorial-decisions">
      <article class="card"><strong>Продолжить</strong>${(proposal?.continue || []).map((item) => `<p class="meta">${escapeText(item.rubricId || '—')}: ${escapeText(item.reason || '')}</p>`).join('') || '<p class="meta">—</p>'}</article>
      <article class="card"><strong>Временно убрать</strong>${(proposal?.pause || []).map((item) => `<p class="meta">${escapeText(item.reason || '')}${item.reviewAt ? ` · пересмотр ${escapeText(item.reviewAt)}` : ''}</p>`).join('') || '<p class="meta">—</p>'}</article>
      <article class="card"><strong>Новые форматы (2, ≤1 активен)</strong>${(proposal?.newFormats || []).map((item) => `<p class="meta">${escapeText(item.title)} · ${item.activate ? 'кандидат к активации' : 'резерв'} · ${escapeText(item.hypothesis || '')}</p>`).join('') || '<p class="meta">—</p>'}</article>
      <article class="card"><strong>Серии</strong>${(proposal?.series || []).map((item) => `<p class="meta">${escapeText(item.title || item.seriesId || '—')}: ${escapeText(item.goal || '')}</p>`).join('') || '<p class="meta">—</p>'}</article>
      <article class="card"><strong>Следующий материал</strong><p class="meta">${escapeText(proposal?.nextMaterial?.link || '—')}</p></article>
      </div>
      <h3>Публикации следующей недели</h3>
      <div class="editorial-calendar">
      ${
        (proposal?.calendar || [])
          .map(
            (item) =>
              `<article class="card"><div class="card-head"><strong>${escapeText(item.topic || '')}</strong><time class="meta" datetime="${escapeAttr(item.slotUtc || '')}">${escapeText(editorialDate(item.slotUtc))} МСК</time></div>
              <p>${escapeText(item.thesis || '')}</p>
              <details><summary>Основания предложения</summary><p class="meta">${(item.evidenceIds || []).map((id) => escapeText(id)).join(', ') || 'Редакционная гипотеза; статистики недостаточно'}</p></details></article>`,
          )
          .join('') || '<p class="meta">Нет доступных слотов</p>'
      }
      </div>
      ${revision?.diff?.changes?.length ? `<h3>Diff</h3>${revision.diff.changes.map((c) => `<p class="meta">${escapeText(c.kind)} · ${escapeText(c.planId)} · ${escapeText(c.topic || c.to?.topic || '')}</p>`).join('')}` : ''}
      ${
        revision?.status === 'proposed'
          ? `<div class="toolbar-group" style="margin:1rem 0;gap:0.5rem">
              <button type="button" id="editorial-approve" data-revision="${escapeAttr(revision.revisionId)}">Утвердить</button>
              <button type="button" id="editorial-reject" data-revision="${escapeAttr(revision.revisionId)}">Отклонить</button>
            </div>`
          : revision
            ? `<p class="meta">Статус revision: ${escapeText(revision.status)}</p>`
            : ''
      }
      <h3>Память / разнообразие</h3>
      <p class="meta">Повторы заходов: ${escapeText(diversity?.phrases?.repeatedOpenings?.length ?? 0)} · концовок: ${escapeText(diversity?.phrases?.repeatedClosings?.length ?? 0)}</p>
      ${(diversity?.findings || []).map((f) => `<p class="meta">${escapeText(f.label)} (${escapeText(f.evidenceKind)})</p>`).join('')}
      <h3>Серии в реестре</h3>
      ${series.map((s) => `<p class="meta">${escapeText(s.title)} · ${escapeText(s.status)}</p>`).join('') || '<p class="meta">Серий нет</p>'}
      <h3>История решений</h3>
      ${
        (overview?.revisions || [])
          .map(
            (r) =>
              `<p class="meta">${escapeText(r.weekStart)} r${escapeText(r.revisionNumber)} · ${escapeText(r.status)} · ${escapeText(r.createdAt || '')}</p>`,
          )
          .join('') || '<p class="meta">Пока пусто</p>'
      }`;
  }

  return `
    <section class="analytics editorial" aria-label="Редакция">
      <div class="panel-head">
        <div><h2>Редакция</h2><p class="meta">История, разнообразие и план на неделю</p></div>
        <button type="button" class="panel-refresh" id="refresh">Обновить</button>
      </div>
      <p id="editorial-feedback" class="editorial-feedback" role="status" aria-live="polite">${escapeText(editorialFeedback)}</p>
      <div class="toolbar-group toolbar-filters" style="margin:0.75rem 0">
        <select id="project-filter" aria-label="Проект">
          <option value="">Выберите проект</option>
          ${projects
            .map(
              (item) =>
                `<option value="${escapeText(item.id)}" ${item.id === project ? 'selected' : ''}>${escapeText(item.title || item.id)}</option>`,
            )
            .join('')}
        </select>
      </div>
      ${body}
    </section>`;
}

function renderOverview(data, incidents, errorMessage = '', tabBundle = null) {
  const retainedModal = document.body.classList.contains('modal-open')
    ? document.getElementById('modal')
    : null;
  const retainedFocus = retainedModal?.contains(document.activeElement)
    ? document.activeElement
    : null;
  const retainedScroll = retainedModal?.querySelector('#modal-body')?.scrollTop || 0;
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
        <div class="toolbar-group toolbar-nav" role="group" aria-label="Переключение недели">
          <button type="button" id="prev-week" aria-label="Предыдущая неделя">←</button>
          <button type="button" id="today-week">Сегодня</button>
          <button type="button" id="next-week" aria-label="Следующая неделя">→</button>
        </div>
        <h1 title="${escapeText(weekRangeIsoTitle(week.start, week.end))}">${escapeText(formatWeekRange(week.start, week.end))}</h1>
      </div>
      <div class="toolbar-controls">
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
  const analyticsPanel = isAnalyticsTab(tab)
    ? renderAnalyticsSection({
        ...(tabBundle?.analytics || tabBundle || {}),
        projects: data.projects || tabBundle?.projects || [],
      })
    : '';
  const editorialPanel = isEditorialTab(tab)
    ? renderEditorialSection({
        ...(tabBundle?.editorial || {}),
        projects: data.projects || [],
        error: tabBundle?.editorial?.error,
      })
    : '';

  app.className = 'cabinet';
  app.innerHTML = `
    ${renderSiteHeader(openCount, data)}
    ${errorMessage ? `<div class="error-banner" role="alert">${escapeText(errorMessage)}</div>` : ''}
    ${weekPanel}
    ${editorialPanel}
    ${analyticsPanel}
    ${incidentsPanel}
    ${servicePanel}`;

  // Refresh the calendar without destroying the active dialog, unsaved form,
  // detail request or its scroll position. Tab changes intentionally close it.
  if (retainedModal && tab === 'week') {
    document.getElementById('modal').replaceWith(retainedModal);
    document.getElementById('modal-body').scrollTop = retainedScroll;
    retainedFocus?.focus({ preventScroll: true });
  } else {
    closeModal();
  }

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
  } else if (isAnalyticsTab(tab)) {
    bindAnalyticsHandlers();
    document.getElementById('refresh').onclick = () => loadOverview(true);
  } else if (isEditorialTab(tab)) {
    bindEditorialHandlers();
    document.getElementById('refresh').onclick = () => loadOverview(true);
  } else {
    document.getElementById('refresh').onclick = () => loadOverview(true);
  }

  ensureScrollbarSync();
  requestAnimationFrame(() => syncPageScrollbarPadding());
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
    channel && channel !== '—' ? `<span class="slot-channel">${escapeText(channel)}</span>` : '';
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
    if (form.isConnected && form === document.getElementById('plan-form')) closeModal();
    await loadOverview(true);
  } catch (error) {
    alert(
      error.body?.error === 'version_conflict'
        ? PUBLIC_ERROR.version_conflict
        : PUBLIC_ERROR.save_failed,
    );
  }
}

async function loadSlotDetails(meta) {
  const extra = document.getElementById('modal-extra');
  if (!extra) return;

  if (meta.editionId) {
    try {
      const detail = await api(`/bot/api/v1/editions/${encodeURIComponent(meta.editionId)}`);
      const releaseBadge =
        detail.adHoc && detail.releaseLabel
          ? `<span class="release-badge">${escapeText(detail.releaseLabel)}</span>`
          : '';
      const metaRows = [
        ['Статус', detail.edition.statusLabel],
        detail.edition.brief ? ['Бриф', detail.edition.brief] : null,
        detail.edition.models ? ['Модели', JSON.stringify(detail.edition.models)] : null,
        detail.edition.costUsd != null ? ['Расход', `$${detail.edition.costUsd}`] : null,
        detail.edition.promptVersion ? ['Промпт', detail.edition.promptVersion] : null,
      ]
        .filter(Boolean)
        .map(([label, value]) => `<dt>${escapeText(label)}</dt><dd>${escapeText(value)}</dd>`)
        .join('');
      const deliveryRows = detail.deliveries
        .map((delivery) => {
          const link = delivery.vkUrl
            ? ` <a href="${escapeText(delivery.vkUrl)}" rel="noopener noreferrer">VK</a>`
            : '';
          const reason = delivery.failureReason ? ` — ${escapeText(delivery.failureReason)}` : '';
          return `<p class="meta">${escapeText(delivery.platform)}: ${escapeText(delivery.statusLabel)}${reason}${link}</p>`;
        })
        .join('');
      extra.innerHTML = `
      <h3 class="modal-section">${releaseBadge ? `${releaseBadge} · ` : ''}Выпуск</h3>
      <dl class="modal-detail-grid">${metaRows}</dl>
      <div class="modal-post-text">${escapeText(detail.edition.bodyText || detail.edition.bodyNotice || 'Текст пока не сохранён')}</div>
      ${deliveryRows}
      ${
        detail.events?.length
          ? `<div class="modal-history"><h3 class="modal-section">История</h3>${detail.events.map((event) => `<p class="meta">${escapeText(event.createdAt)} · ${escapeText(event.stage)} · ${escapeText(event.message)}</p>`).join('')}</div>`
          : ''
      }`;
    } catch (error) {
      extra.innerHTML = `<p class="error-banner" role="alert">${escapeText(publicErrorMessage(error, 'edition'))}</p>`;
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

async function editorialAction(button, request, successText) {
  const label = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = 'Выполняется…';
  editorialFeedback = '';
  try {
    const result = await request();
    editorialFeedback = result.redisSyncErrors?.length
      ? 'План сохранён, но часть задач не обновлена в очереди. Проверьте календарь перед публикацией.'
      : successText;
    if (result.blocked?.length)
      editorialFeedback += ` Не изменено слотов: ${result.blocked.length}. Проверьте основания в плане.`;
    await loadOverview(true);
  } catch (error) {
    editorialFeedback = `Не удалось выполнить действие: ${error.message}. Обновите страницу и повторите попытку.`;
    const feedback = document.getElementById('editorial-feedback');
    if (feedback) feedback.textContent = editorialFeedback;
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = label;
    }
  }
}

function bindEditorialHandlers() {
  document.getElementById('project-filter')?.addEventListener('change', (event) => {
    setParam('project', event.target.value);
    loadOverview(true);
  });
  document.getElementById('editorial-run-job')?.addEventListener('click', async (event) => {
    const projectId = params().get('project');
    if (!projectId) {
      alert('Выберите проект');
      return;
    }
    await editorialAction(
      event.currentTarget,
      () =>
        api('/bot/api/v1/editorial/jobs', {
          method: 'POST',
          body: JSON.stringify({ projectId, mode: 'preview' }),
        }),
      'Предложение готово. Проверьте темы и утвердите план.',
    );
  });
  document.getElementById('editorial-approve')?.addEventListener('click', async (event) => {
    const revisionId = event.currentTarget.dataset.revision;
    if (!revisionId) return;
    await editorialAction(
      event.currentTarget,
      () =>
        api(`/bot/api/v1/editorial/revisions/${encodeURIComponent(revisionId)}/decide`, {
          method: 'POST',
          body: JSON.stringify({ decision: 'approve' }),
        }),
      'План утверждён для доступных будущих публикаций.',
    );
  });
  document.getElementById('editorial-reject')?.addEventListener('click', async (event) => {
    const revisionId = event.currentTarget.dataset.revision;
    if (!revisionId) return;
    await editorialAction(
      event.currentTarget,
      () =>
        api(`/bot/api/v1/editorial/revisions/${encodeURIComponent(revisionId)}/decide`, {
          method: 'POST',
          body: JSON.stringify({ decision: 'reject' }),
        }),
      'Предложение отклонено.',
    );
  });
}

function bindAnalyticsHandlers() {
  app.querySelectorAll('[data-analytics-tab]').forEach((node) => {
    node.addEventListener('click', () => {
      setParam('tab', node.dataset.analyticsTab);
      loadOverview(true);
    });
  });
  document.getElementById('project-filter')?.addEventListener('change', (event) => {
    setParam('project', event.target.value);
    loadOverview(true);
  });
  const form = document.getElementById('import-form');
  if (form) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const fd = new FormData(form);
      const file = fd.get('file');
      if (!(file instanceof File)) return;
      const content = await file.text();
      const observedLocal = String(fd.get('observedAt') || '');
      const observedAt = observedLocal
        ? new Date(observedLocal).toISOString()
        : new Date().toISOString();
      const previewEl = document.getElementById('import-preview');
      try {
        const preview = await api('/bot/api/v1/imports/preview', {
          method: 'POST',
          body: JSON.stringify({
            projectId: fd.get('projectId'),
            vkGroupId: fd.get('vkGroupId'),
            observedAt,
            filename: file.name,
            content,
          }),
        });
        previewEl.innerHTML = `
          <p>Preview: valid ${escapeText(preview.preview?.validCount)} · errors ${escapeText(preview.preview?.errorCount)} · matched ${escapeText(preview.matchedCount)}</p>
          <button type="button" id="import-commit" data-import="${escapeAttr(preview.importId)}">Подтвердить импорт</button>
          ${preview.preview?.canCommitStrict ? '' : '<p class="meta">Есть ошибки — commit blocked в strict-режиме</p>'}`;
        document.getElementById('import-commit')?.addEventListener('click', async () => {
          const result = await api(`/bot/api/v1/imports/${preview.importId}/commit`, {
            method: 'POST',
            body: JSON.stringify({ mode: 'strict', confirmAnomalies: true }),
          });
          previewEl.innerHTML = `<p>Применено ${escapeText(result.applied)}, пропущено ${escapeText(result.skipped)}, ошибок ${escapeText(result.errors)}</p>`;
          loadOverview(true);
        });
      } catch (error) {
        previewEl.textContent = error.body?.message || error.message || 'import_failed';
      }
    });
  }
  document.getElementById('run-analysis')?.addEventListener('click', async () => {
    const projectId = params().get('project');
    if (!projectId) {
      alert('Выберите проект');
      return;
    }
    await api('/bot/api/v1/analysis-jobs', {
      method: 'POST',
      body: JSON.stringify({ projectId }),
    });
    loadOverview(true);
  });
  app.querySelectorAll('[data-decide]').forEach((node) => {
    node.addEventListener('click', async () => {
      const card = node.closest('[data-rec]');
      const id = card?.dataset.rec;
      if (!id) return;
      await api(`/bot/api/v1/recommendations/${id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision: node.dataset.decide }),
      });
      loadOverview(true);
    });
  });
}

async function loadAnalyticsBundle(project) {
  const q = project ? `?project=${encodeURIComponent(project)}` : '';
  const pq = project ? `?project=${encodeURIComponent(project)}` : '';
  const [overview, posts, imports, segments, recommendations, versions] = await Promise.all([
    api(`/bot/api/v1/analytics${q}`),
    api(`/bot/api/v1/analytics/posts${q}${q ? '&' : '?'}limit=50`),
    api(`/bot/api/v1/analytics/imports${pq}`),
    api(`/bot/api/v1/analytics/segments${q}`),
    api(`/bot/api/v1/recommendations${pq}`),
    api(`/bot/api/v1/prompt-versions${pq}`),
  ]);
  return {
    overview,
    posts,
    imports,
    segments,
    recommendations: recommendations.recommendations || [],
    versions: versions.versions || [],
  };
}

async function loadEditorialBundle(project) {
  if (!project) {
    return { overview: null, memory: [], series: [], diversity: null, revision: null };
  }
  const q = `?project=${encodeURIComponent(project)}`;
  const [overview, memoryPayload, seriesPayload] = await Promise.all([
    api(`/bot/api/v1/editorial${q}`),
    api(`/bot/api/v1/editorial/memory${q}`),
    api(`/bot/api/v1/editorial/series${q}`),
  ]);
  let revision = overview.latestRevision || null;
  const revisionParam = params().get('revision');
  if (revisionParam) {
    revision = await api(`/bot/api/v1/editorial/revisions/${encodeURIComponent(revisionParam)}`);
  }
  return {
    overview,
    memory: memoryPayload.items || [],
    diversity: memoryPayload.diversity || null,
    series: seriesPayload.series || [],
    revision,
  };
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
      api(
        `/bot/api/v1/incidents?${project ? `project=${encodeURIComponent(project)}&` : ''}status=open`,
      ),
    ]);
    if (state.dataVersion && overview.data_version < state.dataVersion && !manual) {
      overview.service = { ...(overview.service || {}), stale: true };
    }
    state.dataVersion = overview.data_version;
    let tabBundle = null;
    if (isAnalyticsTab()) {
      try {
        tabBundle = await loadAnalyticsBundle(project);
      } catch (error) {
        tabBundle = { error: error.message };
      }
    } else if (isEditorialTab()) {
      try {
        tabBundle = { editorial: await loadEditorialBundle(project) };
      } catch (error) {
        tabBundle = { editorial: { error: error.message } };
      }
    }
    renderOverview(overview, incidents, '', tabBundle);
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
      publicErrorMessage(error, 'overview'),
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
      renderLogin(publicErrorMessage(null, 'login_boot'));
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
    renderLogin(publicErrorMessage(null, 'login_boot'));
  }
}

boot();
