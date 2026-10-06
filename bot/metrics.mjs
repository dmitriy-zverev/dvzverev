import { writeAtomic } from './storage.mjs';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { acquireLock } from './lock.mjs';
import { readState } from './core.mjs';
import { initializeCosts, readGenerationCosts, recordGenerationCost } from './costs.mjs';

const countFields = ['subscribers', 'postReach', 'postViews', 'productLinkClicks', 'orders'];
const moneyFields = [
  'orderRevenue',
  'commissionRevenue',
  'otherExpenses',
  'generationExpensesRub',
  'generationExpensesUsd',
];
const metricsFields = [...countFields, ...moneyFields, 'usdToRub'];
const round = (value, places = 2) =>
  (Math.sign(value) * Math.round((Math.abs(value) + Number.EPSILON) * 10 ** places)) / 10 ** places;
export function validDate(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value
  );
}
function localDate(value, timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(value))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export async function readAnalytics(config) {
  try {
    const data = JSON.parse(await readFile(config.metricsPath, 'utf8'));
    if (
      data.version !== 1 ||
      data.groupId !== String(config.vkGroupId) ||
      !Array.isArray(data.snapshots) ||
      !Array.isArray(data.imports) ||
      !data.capabilities
    )
      throw new Error('Invalid analytics state');
    return data;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {
      version: 1,
      projectId: config.projectId,
      groupId: String(config.vkGroupId),
      capabilities: {},
      snapshots: [],
      imports: [],
      lastCollectedAt: null,
      lastProbedAt: null,
      daily: [],
    };
  }
}
async function store(config, data) {
  await writeAtomic(config.metricsPath, data);
}
async function locked(config, work) {
  if (!config.metricsPath) throw new Error('Metrics require a project configuration');
  await mkdir(dirname(config.metricsPath), { recursive: true });
  const release = await acquireLock(`${config.metricsPath}.lock`);
  if (!release) return { status: 'locked' };
  try {
    return await work(await readAnalytics(config));
  } finally {
    await release();
  }
}
async function vkRequest(config, method, parameters, fetchImpl) {
  try {
    const response = await fetchImpl(`https://api.vk.com/method/${method}`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ access_token: config.vkToken, v: '5.199', ...parameters }),
    });
    const body = await response.json();
    if (!response.ok || body.error)
      return { ok: false, errorCode: Number(body.error?.error_code || response.status) };
    if (body.response === undefined) return { ok: false, errorCode: null };
    return { ok: true, response: body.response };
  } catch {
    return { ok: false, errorCode: null };
  }
}
const capability = (result, now) => ({
  status: result.ok
    ? 'available'
    : result.errorCode === 27
      ? 'unavailable_with_community_key'
      : 'error',
  errorCode: result.errorCode ?? null,
  checkedAt: now.toISOString(),
});
const nullableCount = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

