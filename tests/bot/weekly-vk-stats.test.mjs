import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openCabinetDb } from '../../bot/cabinet/db.mjs';
import { collectWeeklyVkStats } from '../../bot/cabinet/analytics/weekly-vk.mjs';
import { buildDeterministicProposal } from '../../bot/cabinet/editorial/proposal.mjs';

const NOW = new Date('2026-10-18T16:30:00.000Z');

function client() {
  return {
    status: () => ({ connected: true }),
    accessToken: async () => 'oauth',
    rawApi: async (method) => {
      if (method === 'groups.getById') return { groups: [{ id: 194579254, members_count: 1858 }] };
      if (method === 'stats.get') {
        const error = new Error('vk_api_rejected_7');
        error.vkCode = 7;
        throw error;
      }
      if (method === 'stats.getPostReach') {
        return [
          {
            post_id: 3016,
            reach_total: 19,
            reach_subscribers: 18,
            reach_viral: 1,
            reach_ads: 0,
            links: 1,
            to_group: 0,
          },
        ];
      }
      if (method === 'wall.getById') {
        return [
          {
            id: 3016,
            views: { count: 19 },
            likes: { count: 2 },
            comments: { count: 1 },
            reposts: { count: 0 },
          },
        ];
      }
      throw new Error(method);
    },
  };
}

test('sunday collector stores reach and reactions for the week', async () => {
  const db = openCabinetDb({ BOT_CABINET_DB_PATH: ':memory:' });
  const editionId = randomUUID().replaceAll('-', '').slice(0, 32);
  const sentAt = '2026-10-14T07:00:00.000Z';
  db.prepare(
    `INSERT INTO editions (
      edition_id, project_id, slot_key, format, topic, brief, body_text,
      prompt_version, models_json, cost_usd, aggregate_status, created_at, updated_at
    ) VALUES (?, 'dark-academia', 'slot', 'literary', 't', NULL, 'text', 'unknown', '{}', 0, 'sent', ?, ?)`,
  ).run(editionId, sentAt, sentAt);
  db.prepare(
    `INSERT INTO deliveries (
      delivery_id, edition_id, project_id, destination_id, platform, status,
      post_id, external_id, vk_group_id, attempts, sent_at, created_at, updated_at
    ) VALUES (?, ?, 'dark-academia', 'connaissance-vk', 'vk', 'sent', 'p', '3016', '194579254', 1, ?, ?, ?)`,
  ).run(randomUUID(), editionId, sentAt, sentAt, sentAt);

  const result = await collectWeeklyVkStats(db, {}, { now: NOW, client: client(), pause: async () => {} });
  assert.equal(result.collected, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.groups[0].members, 1858);
  assert.equal(result.groups[0].groupStats, 'stats_scope_missing');
  const row = db
    .prepare(
      `SELECT views, reach_total, reach_organic, reach_paid, likes, comments, reposts, clicks, period_from
       FROM metric_observations WHERE vk_post_id = '3016' AND is_active = 1`,
    )
    .get();
  assert.equal(row.views, 19);
  assert.equal(row.reach_total, 19);
  assert.equal(row.reach_organic, 19);
  assert.equal(row.reach_paid, 0);
  assert.equal(row.likes, 2);
  assert.equal(row.comments, 1);
  assert.equal(row.reposts, 0);
  assert.equal(row.clicks, 1);
  assert.equal(row.period_from, '2026-10-12');
  db.close();
});

test('weekly proposal cites the collected reach', () => {
  const { proposal } = buildDeterministicProposal({
    projectId: 'dark-academia',
    weekStart: '2026-10-19',
    weekEnd: '2026-10-25',
    slots: [],
    diversity: { findings: [], counts: { rubrics: {} } },
    rubrics: [{ id: 'rubric', state: 'active', enabled: true }],
    memory: [{ vkPostId: '3016', rubricId: 'rubric', coverage: { hasMetrics: true } }],
    incompleteEditions: [],
    metrics: {
      stale: false,
      week: {
        from: '2026-10-12',
        posts: 1,
        medianReach: 19,
        views: 19,
        likes: 2,
        comments: 1,
        reposts: 0,
        items: [{ vkPostId: '3016', reach: 19, views: 19, likes: 2, comments: 1, reposts: 0 }],
      },
    },
  });
  assert.match(proposal.overview.summary, /медиана охвата 19/);
  assert.match(proposal.continue[0].reason, /медиана охвата рубрики за неделю 19/);
});
