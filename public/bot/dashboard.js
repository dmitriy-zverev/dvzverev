import { openPanel, closePanel, resizeFields } from './panels.js';
import { icon } from './icons.js';
import { createOzonComposer } from './ozon.js';
import { createRubricManager } from './rubrics.js';

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
const rubricManager = createRubricManager({
  api,
  escapeText,
  refresh: (result) => {
    if (result?.removed && params().get('rubric') === result.id) setParam('rubric', '');
    return loadOverview(true);
  },
  selectProject: (id) => {
    setParam('project', id);
    setParam('rubric', '');
    loadOverview(true);
  },
});
const ozonComposer = createOzonComposer({
  api,
  apiBase,
  escapeText,
  projectTitle: (id) => state.ozonProjects?.find((p) => p.id === id)?.title || id,
});

const state = {
  authenticated: false,
  refreshMs: 30000,
  backoffMs: 30000,
  timer: null,
  dataVersion: null,
  vk: null,
  weekly: null,
  preparing: false,
  preparationError: null,
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
  ozonComposer.close();
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
      'rubrics',
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
      ${icon('warning')}
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
      <button type="button" class="cabinet-tab${tab === 'rubrics' ? ' is-active' : ''}" data-tab="rubrics" aria-current="${tab === 'rubrics' ? 'page' : 'false'}">Рубрики</button>
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
          <span class="cabinet-brand-mark" aria-hidden="true">Р.</span>
          <h1 class="cabinet-header-title">Редакционный кабинет</h1>
        </div>
        <div class="cabinet-header-actions">
          <button type="button" class="cabinet-header-home" id="ozon-open">Выпустить рекламный пост</button>
          ${data ? renderStaleIndicator(Boolean(data.service?.stale)) : ''}
          ${data ? renderHeartbeatPill(data) : ''}
          ${renderOwnerVkHeaderControl()}
          <a class="cabinet-header-home" href="/">На сайт</a>
          <button type="button" class="cabinet-header-logout" id="logout">Выйти</button>
        </div>
        ${renderCabinetTabs(openCount)}
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
      ${renderVkConnection()}
      <div class="service-health ${heartbeat.ok ? 'is-healthy' : 'is-degraded'}"><span class="health-light" aria-hidden="true"></span><div><strong>${heartbeat.ok ? 'Планировщик на связи' : 'Нет подтверждения работы планировщика'}</strong><p class="meta">${heartbeat.ok ? 'Сигнал работы получен. Результаты публикаций смотрите в календаре.' : 'Проверьте контейнер и журнал ошибок перед следующей публикацией.'}</p></div></div>
      <div class="service-metrics"><article class="card"><h3>Последний сигнал</h3><p>${escapeText(editorialDate(heartbeat.updatedAt))}</p>
        ${heartbeat.ageSeconds != null ? `<p class="meta">Получен ${escapeText(heartbeat.ageSeconds)} с назад</p>` : ''}
      </article><article class="card"><h3>Планировщик</h3><p>${escapeText(editorialDate(data.scheduler_last_seen_at))}</p></article><article class="card"><h3>Данные кабинета</h3><p>${escapeText(editorialDate(data.as_of))}</p><span class="meta">Версия ${escapeText(data.data_version ?? '—')} · время Москвы</span></article></div>
      ${
        Object.keys(data.service?.pauses || {}).length
          ? `<details class="card"><summary>Приостановленные публикации</summary><pre>${escapeText(JSON.stringify(data.service.pauses, null, 2))}</pre></details>`
          : '<p class="service-note">Приостановленных публикаций нет</p>'
      }
      ${
        (data.service?.cooldowns || []).length
          ? `<details class="card"><summary>Ожидание перед повторной попыткой</summary><pre>${escapeText(JSON.stringify(data.service.cooldowns, null, 2))}</pre></details>`
          : '<p class="service-note">Активных задержек повторной отправки нет</p>'
      }
      ${
        data.service?.reports
          ? `<article class="card report-status"><h3>Отчёты в Telegram</h3><p>В очереди: <strong>${escapeText(data.service.reports.pending)}</strong> · с ошибкой: <strong>${escapeText(data.service.reports.failed)}</strong></p><p class="meta">Режим: ${escapeText({ scheduled: 'По расписанию', enabled: 'Включены', disabled: 'Выключены', outbox: 'Через очередь' }[data.service.reports.mode] || data.service.reports.mode)}
        ${data.service.reports.lastSentAt ? ` · последняя отправка ${escapeText(editorialDate(data.service.reports.lastSentAt))}` : ' · отправок пока нет'}
        ${data.service.reports.lastHeadline ? ` · ${escapeText(data.service.reports.lastHeadline)}` : ''}</p></article>`
          : ''
      }
    </section>`;
}

function ownerCanPhoto(owner = state.vk?.ownerOAuth) {
  return Boolean(owner?.canPhoto || owner?.canPrepare);
}

function ownerMissingRights(owner = state.vk?.ownerOAuth) {
  return Array.isArray(owner?.missingRights) ? owner.missingRights : [];
}

function renderVkRightsList(owner) {
  const rights = owner?.rights || {};
  const rows = [
    ['wall', 'wall'],
    ['photos', 'photos'],
    ['groups', 'groups'],
    ['video', 'video'],
    ['offline', 'offline'],
  ];
  return `<ul class="vk-rights" aria-label="Права owner VK">${rows
    .map(([key, label]) => {
      const ok = rights[key] === true;
      return `<li class="${ok ? 'is-ok' : 'is-missing'}"><span class="vk-right-mark" aria-hidden="true">${icon(ok ? 'check' : 'close')}</span>${escapeText(label)}</li>`;
    })
    .join('')}</ul>`;
}

function renderOwnerVkHeaderControl() {
  const owner = state.vk?.ownerOAuth;
  if (owner?.available) {
    const connected = owner.connected;
    const canPhoto = ownerCanPhoto(owner);
    const missing = ownerMissingRights(owner);
    const label = connected ? (canPhoto ? 'VK · фото ок' : 'VK · без photos') : 'Войти в VK';
    const status = connected
      ? canPhoto
        ? `Owner VK · ID ${owner.userId}`
        : `Owner VK · ID ${owner.userId} · нет: ${missing.join(', ') || 'wall/photos/groups'}`
      : 'Owner VK не подключён';
    return `<span class="vk-owner-pill ${connected ? (canPhoto ? 'is-ready' : 'is-limited') : 'is-off'}" title="${escapeAttr(status)}">${escapeText(status)}</span>
    <a class="cabinet-header-home vk-login" href="${escapeAttr(apiBase)}/bot/api/v1/vk/legacy/login">${escapeText(label)}</a>`;
  }
  if (state.vk?.mode === 'community') return '';
  return `<a class="cabinet-header-home vk-login" href="${escapeAttr(apiBase)}/bot/api/v1/vk/legacy/login">${state.vk?.connected ? 'Переподключить VK' : 'Войти в VK'}</a>`;
}

function renderVkOauthFeedback() {
  const flag = params().get('vk');
  if (!flag) return '';
  const reason = params().get('reason') || '';
  const owner = state.vk?.ownerOAuth;
  const appId = escapeText(owner?.clientId || 'VK');
  if (flag === 'connected') {
    const canPhoto = ownerCanPhoto(owner);
    const missing = ownerMissingRights(owner);
    return `<div class="vk-feedback ${canPhoto ? 'is-success' : 'is-warning'}" role="status">
      <div><strong>${canPhoto ? 'Owner VK подключён' : 'Owner VK без photo-прав'}</strong>
      <p class="meta">ID ${escapeText(owner?.userId || '—')} · app ${appId} · ${escapeText(owner?.grantedScope || 'scope?')}</p>
      ${renderVkRightsList(owner)}
      <p class="meta">${canPhoto ? 'Photo-загрузка доступна.' : `Нет: ${escapeText(missing.join(', ') || 'wall, photos, groups')}. Неделя — community GIF.`}</p></div>
      <button type="button" class="cabinet-header-home" id="vk-feedback-dismiss">Закрыть</button>
    </div>`;
  }
  if (flag === 'error') {
    const messages = {
      vk_oauth_wall_photos_groups_required: `Приложение ${appId} не получило wall, photos и groups. Повторный вход без смены доступов в кабинете VK ID не поможет. Посты недели идут community GIF.`,
      vk_oauth_refresh_token_missing:
        'VK не выдал refresh_token. Owner-подключение не сохранено. Community-посты не затронуты.',
      vk_oauth_exchange_rejected_invalid_scope:
        'VK запретил запрошенные права. Проверьте доступы приложения.',
      vk_oauth_exchange_rejected_invalid_client:
        'VK отклонил клиент приложения. Проверьте VK ID и Redirect URI.',
      vk_oauth_consent_denied: 'Доступ в VK не разрешён. Подключение не сохранено.',
      vk_oauth_invalid_state: 'Сессия входа истекла. Начните вход заново из кабинета.',
      vk_oauth_wrong_user: 'Нужен аккаунт владельца кабинета.',
    };
    return `<div class="vk-feedback is-error" role="alert">
      <div><strong>Owner VK не подключён</strong>
      <p class="meta">${escapeText(messages[reason] || 'Операция VK не завершена. Подробности в журнале кабинета.')}</p></div>
      <a class="cabinet-header-home vk-login" href="${escapeAttr(apiBase)}/bot/api/v1/vk/legacy/login">Повторить вход</a>
      <button type="button" class="cabinet-header-home" id="vk-feedback-dismiss">Закрыть</button>
    </div>`;
  }
  return '';
}

function renderOwnerOAuthCard(owner) {
  if (!owner?.available) return '';
  const connected = owner.connected;
  const canPhoto = ownerCanPhoto(owner);
  const missing = ownerMissingRights(owner);
  return `<article class="card vk-connection ${connected ? (canPhoto ? 'is-ready' : 'is-limited') : 'is-off'}" aria-label="Owner OAuth VK">
    <div><h3>Аккаунт владельца VK</h3><p>${connected ? `Подключён · ID ${escapeText(owner.userId)}` : 'Не подключён'}</p>
    ${
      connected
        ? `<p class="meta">${owner.refreshAvailable ? 'Refresh ок' : 'Без refresh'} · до ${escapeText(editorialDate(owner.expiresAt))} · ${escapeText(owner.grantedScope || 'scope?')}</p>
    ${renderVkRightsList(owner)}
    <p class="meta">${canPhoto ? 'wall+photos+groups ок.' : `Нет: ${escapeText(missing.join(', ') || 'wall, photos, groups')}. Нужны доступы в VK ID.`}</p>
    <p class="meta">Неделя пока community GIF.</p>`
        : `<p class="meta">App ${escapeText(owner.clientId || 'VK')}: вход для photo. Сейчас текст + GIF.</p>`
    }</div>
    <div class="vk-connection-actions">
      <a class="cabinet-header-home vk-login" href="${escapeAttr(apiBase)}/bot/api/v1/vk/legacy/login">${connected ? 'Переподключить' : 'Войти в VK'}</a>
      ${connected ? `<button type="button" class="cabinet-header-home" id="vk-owner-capabilities">Проверить photos API</button>` : ''}
    </div>
    <pre class="vk-capabilities-out" id="vk-owner-capabilities-out" hidden></pre>
  </article>`;
}

function renderVkConnection() {
  const vk = state.vk;
  if (vk?.mode === 'community') {
    const ready = vk.canPrepare;
    return `<article class="card vk-connection" aria-label="Подключение VK">
    <div><h3>VK для недельных публикаций</h3><p>${ready ? 'Ключи сообществ настроены на сервере' : 'Не хватает ключей сообществ в конфигурации сервера'}</p>
    <p class="meta">${ready ? 'Недельная подготовка: community-токены, текст + GIF-документ на стену.' : 'Проверьте community-токены и ID групп в production env.'}</p></div>
  </article>${renderOwnerOAuthCard(vk.ownerOAuth)}`;
  }
  const connected = vk?.connected;
  return `<article class="card vk-connection" aria-label="Подключение VK">
    <div><h3>Аккаунт VK</h3><p>${connected ? `Подключён · ID ${escapeText(vk.userId)}` : vk?.unavailable ? 'Не удалось проверить подключение' : 'Аккаунт не подключён'}</p>
    ${connected ? `<p class="meta">${vk.refreshAvailable ? 'Автоматическое обновление токена включено' : 'Для обновления токена нужен повторный вход'} · действует до ${escapeText(editorialDate(vk.expiresAt))}</p><p class="meta">Выданные права: ${escapeText(vk.grantedScope || 'не указаны VK')}. ${vk.canPrepare ? 'Права wall, photos и groups проверены' : 'Вход не подтверждает доступ к публикациям'}.</p>` : '<p class="meta">Войдите через VK, чтобы сохранить подключение на сервере.</p>'}</div>
    <a class="cabinet-header-home vk-login" href="${escapeAttr(apiBase)}/bot/api/v1/vk/legacy/login">${connected ? 'Переподключить VK' : 'Войти в VK'}</a>
  </article>`;
}

function renderIncidentsSection(incidents, projects = []) {
  return `
    <section class="incidents" aria-label="Ошибки">
      <div class="panel-head">
        <h2>Инциденты</h2>
        <button type="button" class="panel-refresh" id="refresh">Обновить</button>
      </div>
      ${
        incidents.items?.length
          ? incidents.items
              .map(
                (item) =>
                  `<article class="card incident-card"><div class="card-head"><strong>${escapeText(projects.find((p) => p.id === item.projectId)?.title || item.projectId || 'Сервис')}</strong><span class="incident-count">Повторов: ${escapeText(item.count ?? 1)}</span></div><p>${escapeText(item.message)}</p><p class="meta">Последний случай: ${escapeText(editorialDate(item.lastSeenAt))} МСК</p><details><summary>Технические сведения</summary><p class="meta">Этап: ${escapeText(item.stage || '—')}</p></details></article>`,
              )
              .join('')
          : `<div class="workspace-empty"><span class="empty-symbol" aria-hidden="true">${icon('check')}</span><h3>Открытых инцидентов нет</h3><p class="meta">Новые ошибки появятся здесь после записи в журнал сервиса.</p></div>`
      }
    </section>`;
}

function renderAnalyticsSubnav(tab) {
  const items = [
    ['analytics', 'Обзор 30 дней'],
    ['analytics-posts', 'Все посты'],
    ['analytics-imports', 'Импорты и покрытие'],
    ['analytics-segments', 'Сегменты'],
    ['analytics-prompts', 'Рекомендации и промпты'],
  ];
  return `
    <nav class="analytics-subnav" aria-label="Аналитика">
      ${items
        .map(
          ([id, label]) =>
            `<button type="button" class="cabinet-tab${tab === id ? ' is-active' : ''}" ${tab === id ? 'aria-current="page"' : ''} data-analytics-tab="${id}">${escapeText(label)}</button>`,
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
  const projectTitle = (id) => projects.find((p) => p.id === id)?.title || id;
  const ranking = (items) =>
    items
      .map(
        (p, index) =>
          `<article class="ranking-row"><span class="ranking-position">${index + 1}</span><div><strong>${escapeText(p.bodyText?.slice(0, 100) || 'Публикация')}</strong><details><summary>Идентификатор материала</summary><span class="meta">${escapeText(p.editionId)}</span></details></div><span class="ranking-value">${escapeText(p.reachOrganic ?? '—')}<small>охват</small></span></article>`,
      )
      .join('') || '<p class="meta">Нет публикаций с загруженной статистикой</p>';

  let body;
  if (bundle.error) {
    body = `<p class="error-banner" role="alert">${escapeText(bundle.error)}</p>`;
  } else if (tab === 'analytics' && overview) {
    const cov = overview.coverage || {};
    body = `
      <p class="meta">Последние 30 дней · время Москвы. Отсутствующие метрики не считаются нулём.</p>
      <p>Покрытие: ${escapeText(cov.withMetrics ?? 0)} из ${escapeText(cov.sent ?? 0)} отправленных
        ${cov.ratio != null ? `(${escapeText(Math.round(cov.ratio * 100))}%)` : ''}</p>
      <p class="meta">${escapeText(overview.definitions?.reachVsViews || '')}</p>
      <div class="week-stats-kpis" role="list" aria-label="Показатели за 30 дней">
        ${renderWorkspaceKpi('Медианный охват', overview.summary?.organicReach?.median ?? '—')}
        ${renderWorkspaceKpi('Вовлечённость', overview.summary?.engagementRate?.median != null ? `${(Number(overview.summary.engagementRate.median) * 100).toFixed(1)}%` : '—')}
        ${renderWorkspaceKpi('Доставка', overview.summary?.deliverySuccess?.ratio != null ? `${Math.round(overview.summary.deliverySuccess.ratio * 100)}%` : '—')}
      </div>
      <div class="ranking-columns"><div><h3>Самый высокий охват</h3>${ranking(overview.top || [])}</div><div><h3>Что требует внимания</h3>${ranking(overview.bottom || [])}</div></div>`;
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
                  ? `${(Number(p.derived.engagement.value) * 100).toFixed(1)}%`
                  : '—';
              const notice = p.bodyNotice || (p.bodyText ? p.bodyText.slice(0, 80) : '—');
              return `<article class="card"><div class="card-head"><strong>${escapeText(projectTitle(p.projectId))}</strong><span class="meta">${escapeText(editorialDate(p.publishedAt))} МСК</span></div>
              <p>${escapeText(notice)}</p>
              <p class="post-metrics"><span>Охват <strong>${escapeText(reach)}</strong></span><span>Вовлечённость <strong>${escapeText(eng)}</strong></span><span>${escapeText(p.mediaActual === 'none' || !p.mediaActual ? 'Текст' : p.mediaActual.toUpperCase())}</span>${p.metrics?.promoted ? '<span>С продвижением</span>' : ''}</p>
              <details><summary>Версия промпта и возраст публикации</summary><p class="meta">${escapeText(p.promptVersion || '—')} · ${escapeText(p.ageBucket || '—')}</p></details>
              ${safeVkLink(p.vkUrl)}</article>`;
            })
            .join('') || '<p class="meta">Нет постов в окне</p>'
        }
      </div><div class="posts-pagination" aria-label="Страницы публикаций"><button type="button" data-posts-cursor="${Math.max(0, (Number(params().get('cursor')) || 0) - 50)}" ${Number(params().get('cursor')) > 0 ? '' : 'disabled'}>Назад</button><span class="meta">Показано ${escapeText(posts.items?.length ?? 0)} из ${escapeText(posts.total ?? 0)}</span><button type="button" data-posts-cursor="${escapeAttr(posts.nextCursor ?? '')}" ${posts.nextCursor == null ? 'disabled' : ''}>Далее</button></div>`;
  } else if (tab === 'analytics-imports') {
    body = `
      <form id="import-form" class="login-form">
        <label>Проект
          <select name="projectId" required>
            <option value="">—</option>
            ${projects.map((p) => `<option value="${escapeAttr(p.id)}" ${p.id === project ? 'selected' : ''}>${escapeText(p.title || p.id)}</option>`).join('')}
          </select>
        </label>
        <label>ID сообщества VK <input name="vkGroupId" required inputmode="numeric" pattern="[0-9]+" placeholder="Числовой ID без минуса"></label>
        <label>Дата снятия статистики · Москва <input name="observedAt" type="datetime-local" required></label>
        <label>Файл CSV/JSON <input name="file" type="file" accept=".csv,.json,text/csv,application/json" required></label>
        <p class="meta">Пустая ячейка = «нет данных», не ноль. Шаблон: <a href="${escapeAttr(apiBase)}/bot/api/v1/imports/template">скачать</a></p>
        <button type="submit">Проверить файл</button>
      </form>
      <div id="import-preview"></div>
      <h3>Покрытие</h3>
      <p class="meta">С метриками: ${escapeText(imports?.coverage?.withMetrics ?? 0)} / ${escapeText(imports?.coverage?.sent ?? 0)}</p>
      ${
        (imports?.imports || [])
          .map(
            (item) =>
              `<article class="card"><div class="card-head"><strong>${escapeText(workspaceStatus(item.status))}</strong><span class="meta">${escapeText(editorialDate(item.createdAt))} МСК</span></div>
              <p class="post-metrics"><span>Строк <strong>${escapeText(item.rowCount)}</strong></span><span>Сопоставлено <strong>${escapeText(item.matchedCount)}</strong></span><span>Ошибок <strong>${escapeText(item.errorCount)}</strong></span></p><details><summary>Идентификатор импорта</summary><p class="meta">${escapeText(item.importId)}</p></details></article>`,
          )
          .join('') || '<p class="meta">Импортов пока нет</p>'
      }`;
  } else if (tab === 'analytics-segments' && segments) {
    body =
      Object.entries(segments.segments || [])
        .map(([name, list]) => {
          return `<h3>${escapeText({ byTopic: 'Темы публикаций', byMedia: 'Оформление', byPromptVersion: 'Версии промптов', byAgeBucket: 'Возраст публикации', byOrganicPaid: 'Продвижение', byModel: 'Текстовые модели' }[name] || name)}</h3><div class="segment-grid">${
            (list || [])
              .map(
                (s) =>
                  `<article class="card"><strong>${escapeText({ none: 'Текст', organic: 'Без продвижения', paid: 'С продвижением', unknown: 'Не указано' }[s.key] || projectTitle(s.key))}</strong><p class="meta">Постов: ${escapeText(s.posts)} · покрытие ${escapeText(s.coverageRatio != null ? Math.round(s.coverageRatio * 100) + '%' : '—')}</p><p>Медианный охват: <strong>${escapeText(s.organicReach?.median ?? '—')}</strong></p>${s.note ? `<p class="meta">${escapeText(s.note)}</p>` : ''}</article>`,
              )
              .join('') || '<p class="meta">Пока нет данных для сравнения</p>'
          }</div>`;
        })
        .join('') || '<p class="meta">Нет сегментов</p>';
    body += `<p class="meta">${escapeText(segments.caution || '')}</p>`;
  } else if (tab === 'analytics-prompts') {
    body = `
      <div class="panel-head"><h3>Рекомендации</h3>
        <button type="button" id="run-analysis" ${project ? '' : 'disabled'}>Запустить анализ</button></div>${project ? '' : '<p class="meta">Выберите сообщество, чтобы запустить анализ.</p>'}
      ${
        recommendations
          .map(
            (r) => `<article class="card" data-rec="${escapeAttr(r.recommendationId)}">
            <div class="card-head"><strong>${escapeText(workspaceStatus(r.status))}</strong><span class="meta">${escapeText(projectTitle(r.projectId))}</span></div>
            <p>${escapeText(r.observation)}</p>
            <details><summary>Материалы для анализа</summary><p class="meta">${(r.evidence || []).map((e) => escapeText(e.editionId)).join(', ') || 'Подтверждающих материалов пока нет'}</p></details>
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
              `<article class="card prompt-version"><div class="card-head"><strong>${escapeText(v.versionLabel || 'Без названия')}</strong><span class="version-status">${escapeText(workspaceStatus(v.status))}</span></div><p class="meta">${escapeText(projectTitle(v.projectId))} · ${escapeText({ editor: 'Редактор текста', cover: 'Обложка', video: 'Видео' }[v.role] || v.role)}</p><details><summary>Контрольная сумма</summary><p class="meta">${escapeText(v.contentHash)}</p></details></article>`,
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
      <p id="analytics-feedback" class="editorial-feedback" role="status" aria-live="polite"></p>
      <div class="workspace-content">${body}</div>
    </section>`;
}

function renderLogin(message = '') {
  ozonComposer.close();
  rubricManager.reset();
  closeModal();
  app.className = 'cabinet cabinet--gate';
  app.innerHTML = `
    <section class="login" aria-labelledby="login-title">
      <p class="login-eyebrow"><span aria-hidden="true">Р.</span> Редакция</p>
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
      <p class="login-footer"><a class="login-site-link" href="/">${icon('left')} На сайт</a></p>
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
  return title || (card.channel === 'vk' ? 'VK' : card.channel || '');
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

function closeModal() {
  const modal = document.getElementById('modal');
  document.body.classList.remove('modal-open');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  closePanel(modal);
  document.getElementById('modal-body')?.replaceChildren();
}

function openModal() {
  const modal = document.getElementById('modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  openPanel(modal, closeModal);
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
  const kind = escapeText(
    { image: 'Фото', text: 'Текст', video: 'Видео' }[meta.publicationKind] ||
      meta.publicationKind ||
      '—',
  );
  const channel = escapeText(meta.channel || '');
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
  if (!value) return '—';
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

function workspaceStatus(value) {
  return (
    {
      proposed: 'На рассмотрении',
      approved: 'Утверждено',
      rejected: 'Отклонено',
      active: 'Активно',
      draft: 'Черновик',
      archived: 'В архиве',
      committed: 'Импортировано',
      preview: 'Проверено',
      failed: 'Ошибка',
      completed: 'Завершено',
      paused: 'Приостановлено',
      rolled_back: 'Отменено',
    }[value] ||
    value ||
    '—'
  );
}

function renderWorkspaceKpi(label, value) {
  return `<div class="week-kpi" role="listitem"><span class="week-kpi-value">${escapeText(value)}</span><span class="week-kpi-label">${escapeText(label)}</span></div>`;
}

function safeVkLink(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !['vk.com', 'vk.ru', 'www.vk.com', 'www.vk.ru'].includes(url.hostname)
    )
      return '';
    return `<a class="post-source" href="${escapeAttr(url.href)}" target="_blank" rel="noopener noreferrer">Открыть публикацию ${icon('external')}</a>`;
  } catch {
    return '';
  }
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
      ${proposal ? '<h3>Редакционные решения</h3>' : '<div class="editorial-empty"><h3>Начните с плана недели</h3><p class="meta">Соберите предложение по истории сообщества. До утверждения расписание останется прежним.</p></div>'}
      <div ${proposal ? '' : 'hidden'}>
      <div class="editorial-decisions">
      <article class="card"><strong>Продолжить</strong>${(proposal?.continue || []).map((item) => `<p class="meta">${escapeText(item.rubricId || '—')}: ${escapeText(item.reason || '')}</p>`).join('') || '<p class="meta">—</p>'}</article>
      <article class="card"><strong>Временно убрать</strong>${(proposal?.pause || []).map((item) => `<p class="meta">${escapeText(item.reason || '')}${item.reviewAt ? ` · пересмотр ${escapeText(item.reviewAt)}` : ''}</p>`).join('') || '<p class="meta">—</p>'}</article>
      <article class="card"><strong>Новые форматы</strong><p class="meta">Два варианта · один активный эксперимент</p>${(proposal?.newFormats || []).map((item) => `<p class="meta">${escapeText(item.title)} · ${item.activate ? 'кандидат к активации' : 'резерв'} · ${escapeText(item.hypothesis || '')}</p>`).join('') || '<p class="meta">Нет предложений</p>'}</article>
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
      ${revision?.diff?.changes?.length ? `<details><summary>Изменения расписания · ${escapeText(revision.diff.changes.length)}</summary>${revision.diff.changes.map((c) => `<p class="meta">${escapeText(c.kind)} · ${escapeText(c.planId)} · ${escapeText(c.topic || c.to?.topic || '')}</p>`).join('')}</details>` : ''}
      ${
        revision?.status === 'proposed'
          ? `<div class="toolbar-group" style="margin:1rem 0;gap:0.5rem">
              <button type="button" id="editorial-approve" data-revision="${escapeAttr(revision.revisionId)}">Утвердить</button>
              <button type="button" id="editorial-reject" data-revision="${escapeAttr(revision.revisionId)}">Отклонить</button>
            </div>`
          : revision
            ? `<p class="meta">${escapeText(workspaceStatus(revision.status))}</p>`
            : ''
      }
      </div><h3>Разнообразие публикаций</h3>
      <p class="meta">Повторы заходов: ${escapeText(diversity?.phrases?.repeatedOpenings?.length ?? 0)} · концовок: ${escapeText(diversity?.phrases?.repeatedClosings?.length ?? 0)}</p>
      ${(diversity?.findings || []).map((f) => `<p class="meta">${escapeText(f.label)} (${escapeText(f.evidenceKind)})</p>`).join('')}
      <h3>Серии в реестре</h3>
      ${series.map((s) => `<article class="card"><strong>${escapeText(s.title)}</strong><p class="meta">${escapeText(workspaceStatus(s.status))}</p></article>`).join('') || '<p class="meta">Пока нет активных серий</p>'}
      <h3>История решений</h3>
      ${
        (overview?.revisions || [])
          .map(
            (r) =>
              `<article class="history-row"><strong>Неделя ${escapeText(r.weekStart)} · версия ${escapeText(r.revisionNumber)}</strong><span>${escapeText(workspaceStatus(r.status))}</span><time class="meta">${escapeText(editorialDate(r.createdAt))} МСК</time></article>`,
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

function renderWeeklyPreparation() {
  const batch = state.weekly;
  if (!batch)
    return `<section class="weekly-prepare"><p role="status">Не удалось проверить подготовку следующей недели.</p><p class="meta">Обновите страницу. Публикации не запускаются без проверки расписания.</p></section>`;
  if (!batch.total && !batch.current?.total)
    return `<section class="weekly-prepare"><p class="weekly-eyebrow">Недельная подготовка</p><h2>Медиа-публикаций пока нет</h2><p class="weekly-description">Добавьте рубрику с фото или коротким видео. Её публикации появятся здесь для подготовки на неделю.</p><button type="button" id="prepare-rubrics" aria-label="Настроить рубрики →">Настроить рубрики ${icon('right')}</button></section>`;
  const needsVideo = [...batch.posts, ...(batch.current?.posts || [])].some(
    (p) => p.media === 'video' && !['scheduled', 'sent'].includes(p.status),
  );
  const connected = batch.vk?.canPrepare && (!needsVideo || batch.vk?.canVideo);
  const busy = batch.running || state.preparing;
  const ready = batch.ready;
  const percent = batch.total ? Math.round((ready / batch.total) * 100) : 0;
  const date = (value) =>
    new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric',
      month: 'long',
      timeZone: 'Europe/Moscow',
    }).format(new Date(value + 'T12:00:00Z'));
  const projects = [...new Set(batch.posts.map((post) => post.projectId))];
  const errors = [...batch.posts, ...(batch.current?.posts || [])].filter((post) =>
    ['failed', 'exhausted', 'uncertain'].includes(post.status),
  );
  return `<section class="weekly-prepare${batch.complete ? ' is-complete' : ''}" aria-labelledby="prepare-title">
    <div class="weekly-prepare-main">
      <div class="weekly-prepare-copy"><p class="weekly-eyebrow">Следующая неделя · VK</p><h2 id="prepare-title">${date(batch.week.start)} — ${date(batch.week.end)}</h2>
      <p class="weekly-description">Фото и короткие видео рубрик — в отложенные VK.<br>Текстовые публикации выходят по расписанию рубрик.</p></div>
      <div class="weekly-prepare-action">
        <span class="weekly-auth ${connected ? 'is-connected' : ''}"><span class="weekly-auth-dot" aria-hidden="true"></span> ${connected ? (batch.vk?.mode === 'community' ? 'Ключи сообществ готовы' : 'VK подключён') : batch.vk?.mode === 'community' ? 'Нужны ключи сообществ на сервере' : 'Нужен вход в VK'}</span>
        ${!connected && !batch.complete && !busy && batch.vk?.mode !== 'community' ? `<a class="weekly-primary" href="${escapeAttr(apiBase)}/bot/api/v1/vk/legacy/login">Войти в VK ${icon('external')}</a>` : `<button class="weekly-primary" type="button" id="prepare-week" ${busy || batch.complete || !batch.missing || !connected ? 'disabled' : ''} aria-busy="${Boolean(busy)}" ${batch.complete ? 'aria-label="Неделя подготовлена ✓"' : ''}>${busy ? 'Подготавливаем посты…' : batch.complete ? `Неделя подготовлена ${icon('check')}` : 'Подготовить посты'}<span aria-hidden="true">${!busy && !batch.complete && batch.missing ? ` · ${batch.missing}` : ''}</span></button>`}
        <p class="weekly-action-note">${batch.complete ? 'Все фотографии и записи сохранены во VK' : busy ? 'Можно закрыть страницу — подготовка продолжится' : !connected && batch.vk?.mode === 'community' ? 'Добавьте community-токены групп в env сервера' : !connected ? 'После входа вернём вас сюда' : batch.uncertain && !batch.missing ? 'Проверьте записи с неизвестным результатом' : 'Генерация и отправка только оставшихся записей'}</p>
      </div>
    </div>
    <div class="weekly-progress-line"><span>${busy ? 'Подготовка идёт' : batch.complete ? 'Всё готово к публикации' : 'Готовность недели'}</span><strong>${ready}<span> / ${batch.total}</span></strong></div>
    <progress class="weekly-progress" value="${ready}" max="${batch.total || 1}" aria-label="Отложенные посты следующей недели">${percent}%</progress>
    <div class="weekly-projects">${projects
      .map((id) => {
        const posts = batch.posts.filter((p) => p.projectId === id);
        const done = posts.filter((p) => ['scheduled', 'sent'].includes(p.status)).length;
        return `<div class="weekly-project"><span>${escapeText(posts[0].title)}</span><strong>${done}<span> / ${posts.length}</span></strong><div class="weekly-days" aria-label="Готовность постов ${escapeAttr(posts[0].title)}">${posts.map((p) => `<span class="weekly-day is-${escapeAttr(p.status === 'exhausted' ? 'failed' : p.status)}" title="${escapeAttr(new Date(p.date).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }))} · ${escapeAttr(p.status === 'scheduled' ? 'В отложенных VK' : p.status === 'sent' ? 'Опубликован' : p.status === 'preparing' ? 'Готовится' : p.status === 'exhausted' ? 'Остановлено после 3 попыток' : p.status === 'failed' ? 'Ошибка' : p.status === 'uncertain' ? 'Нужна проверка' : 'Ожидает подготовки')}"></span>`).join('')}</div></div>`;
      })
      .join('')}</div>
    <div class="weekly-feedback" aria-live="polite">${state.preparationError ? `<p role="alert">${escapeText(state.preparationError)}</p>` : ''}</div>
    ${errors.length ? `<details class="weekly-errors"><summary>Требуют внимания · ${errors.length}</summary>${errors.map((p) => `<p><strong>${escapeText(p.title)}</strong> · ${escapeText(new Date(p.date).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }))}<br>${p.status === 'uncertain' ? 'Результат отправки неизвестен. Проверьте отложенные VK: повторная отправка заблокирована.' : p.status === 'exhausted' ? 'Остановлено после 3 попыток — VK больше не дергаем. Исправьте доступ и сбросьте слот вручную.' : 'Не удалось подготовить запись. До 3 попыток, потом стоп.'}</p>`).join('')}</details>` : ''}
    ${
      ready
        ? `<details class="weekly-links"><summary>Записи в VK · ${ready}</summary><div>${batch.posts
            .filter((p) => p.url)
            .map(
              (p) =>
                `<a href="${escapeAttr(p.url)}" target="_blank" rel="noopener noreferrer">${escapeText(p.title)} · ${escapeText(new Date(p.date).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }))} ${icon('external')}</a>`,
            )
            .join('')}</div></details>`
        : ''
    }
    ${batch.current ? `<div class="weekly-current"><div><strong>Дополнить текущую неделю</strong><p class="meta">${batch.current.ready} из ${batch.current.total} готово · ${batch.current.missing} осталось. Только ещё не вышедшие посты.</p></div><button type="button" id="prepare-current" ${batch.current.running || !batch.current.missing || !connected ? 'disabled' : ''}>${batch.current.running ? 'Готовим…' : 'Дополнить неделю'}</button></div>` : ''}
  </section>`;
}

async function prepareWeek(current = false) {
  const batch = current ? state.weekly?.current : state.weekly;
  if (state.preparing || batch?.running || !batch?.missing) return;
  state.preparing = true;
  state.preparationError = null;
  const button = document.getElementById(current ? 'prepare-current' : 'prepare-week');
  if (button) {
    button.disabled = true;
    button.textContent = 'Подготавливаем посты…';
  }
  try {
    const result = await api('/bot/api/v1/weekly-preparation' + (current ? '?scope=current' : ''), {
      method: 'POST',
      body: '{}',
    });
    if (!current) state.weekly = result;
  } catch (error) {
    state.preparationError =
      error.status === 409
        ? error.body?.error === 'vk_video_permission_required'
          ? 'Войдите в VK повторно и разрешите доступ к видео.'
          : 'Сначала войдите в VK с необходимыми правами.'
        : 'Запуск не подтверждён. Обновите страницу, чтобы проверить состояние подготовки.';
  } finally {
    state.preparing = false;
    await loadOverview(true);
  }
}

function renderOverview(data, incidents, errorMessage = '', tabBundle = null) {
  state.ozonProjects = data.projects;
  const retainedModal = document.body.classList.contains('modal-open')
    ? document.getElementById('modal')
    : null;
  const retainedFocus = retainedModal?.contains(document.activeElement)
    ? document.activeElement
    : null;
  const retainedScroll = window.scrollY;
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
    ${renderWeeklyPreparation()}
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
          <button type="button" id="prev-week" aria-label="Предыдущая неделя">${icon('left')}</button>
          <button type="button" id="today-week">Сегодня</button>
          <button type="button" id="next-week" aria-label="Следующая неделя">${icon('right')}</button>
        </div>
        <h2 title="${escapeText(weekRangeIsoTitle(week.start, week.end))}">${escapeText(formatWeekRange(week.start, week.end))}</h2>
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
          <select id="rubric-filter" aria-label="Рубрика"><option value="">Все рубрики</option><option value="none" ${params().get('rubric') === 'none' ? 'selected' : ''}>Без рубрики</option>${(data.rubrics || []).map((r) => `<option value="${escapeAttr(r.id)}" ${params().get('rubric') === r.id ? 'selected' : ''}>${escapeText(r.name)}</option>`).join('')}</select>
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
          <p class="day-count">Постов: ${day.cards.length}</p>
          <div class="day-slots">${day.cards.length ? day.cards.map(renderCard).join('') : '<p class="day-empty meta">—</p>'}</div>
        </div>`,
        )
        .join('')}
    </section>
    <div id="modal" class="modal hidden" aria-hidden="true">
      <button type="button" class="modal-backdrop" id="modal-backdrop" aria-label="Закрыть"></button>
      <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <header class="modal-panel-head"><strong>Публикация</strong><button type="button" class="modal-close" id="modal-close" aria-label="Закрыть">${icon('close')}</button></header>
        <div id="modal-body" class="modal-body"></div>
      </div>
    </div>`
      : '';
  const incidentsPanel =
    tab === 'incidents' ? renderIncidentsSection(incidents, data.projects) : '';
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

  const retainedImport =
    tab === 'analytics-imports' && app.dataset.tab === tab && app.dataset.project === project
      ? document.getElementById('import-form')
      : null;
  const retainedPreview = retainedImport ? document.getElementById('import-preview') : null;
  const importFocus = retainedImport?.contains(document.activeElement)
    ? document.activeElement
    : null;
  app.className = tab === 'week' ? 'cabinet' : 'cabinet cabinet--workspace';
  app.dataset.tab = tab;
  app.dataset.project = project;
  app.innerHTML = `
    ${renderSiteHeader(openCount, data)}
    ${renderVkOauthFeedback()}
    ${errorMessage ? `<div class="error-banner" role="alert">${escapeText(errorMessage)}</div>` : ''}
    ${weekPanel}
    ${tab === 'rubrics' ? rubricManager.render(data, project) : ''}
    ${editorialPanel}
    ${analyticsPanel}
    ${incidentsPanel}
    ${servicePanel}`;

  if (retainedImport) {
    document.getElementById('import-form')?.replaceWith(retainedImport);
    document.getElementById('import-preview')?.replaceWith(retainedPreview);
    importFocus?.focus({ preventScroll: true });
  }

  // Refresh the calendar without destroying the active dialog, unsaved form,
  // detail request or its scroll position. Tab changes intentionally close it.
  if (retainedModal && tab === 'week') {
    document.getElementById('app').querySelector('#modal')?.remove();
    window.scrollTo(0, retainedScroll);
    retainedFocus?.focus({ preventScroll: true });
  } else {
    closeModal();
  }

  document.getElementById('logout').onclick = () => logout();
  document.getElementById('ozon-open').onclick = () => ozonComposer.open();
  document.getElementById('vk-feedback-dismiss')?.addEventListener('click', () => {
    setParam('vk', '');
    setParam('reason', '');
    loadOverview(true);
  });
  document.getElementById('vk-owner-capabilities')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const out = document.getElementById('vk-owner-capabilities-out');
    if (!out) return;
    button.disabled = true;
    out.hidden = false;
    out.textContent = 'Проверяем permissions / groups / photos.getWallUploadServer…';
    try {
      const groupId = state.vk?.groups?.find((g) => g.configured)?.groupId || '';
      const q = groupId ? `?group_id=${encodeURIComponent(groupId)}` : '';
      const result = await api(`/bot/api/v1/vk/legacy/capabilities${q}`);
      out.textContent = JSON.stringify(result.results || result, null, 2);
    } catch (error) {
      out.textContent = error.body?.error || error.message || 'probe_failed';
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById('prepare-week')?.addEventListener('click', () => prepareWeek());
  document.getElementById('prepare-current')?.addEventListener('click', () => prepareWeek(true));
  document.getElementById('prepare-rubrics')?.addEventListener('click', () => {
    setParam('tab', 'rubrics');
    loadOverview(true);
  });
  if (tab === 'rubrics') rubricManager.bind(app, data, project);
  document.getElementById('rubric-filter')?.addEventListener('change', (event) => {
    setParam('rubric', event.target.value);
    loadOverview(true);
  });
  const openServiceTab = () => {
    if (tab === 'service') return;
    setParam('tab', 'service');
    loadOverview(true);
  };
  document.getElementById('stale-indicator')?.addEventListener('click', openServiceTab);
  document.getElementById('heartbeat-pill')?.addEventListener('click', openServiceTab);
  app.querySelectorAll('.cabinet-tab[data-tab]').forEach((node) => {
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
      setParam('rubric', '');
      loadOverview(true);
    };
    document.getElementById('status-filter').onchange = (event) => {
      setParam('status', event.target.value);
      loadOverview(true);
    };
    document.getElementById('refresh').onclick = () => loadOverview(true);
    bindModal();
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

  resizeFields(app);
}

function renderCard(card) {
  const tone = toneForStatus(card.status);
  const channel = slotChannelLabel(card);
  const project = card.projectTitle || '—';
  const kind = `${card.publicationKind || 'text'}${card.expectedMedia ? ` / ${card.expectedMedia}` : ''}`;
  const tip = `${card.time} · ${channel} · ${project} · ${card.statusLabel}${card.rubricLabel ? ' · Рубрика: ' + card.rubricLabel : ''}`;
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
    ${card.rubricLabel ? `<span class="slot-rubric" title="${escapeAttr(card.rubricLabel)}" style="--rubric-color:${/^#[a-f0-9]{6}$/i.test(card.rubricColor || '') ? card.rubricColor : '#806bba'}">${escapeText(card.rubricLabel)}</span>` : ''}
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
  resizeFields(body);
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
    const feedback = document.getElementById('plan-feedback');
    if (feedback)
      feedback.textContent =
        error.body?.error === 'version_conflict'
          ? PUBLIC_ERROR.version_conflict
          : PUBLIC_ERROR.save_failed;
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
      const retryControl = detail.retryable
        ? `<div class="modal-form-actions modal-retry-actions"><button type="button" id="retry-publication" class="modal-form-submit">Повторить</button></div><p id="retry-feedback" class="meta" role="status"></p>`
        : '';
      extra.innerHTML = `
      ${retryControl}
      <h3 class="modal-section">${releaseBadge ? `${releaseBadge} · ` : ''}Выпуск</h3>
      <dl class="modal-detail-grid">${metaRows}</dl>
      <div class="modal-post-text">${escapeText(detail.edition.bodyText || detail.edition.bodyNotice || 'Текст пока не сохранён')}</div>
      ${deliveryRows}
      ${
        detail.events?.length
          ? `<div class="modal-history"><h3 class="modal-section">История</h3>${detail.events.map((event) => `<p class="meta">${escapeText(event.createdAt)} · ${escapeText(event.stage)} · ${escapeText(event.message)}</p>`).join('')}</div>`
          : ''
      }`;
      document.getElementById('retry-publication')?.addEventListener('click', (event) => {
        retryPublication(event.currentTarget, meta.editionId);
      });
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
      <p id="plan-feedback" class="error-banner" role="alert"></p>
      <input type="hidden" name="expectedVersion" value="${escapeText(meta.version)}" />
      <div class="modal-form-actions">
        <button type="submit" class="modal-form-submit">Сохранить</button>
      </div>
    </form>`;
  document.getElementById('plan-form').addEventListener('submit', handlePlanFormSubmit);
}