export async function collectMetrics(
  config,
  { now = new Date(), force = false, fetchImpl = fetch } = {},
) {
  if (!config.metricsEnabled || !config.vkEnabled) return { status: 'disabled' };
  return locked(config, async (data) => {
    if (
      !force &&
      data.lastCollectedAt &&
      now - new Date(data.lastCollectedAt) < config.metricsIntervalMinutes * 60_000
    )
      return { status: 'not_due' };
    await initializeCosts(config, now);
    const state = await readState(config);
    if (Date.parse(state.cooldowns.vk) > now.getTime())
      return { status: 'service_cooldown', retryAt: state.cooldowns.vk };
    if (state.pauses.vk && !force) return { status: 'posting_paused' };
    let costs = await readGenerationCosts(config);
    const trackedPosts = new Set(costs.events.map((e) => e.postId));
    for (const entry of state.entries) {
      if (
        entry.postId &&
        !trackedPosts.has(entry.postId) &&
        entry.createdAt < costs.trackingStartedAt &&
        typeof entry.generation?.cost === 'number'
      ) {
        await recordGenerationCost(config, {
          id: entry.postId,
          postId: entry.postId,
          kind: 'legacy-post',
          model: entry.generation.model,
          usd:
            entry.generation.cost + (typeof entry.image?.cost === 'number' ? entry.image.cost : 0),
          occurredAt: entry.createdAt,
        });
        trackedPosts.add(entry.postId);
      }
    }
    costs = await readGenerationCosts(config);
    const posts = state.entries
      .filter((e) => e.platform === 'vk' && e.status === 'sent' && Number.isInteger(e.vkPostId))
      .slice(-90)
      .map((e) => ({
        postId: e.vkPostId,
        publishedAt: e.vkSentAt || e.createdAt,
        reach: null,
        views: null,
        likes: null,
        comments: null,
        reposts: null,
      }));
    const group = await vkRequest(
      config,
      'groups.getById',
      { group_id: config.vkGroupId, fields: 'members_count' },
      fetchImpl,
    );
    data.capabilities['groups.getById'] = capability(group, now);
    const groups = Array.isArray(group.response) ? group.response : group.response?.groups;
    let subscribers = nullableCount(
      groups?.find((g) => String(g.id) === String(config.vkGroupId))?.members_count,
    );
    if (subscribers === null) {
      const members = await vkRequest(
        config,
        'groups.getMembers',
        { group_id: config.vkGroupId, count: '1' },
        fetchImpl,
      );
      data.capabilities['groups.getMembers'] = capability(members, now);
      subscribers = nullableCount(members.response?.count);
    }
    const probe = force || !data.lastProbedAt || now - new Date(data.lastProbedAt) >= 7 * 86400_000;
    const allowed = (method) => probe || data.capabilities[method]?.status === 'available';
    let groupStats = null;
    if (allowed('stats.get')) {
      const stats = await vkRequest(
        config,
        'stats.get',
        {
          group_id: config.vkGroupId,
          timestamp_from: String(Math.floor(now.getTime() / 1000) - 86400),
          timestamp_to: String(Math.floor(now.getTime() / 1000)),
          interval: 'day',
          intervals_count: '2',
        },
        fetchImpl,
      );
      data.capabilities['stats.get'] = capability(stats, now);
      groupStats = stats.ok ? stats.response : null;
    }
    if (posts.length && allowed('stats.getPostReach')) {
      for (let index = 0; index < posts.length; index += 30) {
        const batch = posts.slice(index, index + 30);
        const stats = await vkRequest(
          config,
          'stats.getPostReach',
          { owner_id: `-${config.vkGroupId}`, post_ids: batch.map((p) => p.postId).join(',') },
          fetchImpl,
        );
        data.capabilities['stats.getPostReach'] = capability(stats, now);
        if (!stats.ok) break;
        for (const result of stats.response || []) {
          const post = batch.find((p) => p.postId === result.post_id);
          if (post) post.reach = nullableCount(result.reach_total);
        }
      }
    }
    if (posts.length && allowed('wall.getById')) {
      for (let index = 0; index < posts.length; index += 30) {
        const batch = posts.slice(index, index + 30);
        const result = await vkRequest(
          config,
          'wall.getById',
          { posts: batch.map((p) => `-${config.vkGroupId}_${p.postId}`).join(',') },
          fetchImpl,
        );
        data.capabilities['wall.getById'] = capability(result, now);
        if (!result.ok) break;
        for (const item of Array.isArray(result.response)
          ? result.response
          : result.response?.items || []) {
          const post = batch.find(
            (p) => p.postId === item.id && item.owner_id === -Number(config.vkGroupId),
          );
          if (post) {
            post.views = nullableCount(item.views?.count);
            post.likes = nullableCount(item.likes?.count);
            post.comments = nullableCount(item.comments?.count);
            post.reposts = nullableCount(item.reposts?.count);
          }
        }
      }
    }
    if (probe) data.lastProbedAt = now.toISOString();
    const snapshot = {
      capturedAt: now.toISOString(),
      subscribers,
      groupStats,
      posts,
      generationCosts: {
        knownUsd: round(
          costs.events.reduce((sum, e) => sum + (e.usd || 0), 0),
          8,
        ),
        unknownCostEvents: costs.events.filter((e) => e.usd === null).length,
        trackingStartedAt: costs.trackingStartedAt,
        recordingFailure: costs.recordingFailure,
      },
    };
    data.snapshots.push(snapshot);
    data.snapshots = data.snapshots.slice(-168);
    const day = localDate(now, config.timezone);
    data.daily ||= [];
    data.daily = data.daily.filter((row) => localDate(row.capturedAt, config.timezone) !== day);
    data.daily.push({
      capturedAt: snapshot.capturedAt,
      subscribers,
      generationCosts: snapshot.generationCosts,
    });
    data.daily = data.daily.slice(-730);
    data.lastCollectedAt = now.toISOString();
    await store(config, data);
    if (
      subscribers === null ||
      Object.values(data.capabilities).some(
        (c) => c.status === 'error' && c.checkedAt === now.toISOString(),
      )
    )
      throw new Error('VK analytics request failed; snapshot saved with unknown values');
    return {
      status: 'collected',
      projectId: config.projectId,
      ...snapshot,
      capabilities: data.capabilities,
    };
  });
}

