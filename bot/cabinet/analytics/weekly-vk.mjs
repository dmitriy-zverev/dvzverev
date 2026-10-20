import { getOwnerVkClient } from '../../vk-oauth/legacy.mjs';
import { setMeta, withTransaction } from '../db.mjs';
import { addDaysYmd, isoWeekStart, localSlotToUtc, zonedParts, formatDateYmd } from '../time.mjs';
import { VK_STATS_SCHEMA_VERSION } from './parse.mjs';
import { writeMetricObservation } from './import.mjs';

const SOURCE = 'vk-oauth-weekly';
const BATCH = 30;

export function measuredWeek(now = new Date()) {
  const parts = zonedParts(now, 'Europe/Moscow');
  const today = formatDateYmd({
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  });
  const start = isoWeekStart(today);
  const end = addDaysYmd(start, 7);
  return {
    start,
    end,
    from: localSlotToUtc(start, '00:00', 'Europe/Moscow').toISOString(),
    to: localSlotToUtc(end, '00:00', 'Europe/Moscow').toISOString(),
  };
}

function count(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function organicReach(total, ads) {
  if (total == null) return null;
  if (ads == null) return total;
  return Math.max(0, total - ads);
}

function listWeekPosts(db, week) {
  return db
    .prepare(
      `SELECT delivery_id, edition_id, project_id, external_id, vk_group_id, sent_at
       FROM deliveries
       WHERE platform = 'vk' AND status = 'sent'
         AND external_id IS NOT NULL AND vk_group_id IS NOT NULL
         AND sent_at >= ? AND sent_at < ?`,
    )
    .all(week.from, week.to);
}

async function vkCall(client, token, method, params) {
  return client.rawApi(method, params, token);
}

async function vkCallRetry(client, token, method, params, pause) {
  try {
    return await vkCall(client, token, method, params);
  } catch (error) {
    if (error.vkCode !== 6) throw error;
    await pause(1500);
    return vkCall(client, token, method, params);
  }
}

export async function collectWeeklyVkStats(db, env = process.env, options = {}) {
  const now = options.now || new Date();
  const client = options.client || getOwnerVkClient(env);
  const pause = options.pause || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  if (!client?.status?.().connected) return { skipped: 'oauth_unavailable', collected: 0 };
  const token = await client.accessToken();
  const week = measuredWeek(now);
  const posts = listWeekPosts(db, week).filter((row) => /^\d+$/.test(String(row.external_id)));
  const byGroup = new Map();
  for (const row of posts) {
    const key = String(row.vk_group_id).replace(/^-/, '');
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(row);
  }

  let collected = 0;
  let failed = 0;
  const groups = [];
  for (const [groupId, rows] of byGroup) {
    let members = null;
    // ponytail: skip stats.get until the OAuth scope includes stats (VK 7 today).
    let groupStats = 'stats_scope_missing';
    try {
      const info = await vkCallRetry(
        client,
        token,
        'groups.getById',
        { group_id: groupId, fields: 'members_count' },
        pause,
      );
      const group = info?.groups?.[0] || info?.[0];
      members = count(group?.members_count);
    } catch (error) {
      groupStats = error.message || 'failed';
    }
    groups.push({ groupId, members, groupStats, posts: rows.length });

    const reachById = new Map();
    const wallById = new Map();
    for (let index = 0; index < rows.length; index += BATCH) {
      const batch = rows.slice(index, index + BATCH);
      const ids = batch.map((row) => row.external_id).join(',');
      await pause(1100);
      try {
        const reach = await vkCallRetry(
          client,
          token,
          'stats.getPostReach',
          { owner_id: `-${groupId}`, post_ids: ids },
          pause,
        );
        for (const item of reach || []) reachById.set(String(item.post_id), item);
      } catch (error) {
        console.error(`weekly vk reach group=${groupId}: ${error.message || error}`);
      }
      await pause(1100);
      try {
        const wall = await vkCallRetry(
          client,
          token,
          'wall.getById',
          { posts: batch.map((row) => `-${groupId}_${row.external_id}`).join(',') },
          pause,
        );
        const items = Array.isArray(wall) ? wall : wall?.items || [];
        for (const item of items) wallById.set(String(item.id), item);
      } catch (error) {
        console.error(`weekly vk wall group=${groupId}: ${error.message || error}`);
      }
    }

    withTransaction(db, () => {
      for (const row of rows) {
        const reach = reachById.get(String(row.external_id));
        const wall = wallById.get(String(row.external_id));
        if (!reach && !wall) {
          failed += 1;
          continue;
        }
        const reachTotal = count(reach?.reach_total);
        const reachPaid = count(reach?.reach_ads);
        writeMetricObservation(db, {
          projectId: row.project_id,
          vkPostId: String(row.external_id),
          vkGroupId: groupId,
          editionId: row.edition_id,
          deliveryId: row.delivery_id,
          source: SOURCE,
          sourceHash: null,
          importId: `weekly:${week.start}`,
          importRevision: 1,
          observedAt: now.toISOString(),
          periodFrom: week.start,
          periodTo: week.end,
          metricMode: 'cumulative',
          publishedAt: row.sent_at,
          metrics: {
            views: count(wall?.views?.count),
            reach_total: reachTotal,
            reach_organic: organicReach(reachTotal, reachPaid),
            reach_paid: reachPaid,
            likes: count(wall?.likes?.count),
            comments: count(wall?.comments?.count),
            reposts: count(wall?.reposts?.count),
            saves: null,
            clicks: count(reach?.links),
            link_clicks: count(reach?.to_group),
            subscribers_at_publish: null,
            ad_spend: null,
            promoted: reachPaid ? true : reachPaid === 0 ? false : null,
          },
          schemaVersion: VK_STATS_SCHEMA_VERSION,
          anomalyFlags: [],
          now,
        });
        collected += 1;
      }
    });
  }

  setMeta(
    db,
    `weekly_vk_collect:${week.start}`,
    JSON.stringify({ collectedAt: now.toISOString(), collected, failed, groups }),
  );
  return { week: week.start, collected, failed, groups };
}