function retryFeedback(code) {
  if (code === 'generation_pending') return 'Публикация уже запускается.';
  if (code === 'locked') return 'Публикация занята. Повторите через несколько секунд.';
  if (code === 'paused') return 'Канал на паузе. Снимите паузу и повторите.';
  if (code === 'not_retryable' || code === 'not_recoverable' || code === 'not_found')
    return 'Повтор недоступен: пост уже отправлен или исход неизвестен.';
  return 'Не удалось запустить публикацию. Обновите страницу и повторите.';
}

async function retryPublication(button, editionId) {
  if (!editionId) return;
  const feedback = document.getElementById('retry-feedback');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = 'Запускаем…';
  try {
    await api(`/bot/api/v1/editions/${encodeURIComponent(editionId)}/retry`, {
      method: 'POST',
      body: '{}',
    });
    button.textContent = 'Запущено';
    if (feedback) feedback.textContent = 'Публикация запущена. Пост уйдёт в ближайшие секунды.';
    await loadOverview(true);
  } catch (error) {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = 'Повторить';
    if (feedback) feedback.textContent = retryFeedback(error.body?.error);
  }
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
      const feedback = document.getElementById('editorial-feedback');
      if (feedback) feedback.textContent = 'Выберите сообщество, чтобы собрать план.';
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
  app.querySelectorAll('[data-posts-cursor]').forEach((node) => {
    node.addEventListener('click', () => {
      setParam('cursor', node.dataset.postsCursor);
      loadOverview(true);
    });
  });
  app.querySelectorAll('[data-analytics-tab]').forEach((node) => {
    node.addEventListener('click', () => {
      setParam('tab', node.dataset.analyticsTab);
      setParam('cursor', '');
      loadOverview(true);
    });
  });
  document.getElementById('project-filter')?.addEventListener('change', (event) => {
    setParam('project', event.target.value);
    setParam('cursor', '');
    loadOverview(true);
  });
  const form = document.getElementById('import-form');
  if (form && !form.dataset.bound) {
    form.dataset.bound = 'true';
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = form.querySelector('[type="submit"]');
      if (submit.disabled) return;
      const fd = new FormData(form);
      const file = fd.get('file');
      if (!(file instanceof File)) return;
      const previewEl = document.getElementById('import-preview');
      submit.disabled = true;
      submit.setAttribute('aria-busy', 'true');
      previewEl.textContent = 'Проверяем файл…';
      try {
        const content = await file.text();
        const observedLocal = String(fd.get('observedAt') || '');
        const observedAt = new Date(`${observedLocal}+03:00`).toISOString();
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
          <h3>Результат проверки</h3><p>Корректных строк: ${escapeText(preview.preview?.validCount ?? 0)} · ошибок: ${escapeText(preview.preview?.errorCount ?? 0)} · сопоставлено: ${escapeText(preview.matchedCount ?? 0)}</p>
          ${preview.preview?.anomalyCount ? `<label class="confirm-anomalies"><input type="checkbox" id="confirm-anomalies"> Подтверждаю снижение накопительных показателей в ${escapeText(preview.preview.anomalyCount)} строках. Эти значения заменят предыдущие.</label>` : ''}
          <button type="button" id="import-commit" ${preview.preview?.canCommitStrict ? '' : 'disabled'}>Подтвердить импорт</button>
          ${preview.preview?.canCommitStrict ? '' : '<p class="meta">Исправьте ошибки в файле и повторите проверку. Импорт заблокирован.</p>'}<p id="import-feedback" role="status" aria-live="polite"></p>`;
        const commit = document.getElementById('import-commit');
        const confirmation = document.getElementById('confirm-anomalies');
        if (confirmation && preview.preview?.canCommitStrict) {
          commit.disabled = true;
          confirmation.onchange = () => {
            commit.disabled = !confirmation.checked;
          };
        }
        commit?.addEventListener('click', async () => {
          if (commit.disabled) return;
          await analyticsAction(
            commit,
            async () => {
              const result = await api(
                `/bot/api/v1/imports/${encodeURIComponent(preview.importId)}/commit`,
                {
                  method: 'POST',
                  body: JSON.stringify({
                    mode: 'strict',
                    confirmAnomalies: confirmation?.checked === true,
                  }),
                },
              );
              previewEl.innerHTML = `<h3>Импорт завершён</h3><p>Применено: ${escapeText(result.applied)}, пропущено: ${escapeText(result.skipped)}, ошибок: ${escapeText(result.errors)}</p>`;
            },
            'Статистика обновлена.',
            'import-feedback',
          );
        });
      } catch (error) {
        previewEl.textContent = `Не удалось проверить файл: ${error.body?.message || error.message || 'повторите попытку'}`;
      } finally {
        submit.disabled = false;
        submit.removeAttribute('aria-busy');
      }
    });
  }
  document.getElementById('run-analysis')?.addEventListener('click', async () => {
    const projectId = params().get('project');
    if (!projectId) {
      return;
    }
    await analyticsAction(
      document.getElementById('run-analysis'),
      () =>
        api('/bot/api/v1/analysis-jobs', {
          method: 'POST',
          body: JSON.stringify({ projectId }),
        }),
      'Анализ запущен. Результаты появятся после выполнения задачи.',
    );
  });
  app.querySelectorAll('[data-decide]').forEach((node) => {
    node.addEventListener('click', async () => {
      const card = node.closest('[data-rec]');
      const id = card?.dataset.rec;
      if (!id) return;
      await analyticsAction(
        node,
        () =>
          api(`/bot/api/v1/recommendations/${encodeURIComponent(id)}/decide`, {
            method: 'POST',
            body: JSON.stringify({ decision: node.dataset.decide }),
          }),
        'Рекомендация отклонена.',
      );
    });
  });
}

async function analyticsAction(button, request, successText, feedbackId = 'analytics-feedback') {
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    await request();
    await loadOverview(true);
    const feedback =
      document.getElementById(feedbackId) || document.getElementById('analytics-feedback');
    if (feedback) feedback.textContent = successText;
  } catch (error) {
    const feedback = document.getElementById(feedbackId);
    if (feedback)
      feedback.textContent = `Не удалось выполнить действие: ${error.body?.message || error.message}`;
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

async function loadAnalyticsBundle(project) {
  const q = project ? `?project=${encodeURIComponent(project)}` : '';
  const tab = activeTab();
  if (tab === 'analytics') return { overview: await api(`/bot/api/v1/analytics${q}`) };
  if (tab === 'analytics-posts')
    return {
      posts: await api(
        `/bot/api/v1/analytics/posts${q}${q ? '&' : '?'}limit=50&cursor=${encodeURIComponent(params().get('cursor') || '0')}`,
      ),
    };
  if (tab === 'analytics-imports')
    return { imports: await api(`/bot/api/v1/analytics/imports${q}`) };
  if (tab === 'analytics-segments')
    return { segments: await api(`/bot/api/v1/analytics/segments${q}`) };
  const [recommendations, versions] = await Promise.all([
    api(`/bot/api/v1/recommendations${q}`),
    api(`/bot/api/v1/prompt-versions${q}`),
  ]);
  return {
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

let overviewRequest = 0;

async function loadOverview(manual = false) {
  const requestId = ++overviewRequest;
  const requestedSearch = location.search;
  const week = params().get('week');
  const project = params().get('project');
  const status = params().get('status');
  const query = new URLSearchParams();
  if (week) query.set('week', week);
  if (project) query.set('project', project);
  if (status) query.set('status', status);
  if (params().get('rubric')) query.set('rubric', params().get('rubric'));
  try {
    const tabBundleRequest = (
      isAnalyticsTab()
        ? loadAnalyticsBundle(project)
        : isEditorialTab()
          ? loadEditorialBundle(project).then((editorial) => ({ editorial }))
          : Promise.resolve(null)
    ).catch((error) => {
      if (error.status === 401) throw error;
      return isEditorialTab() ? { editorial: { error: error.message } } : { error: error.message };
    });
    const [overview, incidents, vk, weekly, tabBundle] = await Promise.all([
      api(`/bot/api/v1/overview?${query}`),
      api(
        `/bot/api/v1/incidents?${project ? `project=${encodeURIComponent(project)}&` : ''}status=open`,
      ),
      api('/bot/api/v1/vk/legacy/status').catch((error) => {
        if (error.status === 401) throw error;
        return { unavailable: true };
      }),
      activeTab() === 'week'
        ? api('/bot/api/v1/weekly-preparation').catch((error) => {
            if (error.status === 401) throw error;
            return null;
          })
        : Promise.resolve(null),
      tabBundleRequest,
    ]);
    if (state.dataVersion && overview.data_version < state.dataVersion && !manual) {
      overview.service = { ...(overview.service || {}), stale: true };
    }
    state.dataVersion = overview.data_version;
    if (requestId !== overviewRequest || requestedSearch !== location.search) return;
    state.vk = vk;
    state.weekly = weekly?.week && Array.isArray(weekly.posts) ? weekly : null;
    renderOverview(overview, incidents, '', tabBundle);
    state.backoffMs = weekly?.running || weekly?.current?.running ? 3000 : 30000;
  } catch (error) {
    if (requestId !== overviewRequest || requestedSearch !== location.search) return;
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
