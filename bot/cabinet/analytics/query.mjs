import {
  ageBucketId,
  costPerThousandReached,
  engagementRate,
  isD7Comparable,
  linkCtr,
  observationAgeDays,
  reachPerThousandSubscribers,
  spread,
} from './derive.mjs';

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SCAN = 5000;
const MAX_PAGE = 100;

export function analyticsWindow(now = new Date()) {
  const to = now.toISOString();
  const from = new Date(now.getTime() - WINDOW_MS).toISOString();
  return { from, to, label: 'last_30_days', days: 30 };
}

export function buildAnalyticsOverview(db, filters = {}, now = new Date()) {
  const window = resolveWindow(filters, now);
  const posts = listAnalyticsPosts(db, { ...filters, ...window, paginate: false, limit: MAX_SCAN }, now);
  const withMetrics = posts.items.filter((p) => p.metrics);
  const organicReach = withMetrics
    .map((p) => p.metrics.reachOrganic)
    .filter((v) => v != null);
  const engagement = withMetrics.map((p) => p.derived.engagement?.value).filter((v) => v != null);

  const ranking = rankPosts(withMetrics);
  const byDay = {};
  for (const post of withMetrics) {
    const day = (post.publishedAt || post.metrics.observedAt || '').slice(0, 10);
    if (!day) continue;
    if (!byDay[day]) byDay[day] = { day, posts: 0, organicReach: 0, views: 0 };
    byDay[day].posts += 1;
    byDay[day].organicReach += post.metrics.reachOrganic || 0;
    byDay[day].views += post.metrics.views || 0;
  }

  return {
    window,
    filters: sanitizeFilters(filters),
    coverage: {
      sent: posts.coverage.sent,
      withMetrics: withMetrics.length,
      withoutMetrics: posts.coverage.sent - withMetrics.length,
      ratio: posts.coverage.sent ? withMetrics.length / posts.coverage.sent : null,
      note: 'Пост без метрик не занимает последнее место как нулевой',
    },
    summary: {
      organicReach: spread(organicReach),
      engagementRate: spread(engagement),
      deliverySuccess: deliverySuccessRate(db, filters.projectId, window),
    },
    daily: Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)),
    top: ranking.top,
    bottom: ranking.bottom,
    definitions: {
      engagement: '(likes+comments+reposts+saves)/reach; нужны все слагаемые',
      linkCtr: 'link_clicks/views',
      reachPer1000: 'organic_reach/subscribers_at_publish*1000',
      costPer1000: 'generation_cost_usd/organic_reach*1000',
      reachVsViews: 'reach=люди, views=просмотры/показы; сумма reach постов ≠ уникальный охват',
    },
  };
}