export function validateCommerceImport(input, config) {
  if (
    !input ||
    input.version !== 1 ||
    input.projectId !== config.projectId ||
    String(input.groupId) !== String(config.vkGroupId) ||
    input.currency !== 'RUB' ||
    !Array.isArray(input.records) ||
    !input.records.length
  )
    throw new Error(
      'Import requires version 1, matching projectId/groupId, RUB and nonempty records',
    );
  const seen = new Set();
  return input.records.map((record) => {
    if (
      !record ||
      typeof record.id !== 'string' ||
      !record.id.trim() ||
      seen.has(record.id) ||
      !validDate(record.from) ||
      !validDate(record.to) ||
      record.from > record.to ||
      !['group', 'post'].includes(record.scope) ||
      (record.scope === 'post' && (!Number.isSafeInteger(record.postId) || record.postId < 1)) ||
      (record.scope === 'group' && record.postId !== undefined)
    )
      throw new Error('Invalid import record id, period or scope');
    seen.add(record.id);
    if (!record.metrics || Object.keys(record.metrics).some((key) => !metricsFields.includes(key)))
      throw new Error('Unknown metric');
    for (const [key, value] of Object.entries(record.metrics)) {
      if (value === null) continue;
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (key !== 'commissionRevenue' && value < 0) ||
        (countFields.includes(key) && !Number.isSafeInteger(value)) ||
        (key === 'usdToRub' && value <= 0)
      )
        throw new Error(`Invalid metric: ${key}`);
      if (
        ['orderRevenue', 'commissionRevenue', 'otherExpenses', 'generationExpensesRub'].includes(
          key,
        ) &&
        Math.abs(value * 100 - Math.round(value * 100)) > 1e-6
      )
        throw new Error(`Money must have at most two decimal places: ${key}`);
      if (moneyFields.includes(key) && Math.abs(value * 100) > Number.MAX_SAFE_INTEGER)
        throw new Error(`Money exceeds safe precision: ${key}`);
    }
    if (record.metrics.orders === 0 && record.metrics.orderRevenue > 0)
      throw new Error('Revenue with zero orders');
    return {
      id: record.id,
      from: record.from,
      to: record.to,
      scope: record.scope,
      ...(record.scope === 'post' ? { postId: record.postId } : {}),
      metrics: { ...record.metrics },
    };
  });
}
export async function importCommerce(config, input, { now = new Date() } = {}) {
  const records = validateCommerceImport(input, config);
  return locked(config, async (data) => {
    const updated = new Map(data.imports.map((r) => [r.id, r]));
    for (const record of records)
      updated.set(record.id, { ...record, importedAt: now.toISOString() });
    const all = [...updated.values()];
    const buckets = new Map();
    for (const record of all) {
      const key = `${record.scope}:${record.postId || ''}`;
      const bucket = buckets.get(key) || [];
      bucket.push(record);
      buckets.set(key, bucket);
    }
    for (const bucket of buckets.values()) {
      bucket.sort((a, b) => a.from.localeCompare(b.from));
      for (let index = 1; index < bucket.length; index++) {
        if (bucket[index].from <= bucket[index - 1].to)
          throw new Error(
            'Overlapping reports for the same scope; replace the existing record id instead',
          );
      }
    }
    data.imports = all;
    await store(config, data);
    return { status: 'imported', projectId: config.projectId, records: records.length };
  });
}
function moneySum(records, field) {
  if (!records.length || records.some((r) => r.metrics[field] == null)) return null;
  return round(
    records.reduce((sum, r) => sum + r.metrics[field], 0),
    field === 'generationExpensesUsd' ? 8 : 2,
  );
}
export async function metricsReport(config, { from, to, now = new Date() } = {}) {
  to ||= localDate(now, config.timezone);
  from ||= `${to.slice(0, 7)}-01`;
  if (!validDate(from) || !validDate(to) || from > to) throw new Error('Invalid report period');
  const data = await readAnalytics(config),
    costs = await readGenerationCosts(config);
  const allGroup = data.imports.filter((r) => r.scope === 'group' && r.from <= to && r.to >= from);
  if (allGroup.some((r) => r.from < from || r.to > to))
    throw new Error('Import period crosses report boundary; choose matching dates');
  const records = allGroup;
  const days =
    Math.round((new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / 86400_000) + 1;
  const coveredDays = records.reduce(
    (sum, r) =>
      sum +
      Math.round((new Date(`${r.to}T12:00:00Z`) - new Date(`${r.from}T12:00:00Z`)) / 86400_000) +
      1,
    0,
  );
  const completeManual = coveredDays === days;
  const sum = (field) => (completeManual ? moneySum(records, field) : null);
  const events = costs.events.filter((e) => {
    const day = localDate(e.occurredAt, config.timezone);
    return day >= from && day <= to;
  });
  const knownUsd = round(
    events.reduce((total, e) => total + (e.usd || 0), 0),
    8,
  );
  const completeCosts = Boolean(
    costs.trackingStartedAt &&
    from > localDate(costs.trackingStartedAt, config.timezone) &&
    !costs.recordingFailure &&
    events.every((e) => e.usd !== null && e.kind !== 'legacy-post'),
  );
  const generationUsd = sum('generationExpensesUsd') ?? (completeCosts ? knownUsd : null);
  const exchangeRates = records.map((r) => r.metrics.usdToRub);
  const usdToRub =
    completeManual &&
    exchangeRates.length &&
    exchangeRates.every((rate) => rate > 0 && rate === exchangeRates[0])
      ? exchangeRates[0]
      : null;
  const generationRub =
    sum('generationExpensesRub') ??
    (generationUsd !== null && usdToRub !== null ? round(generationUsd * usdToRub) : null);
  const orders = sum('orders'),
    revenue = sum('orderRevenue'),
    commission = sum('commissionRevenue'),
    expenses = sum('otherExpenses');
  const snapshot =
    data.snapshots.filter((s) => localDate(s.capturedAt, config.timezone) <= to).at(-1) ||
    data.daily?.filter((s) => localDate(s.capturedAt, config.timezone) <= to).at(-1) ||
    null;
  const latestManual = records.at(-1);
  const postReach = sum('postReach'),
    postViews = sum('postViews');
  return {
    projectId: config.projectId,
    groupId: config.vkGroupId,
    currency: 'RUB',
    period: { from, to },
    manualCoverageComplete: completeManual,
    subscribers: latestManual?.metrics.subscribers ?? snapshot?.subscribers ?? null,
    subscribersAsOf:
      latestManual?.metrics.subscribers != null ? latestManual.to : snapshot?.capturedAt || null,
    postReach,
    postViews,
    productLinkClicks: sum('productLinkClicks'),
    orders,
    orderRevenue: revenue,
    averageOrderValue: orders > 0 && revenue !== null ? round(revenue / orders) : null,
    commissionRevenue: commission,
    commissionRatePercent:
      revenue > 0 && commission !== null ? round((commission / revenue) * 100) : null,
    generationExpenses: {
      knownProviderUsd: knownUsd,
      totalUsd: generationUsd,
      totalRub: generationRub,
      unknownCostEvents: events.filter((e) => e.usd === null).length,
      coverageComplete:
        completeCosts ||
        sum('generationExpensesUsd') !== null ||
        sum('generationExpensesRub') !== null,
      trackingStartedAt: costs.trackingStartedAt,
      usdToRub,
    },
    otherExpenses: expenses,
    profit:
      commission !== null && expenses !== null && generationRub !== null
        ? round(commission - expenses - generationRub)
        : null,
    profitFormula: 'commissionRevenue - generationExpensesRub - otherExpenses',
    capabilities: data.capabilities,
    posts: (snapshot?.posts || []).filter((post) => {
      const day = localDate(post.publishedAt, config.timezone);
      return day >= from && day <= to;
    }),
    postImports: data.imports.filter((r) => r.scope === 'post' && r.from >= from && r.to <= to),
  };
}