export function listAnalyticsPosts(db, filters = {}, now = new Date()) {
  const window = resolveWindow(filters, now);
  const paginate = filters.paginate !== false;
  const scanLimit = Math.min(
    MAX_SCAN,
    Number(filters.scanLimit || (paginate ? 2000 : filters.limit) || 2000),
  );
  const params = [window.from, window.to];
  let projectClause = '';
  if (filters.projectId) {
    projectClause = ' AND d.project_id = ?';
    params.push(filters.projectId);
  }

  const sentCountParams = [window.from, window.to];
  let sentProjectClause = '';
  if (filters.projectId) {
    sentProjectClause = ' AND project_id = ?';
    sentCountParams.push(filters.projectId);
  }
  const sentTotal = db
    .prepare(
      `SELECT COUNT(*) AS c FROM deliveries
       WHERE status = 'sent' AND sent_at >= ? AND sent_at <= ?${sentProjectClause}`,
    )
    .get(...sentCountParams).c;

  const deliveries = db
    .prepare(
      `SELECT d.*, e.body_text, e.body_removed_at, e.topic, e.format, e.cost_usd,
              e.prompt_version, e.prompt_hashes_json, e.media_planned, e.media_actual,
              e.models_json, e.experiment_variant, e.is_external, e.content_expires_at,
              f.slot_local_time, f.slot_weekday, f.language, f.body_length, f.prompt_version_id
       FROM deliveries d
       JOIN editions e ON e.edition_id = d.edition_id
       LEFT JOIN post_features f ON f.edition_id = e.edition_id
       WHERE d.status = 'sent' AND d.sent_at >= ? AND d.sent_at <= ?${projectClause}
       ORDER BY d.sent_at DESC
       LIMIT ?`,
    )
    .all(...params, scanLimit);

  const observationsByKey = loadLatestObservations(db, deliveries);

  const items = [];
  for (const row of deliveries) {
    if (filters.format && row.format !== filters.format) continue;
    if (filters.topic && row.topic !== filters.topic) continue;
    if (filters.media && (row.media_actual || 'none') !== filters.media) continue;
    if (filters.promptVersion && row.prompt_version !== filters.promptVersion) continue;
    if (filters.source === 'bot' && row.is_external === 1) continue;
    if (filters.source === 'external' && row.is_external !== 1) continue;

    const observation = row.external_id
      ? observationsByKey.get(observationLookupKey(row.project_id, row.external_id, row.vk_group_id))
      : null;
    if (filters.requireMetrics === '1' && !observation) continue;
    if (filters.organicPaid === 'organic' && observation?.promoted === 1) continue;
    if (filters.organicPaid === 'paid' && observation?.promoted !== 1) continue;

    const ageDays = observationAgeDays(row.sent_at, observation?.observed_at || now.toISOString());
    if (filters.ageBucket) {
      const bucket = ageBucketId(observationAgeDays(row.sent_at, observation?.observed_at));
      if (bucket !== filters.ageBucket) continue;
    }

    const metrics = observation ? serializeObservation(observation) : null;
    const derived = metrics
      ? {
          engagement: engagementRate(observation),
          linkCtr: linkCtr(observation),
          reachPer1000: reachPerThousandSubscribers(observation),
          costPer1000: costPerThousandReached(observation, row.cost_usd),
          ageDays: observationAgeDays(row.sent_at, observation.observed_at),
          ageBucket: ageBucketId(observationAgeDays(row.sent_at, observation.observed_at)),
          d7Comparable: isD7Comparable(observationAgeDays(row.sent_at, observation.observed_at)),
        }
      : null;

    const expired =
      (row.content_expires_at && row.content_expires_at <= now.toISOString()) ||
      Boolean(row.body_removed_at);

    items.push({
      editionId: row.edition_id,
      deliveryId: row.delivery_id,
      projectId: row.project_id,
      vkGroupId: row.vk_group_id,
      vkPostId: row.external_id,
      vkUrl:
        row.vk_group_id && row.external_id
          ? `https://vk.com/wall-${String(row.vk_group_id).replace(/^-/, '')}_${row.external_id}`
          : null,
      publishedAt: row.sent_at,
      bodyText: expired ? null : row.body_text,
      bodyNotice: expired ? 'содержимое удалено после 30 дней' : null,
      topic: row.topic,
      format: row.format,
      mediaPlanned: row.media_planned,
      mediaActual: row.media_actual,
      promptVersion: row.prompt_version || 'unknown',
      promptVersionId: row.prompt_version_id || null,
      promptHashes: row.prompt_hashes_json ? JSON.parse(row.prompt_hashes_json) : null,
      models: row.models_json ? JSON.parse(row.models_json) : null,
      costUsd: row.cost_usd,
      experimentVariant: row.experiment_variant,
      isExternal: row.is_external === 1,
      slotLocalTime: row.slot_local_time,
      slotWeekday: row.slot_weekday,
      bodyLength: row.body_length,
      ageDays,
      ageBucket: ageBucketId(ageDays),
      metrics,
      derived,
      rankingScore: metrics?.reachOrganic ?? metrics?.reachTotal ?? null,
    });
  }

  const cursor = Number(filters.cursor) || 0;
  const pageLimit = paginate ? Math.min(MAX_PAGE, Number(filters.limit) || 30) : items.length;
  const page = paginate ? items.slice(cursor, cursor + pageLimit) : items;

  return {
    window,
    items: page,
    nextCursor: paginate && cursor + pageLimit < items.length ? cursor + pageLimit : null,
    total: items.length,
    coverage: {
      sent: sentTotal,
      withMetrics: items.filter((i) => i.metrics).length,
      scanned: deliveries.length,
      truncated: sentTotal > deliveries.length,
    },
  };
}

export function buildSegments(db, filters = {}, now = new Date()) {
  const posts = listAnalyticsPosts(db, { ...filters, paginate: false, limit: MAX_SCAN }, now).items.filter(
    (p) => p.metrics,
  );
  const groups = {
    byTopic: groupBy(posts, (p) => p.topic || 'unknown'),
    byMedia: groupBy(posts, (p) => p.mediaActual || 'none'),
    byPromptVersion: groupBy(posts, (p) => p.promptVersion || 'unknown'),
    byAgeBucket: groupBy(posts, (p) => p.derived?.ageBucket || 'unknown'),
    byOrganicPaid: groupBy(posts, (p) => (p.metrics.promoted ? 'paid' : 'organic')),
    byModel: groupBy(posts, (p) => p.models?.text || 'unknown'),
  };

  const segments = {};
  for (const [name, map] of Object.entries(groups)) {
    segments[name] = Object.entries(map).map(([key, list]) => {
      const reaches = list.map((p) => p.metrics.reachOrganic).filter((v) => v != null);
      const eng = list.map((p) => p.derived.engagement?.value).filter((v) => v != null);
      const coverageRatio = list.length
        ? list.filter((p) => p.metrics.reachOrganic != null).length / list.length
        : null;
      return {
        key,
        posts: list.length,
        coverageRatio,
        organicReach: spread(reaches),
        engagementRate: spread(eng),
        comparableForRecommendation: list.length >= 20 && coverageRatio >= 0.8,
        note:
          list.length < 20 || coverageRatio < 0.8
            ? 'данных недостаточно для описательной рекомендации'
            : null,
      };
    });
  }

  return {
    window: resolveWindow(filters, now),
    segments,
    caution:
      'Не сравнивать вчерашний пост с накопленным результатом трёхнедельного без оговорки возраста',
  };
}

export function buildImportsCoverage(db, filters = {}, now = new Date()) {
  const imports = db
    .prepare(
      `SELECT * FROM metric_imports
       WHERE (? IS NULL OR project_id = ?)
       ORDER BY created_at DESC LIMIT 100`,
    )
    .all(filters.projectId || null, filters.projectId || null)
    .map((row) => ({
      importId: row.import_id,
      projectId: row.project_id,
      status: row.status,
      observedAt: row.observed_at,
      rowCount: row.row_count,
      matchedCount: row.matched_count,
      unknownCount: row.unknown_count,
      errorCount: row.error_count,
      coverage: JSON.parse(row.coverage_json || '{}'),
      revision: row.revision,
      committedAt: row.committed_at,
      createdAt: row.created_at,
    }));

  const window = analyticsWindow(now);
  const overview = buildAnalyticsOverview(db, { ...filters, ...window }, now);
  return {
    window,
    imports,
    coverage: overview.coverage,
    gaps: {
      postsWithoutStats: overview.coverage.withoutMetrics,
      staleImports: imports.filter(
        (i) =>
          i.status === 'preview' &&
          i.createdAt < new Date(now.getTime() - 24 * 3600 * 1000).toISOString(),
      ).length,
    },
  };
}

function resolveWindow(filters, now) {
  if (filters.from && filters.to) {
    return { from: filters.from, to: filters.to, label: 'custom', days: null };
  }
  return analyticsWindow(now);
}

function sanitizeFilters(filters) {
  return {
    projectId: filters.projectId || null,
    format: filters.format || null,
    topic: filters.topic || null,
    media: filters.media || null,
    promptVersion: filters.promptVersion || null,
    source: filters.source || null,
    organicPaid: filters.organicPaid || null,
    ageBucket: filters.ageBucket || null,
  };
}

function observationLookupKey(projectId, vkPostId, vkGroupId) {
  return `${projectId}\0${String(vkPostId)}\0${String(vkGroupId || '').replace(/^-/, '')}`;
}

function loadLatestObservations(db, deliveries) {
  const map = new Map();
  const keys = [];
  for (const row of deliveries) {
    if (!row.external_id) continue;
    keys.push({
      projectId: row.project_id,
      vkPostId: String(row.external_id),
      vkGroupId: String(row.vk_group_id || '').replace(/^-/, ''),
    });
  }
  if (!keys.length) return map;

  const byProject = new Map();
  for (const key of keys) {
    if (!byProject.has(key.projectId)) byProject.set(key.projectId, new Set());
    byProject.get(key.projectId).add(key.vkPostId);
  }

  for (const [projectId, postIds] of byProject) {
    const ids = [...postIds];
    const placeholders = ids.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT * FROM metric_observations
         WHERE project_id = ? AND is_active = 1 AND vk_post_id IN (${placeholders})
         ORDER BY observed_at DESC`,
      )
      .all(projectId, ...ids);
    for (const row of rows) {
      const key = observationLookupKey(row.project_id, row.vk_post_id, row.vk_group_id);
      if (!map.has(key)) map.set(key, row);
    }
  }
  return map;
}

function serializeObservation(row) {
  return {
    observationId: row.observation_id,
    observedAt: row.observed_at,
    metricMode: row.metric_mode,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    views: row.views,
    reachTotal: row.reach_total,
    reachOrganic: row.reach_organic,
    reachPaid: row.reach_paid,
    likes: row.likes,
    comments: row.comments,
    reposts: row.reposts,
    saves: row.saves,
    clicks: row.clicks,
    linkClicks: row.link_clicks,
    subscribersAtPublish: row.subscribers_at_publish,
    adSpend: row.ad_spend,
    promoted: row.promoted == null ? null : row.promoted === 1,
    anomalyFlags: JSON.parse(row.anomaly_flags_json || '[]'),
  };
}

function rankPosts(posts) {
  const scored = posts
    .filter((p) => p.rankingScore != null)
    .slice()
    .sort((a, b) => b.rankingScore - a.rankingScore);
  return {
    top: scored.slice(0, 5).map(rankCard),
    bottom: scored.slice(-5).reverse().map(rankCard),
  };
}

function rankCard(post) {
  return {
    editionId: post.editionId,
    vkPostId: post.vkPostId,
    topic: post.topic,
    publishedAt: post.publishedAt,
    reachOrganic: post.metrics?.reachOrganic ?? null,
    engagement: post.derived?.engagement?.value ?? null,
    ageDays: post.derived?.ageDays ?? null,
    observationCount: post.metrics ? 1 : 0,
  };
}

function groupBy(items, keyFn) {
  const map = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!map[key]) map[key] = [];
    map[key].push(item);
  }
  return map;
}

function deliverySuccessRate(db, projectId, window) {
  const params = [window.from, window.to];
  let clause = '';
  if (projectId) {
    clause = ' AND project_id = ?';
    params.push(projectId);
  }
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) AS c FROM deliveries
       WHERE created_at >= ? AND created_at <= ?${clause}
       GROUP BY status`,
    )
    .all(...params);
  const counts = Object.fromEntries(rows.map((r) => [r.status, r.c]));
  const planned = Object.values(counts).reduce((a, b) => a + b, 0);
  const sent = counts.sent || 0;
  return {
    planned,
    sent,
    missed: counts.missed || 0,
    uncertain: counts.uncertain || 0,
    ratio: planned ? sent / planned : null,
  };
}
