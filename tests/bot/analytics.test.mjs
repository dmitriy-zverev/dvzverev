import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openCabinetDb, getMeta } from '../../bot/cabinet/db.mjs';
import { SCHEMA_VERSION } from '../../bot/cabinet/schema.mjs';
import { refreshServiceSnapshot } from '../../bot/cabinet/projects.mjs';
import { parseImportFile } from '../../bot/cabinet/analytics/parse.mjs';
import {
  adaptVkPostsContentRows,
  moscowDateTimeToIso,
  parseVkPostsExportFilename,
} from '../../bot/cabinet/analytics/vk-posts-content.mjs';
import {
  buildImportPreview,
  commitImport,
  revertImport,
} from '../../bot/cabinet/analytics/import.mjs';
import {
  buildAnalyticsOverview,
  buildSegments,
  listAnalyticsPosts,
} from '../../bot/cabinet/analytics/query.mjs';
import {
  engagementRate,
  linkCtr,
  reachPerThousandSubscribers,
} from '../../bot/cabinet/analytics/derive.mjs';
import { contentExpiresAt, runAnalyticsCleanup } from '../../bot/cabinet/analytics/ttl.mjs';
import {
  activatePromptVersion,
  listPromptVersions,
  registerPromptVersion,
  rollbackPromptVersion,
} from '../../bot/cabinet/analytics/prompts.mjs';
import { getEdition } from '../../bot/cabinet/overview.mjs';
import {
  createAnalysisJob,
  decideRecommendation,
  listRecommendations,
} from '../../bot/cabinet/analytics/recommendations.mjs';
import { upsertPostFeatures } from '../../bot/cabinet/analytics/features.mjs';

const FIXTURES = join(process.cwd(), 'bot/fixtures/vk-stats');

const service = {
  destinations: {
    'connaissance-vk': { platform: 'vk', media: { enabled: true, kind: 'video' } },
  },
  projects: {
    'dark-academia': {
      enabled: true,
      format: 'literary',
      schedule: { timezone: 'Europe/Moscow', times: ['10:00'], missedSlots: 'skip' },
      delivery: { destinations: ['connaissance-vk'] },
    },
  },
};

function openDb() {
  const db = openCabinetDb({ BOT_CABINET_DB_PATH: ':memory:' });
  refreshServiceSnapshot(db, service);
  return db;
}

function seedSentPost(db, {
  editionId = 'a'.repeat(32),
  deliveryId = 'slot:dest:vk',
  vkPostId = '1001',
  vkGroupId = '194579254',
  sentAt = '2026-09-20T10:00:00.000Z',
  body = 'Тестовый пост про литературу',
  topic = 'literature',
  mediaActual = 'gif',
  costUsd = 0.02,
} = {}) {
  db.prepare(
    `INSERT INTO editions (
      edition_id, project_id, slot_key, format, topic, brief, body_text,
      prompt_version, models_json, cost_usd, aggregate_status, created_at, updated_at
    ) VALUES (?, 'dark-academia', '2026-09-20T10:00', 'literary', ?, NULL, ?, 'unknown', ?, ?, 'sent', ?, ?)`,
  ).run(
    editionId,
    topic,
    body,
    JSON.stringify({ text: 'google/gemini-test' }),
    costUsd,
    sentAt,
    sentAt,
  );
  db.prepare(
    `INSERT INTO deliveries (
      delivery_id, edition_id, project_id, destination_id, platform, status,
      post_id, external_id, vk_group_id, attempts, sent_at, created_at, updated_at
    ) VALUES (?, ?, 'dark-academia', 'connaissance-vk', 'vk', 'sent', 'p1', ?, ?, 1, ?, ?, ?)`,
  ).run(deliveryId, editionId, vkPostId, vkGroupId, sentAt, sentAt, sentAt);
  upsertPostFeatures(db, {
    editionId,
    projectId: 'dark-academia',
    format: 'literary',
    topic,
    bodyText: body,
    mediaPlanned: 'gif',
    mediaActual,
    slotKey: '2026-09-20T10:00',
    models: { text: 'google/gemini-test' },
    publishedAt: sentAt,
  });
}

test('schema migrates to v4 analytics tables', () => {
  const db = openDb();
  assert.equal(Number(getMeta(db, 'schema_version')), SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 4);
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    .all()
    .map((r) => r.name);
  for (const name of [
    'metric_imports',
    'metric_import_rows',
    'metric_observations',
    'prompt_versions',
    'post_features',
    'recommendations',
    'analysis_jobs',
    'delivery_tombstones',
    'monthly_aggregates',
  ]) {
    assert.ok(tables.includes(name), name);
  }
  db.close();
});

test('fixture CSV/JSON parse matches control table', async () => {
  const csv = await readFile(join(FIXTURES, 'sample-posts.csv'));
  const json = await readFile(join(FIXTURES, 'sample-posts.json'), 'utf8');
  const expected = JSON.parse(await readFile(join(FIXTURES, 'expected.json'), 'utf8'));
  const parsedCsv = parseImportFile(csv, { filename: 'sample-posts.csv' });
  assert.equal(parsedCsv.ok, true);
  assert.equal(parsedCsv.rows.length, 5);
  assert.equal(parsedCsv.rows.every((r) => r.valid), true);

  const row1 = parsedCsv.rows.find((r) => r.postId === '1001');
  const control1 = expected.control.find((c) => c.post_id === '1001');
  assert.equal(row1.metrics.views, control1.views);
  assert.equal(row1.metrics.reach_organic, control1.reach_organic);
  assert.equal(
    engagementRate({
      likes: row1.metrics.likes,
      comments: row1.metrics.comments,
      reposts: row1.metrics.reposts,
      saves: row1.metrics.saves,
      reach_organic: row1.metrics.reach_organic,
    }).value,
    control1.engagement,
  );
  assert.equal(
    linkCtr({ link_clicks: row1.metrics.link_clicks, views: row1.metrics.views }).value,
    control1.link_ctr_views,
  );
  assert.equal(
    reachPerThousandSubscribers({
      reach_organic: row1.metrics.reach_organic,
      subscribers_at_publish: row1.metrics.subscribers_at_publish,
    }).value,
    control1.reach_per_1000,
  );

  const parsedJson = parseImportFile(Buffer.from(json), { filename: 'sample-posts.json' });
  assert.equal(parsedJson.ok, true);
  assert.equal(parsedJson.rows[0].metrics.views, 1200);

  const empty = parseImportFile(Buffer.from('group_id,post_id,observed_at,metric_mode,views\n194579254,1,2026-10-06T12:00:00.000Z,cumulative,\n'), {
    filename: 'empty.csv',
  });
  assert.equal(empty.rows[0].metrics.views, null);
});

test('import preview/commit/revert: idempotent, foreign group blocked, no silent partial', async () => {
  const db = openDb();
  seedSentPost(db, { vkPostId: '1001' });
  seedSentPost(db, {
    editionId: 'b'.repeat(32),
    deliveryId: 'slot2:dest:vk',
    vkPostId: '1002',
    sentAt: '2026-09-21T10:00:00.000Z',
  });
  const csv = await readFile(join(FIXTURES, 'sample-posts.csv'));
  const preview = buildImportPreview(db, {
    projectId: 'dark-academia',
    vkGroupId: '194579254',
    observedAt: '2026-10-06T12:00:00.000Z',
    buffer: csv,
    filename: 'sample-posts.csv',
  });
  assert.ok(preview.importId);
  assert.equal(preview.matchedCount, 2);
  assert.ok(preview.unknownCount >= 3);

  const blocked = commitImport(db, preview.importId, { mode: 'strict' });
  // unmatched are ok status 'unmatched', not error — commit should proceed for valid rows
  // unless there are validation errors. sample csv all valid.
  assert.equal(blocked.error, undefined);
  assert.equal(blocked.applied >= 2, true);

  const again = buildImportPreview(db, {
    projectId: 'dark-academia',
    vkGroupId: '194579254',
    observedAt: '2026-10-06T12:00:00.000Z',
    buffer: csv,
    filename: 'sample-posts.csv',
  });
  assert.equal(again.error, 'duplicate_file');

  const obsCount = db
    .prepare(`SELECT COUNT(*) AS c FROM metric_observations WHERE is_active = 1`)
    .get().c;
  assert.equal(obsCount >= 2, true);

  // second cumulative snapshot same identity replaces, does not triple
  const csv2 = csv
    .toString('utf8')
    .replaceAll('2026-10-06T12:00:00.000Z', '2026-10-13T12:00:00.000Z')
    .replace('1200', '1300');
  const preview2 = buildImportPreview(db, {
    projectId: 'dark-academia',
    vkGroupId: '194579254',
    observedAt: '2026-10-13T12:00:00.000Z',
    buffer: Buffer.from(csv2),
    filename: 'week2.csv',
  });
  const commit2 = commitImport(db, preview2.importId, { mode: 'valid_only', allowUnmatchedAsExternal: true });
  assert.equal(commit2.applied >= 2, true);
  const activeFor1001 = db
    .prepare(
      `SELECT COUNT(*) AS c FROM metric_observations WHERE vk_post_id = '1001' AND is_active = 1`,
    )
    .get().c;
  assert.equal(activeFor1001, 2); // two different observed_at snapshots

  const foreign = parseImportFile(
    Buffer.from(
      'group_id,post_id,observed_at,metric_mode,views\n999,1,2026-10-06T12:00:00.000Z,cumulative,1\n',
    ),
    { filename: 'foreign.csv' },
  );
  const foreignPreview = buildImportPreview(db, {
    projectId: 'dark-academia',
    vkGroupId: '194579254',
    observedAt: '2026-10-06T12:00:00.000Z',
    buffer: Buffer.from(
      'group_id,post_id,observed_at,metric_mode,views\n999,1,2026-10-06T12:00:00.000Z,cumulative,1\n',
    ),
    filename: 'foreign.csv',
  });
  assert.equal(foreignPreview.errorCount, 1);
  const foreignCommit = commitImport(db, foreignPreview.importId, { mode: 'strict' });
  assert.equal(foreignCommit.error, 'validation_blocked');

  const invalidPartial = buildImportPreview(db, {
    projectId: 'dark-academia',
    vkGroupId: '194579254',
    observedAt: '2026-10-06T12:00:00.000Z',
    buffer: Buffer.from(
      'group_id,post_id,observed_at,metric_mode,views\n194579254,1001,2026-10-06T12:00:00.000Z,cumulative,10\n194579254,bad,2026-10-06T12:00:00.000Z,cumulative,1\n',
    ),
    filename: 'partial.csv',
  });
  assert.ok(invalidPartial.errorCount >= 1);
  assert.equal(commitImport(db, invalidPartial.importId, { mode: 'strict' }).error, 'validation_blocked');
  const validOnly = commitImport(db, invalidPartial.importId, {
    mode: 'valid_only',
    confirmAnomalies: true,
  });
  assert.equal(validOnly.error, undefined);
  assert.ok(validOnly.exclusions?.length >= 1);

  const reverted = revertImport(db, preview.importId);
  assert.equal(reverted.status, 'reverted');
  db.close();
  assert.equal(foreign.ok, true);
});

test('analytics rankings exclude missing metrics; paid separated; age buckets', () => {
  const db = openDb();
  const now = new Date('2026-10-06T12:00:00.000Z');
  for (let i = 0; i < 3; i += 1) {
    const id = String(i).padStart(32, 'c');
    seedSentPost(db, {
      editionId: id,
      deliveryId: `d${i}`,
      vkPostId: String(2000 + i),
      sentAt: `2026-09-${20 + i}T10:00:00.000Z`,
      mediaActual: i === 0 ? 'gif' : 'none',
      topic: i === 0 ? 'A' : 'B',
    });
  }
  // only first two have metrics
  for (const postId of ['2000', '2001']) {
    db.prepare(
      `INSERT INTO metric_observations (
        observation_id, project_id, edition_id, delivery_id, vk_group_id, vk_post_id,
        source, observed_at, metric_mode, views, reach_total, reach_organic, reach_paid,
        likes, comments, reposts, saves, promoted, schema_version, is_active, revision,
        anomaly_flags_json, created_at, updated_at
      ) VALUES (?, 'dark-academia', NULL, NULL, '194579254', ?, 'vk_export', ?, 'cumulative',
        100, 80, ?, ?, 10, 1, 1, 1, ?, 'vk-stats-v1', 1, 1, '[]', ?, ?)`,
    ).run(
      postId.padStart(32, 'o'),
      postId,
      now.toISOString(),
      postId === '2000' ? 500 : 100,
      postId === '2000' ? 50 : 0,
      postId === '2000' ? 1 : 0,
      now.toISOString(),
      now.toISOString(),
    );
  }

  const overview = buildAnalyticsOverview(db, { projectId: 'dark-academia' }, now);
  assert.equal(overview.coverage.sent, 3);
  assert.equal(overview.coverage.withMetrics, 2);
  assert.equal(overview.top[0].reachOrganic, 500);
  assert.ok(!overview.bottom.some((p) => p.reachOrganic == null));

  const organic = listAnalyticsPosts(db, { projectId: 'dark-academia', organicPaid: 'organic' }, now);
  assert.ok(organic.items.every((p) => !p.metrics || p.metrics.promoted !== true));

  const segments = buildSegments(db, { projectId: 'dark-academia' }, now);
  assert.ok(segments.segments.byMedia);
  assert.ok(segments.caution.includes('возраста'));
  db.close();
});

test('TTL hides payload immediately and cleanup scrubs copies', () => {
  const db = openDb();
  const published = '2026-09-01T10:00:00.000Z';
  seedSentPost(db, {
    sentAt: published,
    body: 'секретный текст',
  });
  // Force expiry while keeping published_at inside the 30d listing window relative to a later now.
  db.prepare(`UPDATE editions SET content_expires_at = ? WHERE edition_id = ?`).run(
    '2026-09-15T10:00:00.000Z',
    'a'.repeat(32),
  );
  const now = new Date('2026-09-20T12:00:00.000Z');
  const posts = listAnalyticsPosts(db, { projectId: 'dark-academia' }, now);
  assert.ok(posts.items.length >= 1);
  assert.equal(posts.items[0].bodyText, null);
  assert.match(posts.items[0].bodyNotice, /30 дней/);

  const stats = runAnalyticsCleanup(db, { now, force: true });
  assert.ok(stats.editionsScrubbed >= 1);
  const edition = db.prepare('SELECT body_text, body_removed_at FROM editions').get();
  assert.equal(edition.body_text, null);
  assert.ok(edition.body_removed_at);
  const tombs = db.prepare('SELECT COUNT(*) AS c FROM delivery_tombstones').get().c;
  assert.ok(tombs >= 1);
  db.close();
});

test('prompt versions activate/rollback; analysis does not auto-apply', () => {
  const db = openDb();
  for (let i = 0; i < 25; i += 1) {
    const id = i.toString(16).padStart(32, '0');
    seedSentPost(db, {
      editionId: id,
      deliveryId: `x${i}`,
      vkPostId: String(3000 + i),
      sentAt: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T10:00:00.000Z`,
      mediaActual: i < 12 ? 'gif' : 'none',
      body: `post ${i}`,
    });
    db.prepare(
      `INSERT INTO metric_observations (
        observation_id, project_id, edition_id, vk_group_id, vk_post_id, source, observed_at, metric_mode,
        reach_organic, likes, comments, reposts, saves, schema_version, is_active, revision,
        anomaly_flags_json, created_at, updated_at
      ) VALUES (?, 'dark-academia', ?, '194579254', ?, 'vk_export', '2026-10-06T12:00:00.000Z', 'cumulative',
        ?, 5, 1, 1, 1, 'vk-stats-v1', 1, 1, '[]', '2026-10-06T12:00:00.000Z', '2026-10-06T12:00:00.000Z')`,
    ).run(`obs${String(i).padStart(29, '0')}`, id, String(3000 + i), i < 12 ? 200 : 800);
  }

  const v1 = registerPromptVersion(db, {
    projectId: 'dark-academia',
    role: 'editor',
    versionLabel: 'v1',
    contentText: 'old prompt',
  });
  activatePromptVersion(db, v1.version.versionId);
  const v2 = registerPromptVersion(db, {
    projectId: 'dark-academia',
    role: 'editor',
    versionLabel: 'v2',
    contentText: 'new prompt',
    parentVersionId: v1.version.versionId,
  });
  activatePromptVersion(db, v2.version.versionId);
  const rolled = rollbackPromptVersion(db, v2.version.versionId);
  assert.equal(rolled.version.versionId, v1.version.versionId);
  assert.equal(rolled.version.status, 'active');

  const job = createAnalysisJob(db, { projectId: 'dark-academia' });
  assert.equal(job.status, 'completed');
  const recs = listRecommendations(db, { projectId: 'dark-academia' });
  assert.ok(recs.length >= 1);
  assert.ok(recs.every((r) => r.status === 'proposed'));
  assert.ok(recs.every((r) => Array.isArray(r.evidence)));

  const rejected = decideRecommendation(db, recs[0].recommendationId, { decision: 'reject', note: 'no' });
  assert.equal(rejected.recommendation.status, 'rejected');

  const dup = createAnalysisJob(db, { projectId: 'dark-academia' });
  assert.equal(dup.error, 'dataset_already_analyzed');
  db.close();
});

test('missing denominators stay null; fractional views rejected', () => {
  assert.equal(engagementRate({ likes: 1, comments: 1, reposts: 1, saves: 1, reach_organic: 0 }).value, null);
  assert.equal(linkCtr({ link_clicks: 1, views: null }).value, null);
  const parsed = parseImportFile(
    Buffer.from(
      'group_id,post_id,observed_at,metric_mode,views\n194579254,1,2026-10-06T12:00:00.000Z,cumulative,1.5\n',
    ),
    { filename: 'frac.csv' },
  );
  assert.equal(parsed.rows[0].valid, false);
});

test('overview/segments are not capped by API page size of 100', () => {
  const db = openDb();
  const now = new Date('2026-10-06T12:00:00.000Z');
  for (let i = 0; i < 120; i += 1) {
    const id = `e${String(i).padStart(31, '0')}`;
    const day = 7 + (i % 20); // 2026-09-07..26 inside 30d window from Oct 6
    seedSentPost(db, {
      editionId: id,
      deliveryId: `page${i}`,
      vkPostId: String(4000 + i),
      sentAt: `2026-09-${String(day).padStart(2, '0')}T10:00:00.000Z`,
      body: `post ${i}`,
    });
    db.prepare(
      `INSERT INTO metric_observations (
        observation_id, project_id, edition_id, vk_group_id, vk_post_id, source, observed_at, metric_mode,
        reach_organic, likes, comments, reposts, saves, schema_version, is_active, revision,
        anomaly_flags_json, created_at, updated_at
      ) VALUES (?, 'dark-academia', ?, '194579254', ?, 'vk_export', '2026-10-06T12:00:00.000Z', 'cumulative',
        ?, 1, 0, 0, 0, 'vk-stats-v1', 1, 1, '[]', '2026-10-06T12:00:00.000Z', '2026-10-06T12:00:00.000Z')`,
    ).run(`o${String(i).padStart(31, '0')}`, id, String(4000 + i), 100 + i);
  }
  const overview = buildAnalyticsOverview(db, { projectId: 'dark-academia' }, now);
  assert.equal(overview.coverage.withMetrics, 120);
  const paged = listAnalyticsPosts(db, { projectId: 'dark-academia', limit: 30 }, now);
  assert.equal(paged.items.length, 30);
  assert.equal(paged.nextCursor, 30);
  db.close();
});

test('VK posts_content native CSV adapts without inventing post_id', async () => {
  const named = parseVkPostsExportFilename('194579254_posts_content_2026-10-01_2026-10-07.xls');
  assert.equal(named.kind, 'content');
  assert.equal(moscowDateTimeToIso('07.10.2026', '10:35'), '2026-10-07T07:35:00.000Z');

  const csv = await readFile(join(FIXTURES, 'sample-posts-content-native.csv'));
  const parsed = parseImportFile(csv, {
    filename: '194579254_posts_content_2026-10-01_2026-10-07.csv',
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.format, 'vk_posts_content');
  assert.equal(parsed.groupHint, '194579254');
  assert.equal(parsed.rows.length, 5);
  assert.equal(parsed.rows.every((r) => r.postId == null), true);
  assert.equal(parsed.rows.every((r) => r.errors.some((e) => e.code === 'missing_post_id')), true);
  assert.equal(parsed.rows[0].metrics.views, 31);
  assert.equal(parsed.rows[0].metrics.reach_total, 6);
  assert.equal(parsed.rows[0].metricMode, 'period');
  assert.equal(parsed.rows[0].textHint.includes('Fixture quote A'), true);
  assert.equal(parsed.rows[4].errors.some((e) => e.code === 'invalid_likes'), true);

  const audience = adaptVkPostsContentRows([], {
    filename: '194579254_posts_audience_2026-10-01_2026-10-07.xls',
  });
  assert.equal(audience.ok, false);
  assert.equal(audience.error, 'vk_export_not_per_post');

  const xls = parseImportFile(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), {
    filename: '194579254_posts_content_2026-10-01_2026-10-07.xls',
  });
  assert.equal(xls.ok, false);
  assert.equal(xls.error, 'xlsx_not_supported');
  assert.match(xls.message, /vk-posts-xls-to-json/);

  const commonXls = parseImportFile(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), {
    filename: '194579254_posts_common_2026-10-01_2026-10-07.xls',
  });
  assert.equal(commonXls.error, 'vk_export_not_per_post');
});

test('VK posts_content converted JSON maps KPIs; enriched wall_url validates', async () => {
  const json = await readFile(join(FIXTURES, 'sample-posts-content.json'));
  const parsed = parseImportFile(json, { filename: 'sample-posts-content.json' });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.format, 'vk_posts_content');
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.rows[0].valid, false);
  assert.equal(parsed.rows[0].errors.some((e) => e.code === 'missing_post_id'), true);
  assert.equal(parsed.rows[0].metrics.views, 31);
  assert.equal(parsed.rows[2].valid, true);
  assert.equal(parsed.rows[2].postId, '9001');
  assert.equal(parsed.rows[2].metrics.reposts, 1);
});

test('content_expires_at reanchors from generation to published_at', () => {
  const db = openDb();
  const editionId = 'b'.repeat(32);
  const generatedAt = new Date('2026-09-01T08:00:00.000Z');
  db.prepare(
    `INSERT INTO editions (
      edition_id, project_id, slot_key, format, topic, brief, body_text,
      prompt_version, aggregate_status, created_at, updated_at
    ) VALUES (?, 'dark-academia', '2026-09-01T10:00', 'literary', 't', 'secret brief', 'draft body',
      'unknown', 'generating', ?, ?)`,
  ).run(editionId, generatedAt.toISOString(), generatedAt.toISOString());

  upsertPostFeatures(db, {
    editionId,
    projectId: 'dark-academia',
    format: 'literary',
    topic: 't',
    bodyText: 'draft body',
    mediaPlanned: 'gif',
    mediaActual: null,
    slotKey: '2026-09-01T10:00',
    publishedAt: null,
    now: generatedAt,
  });
  const provisional = db
    .prepare('SELECT content_expires_at FROM editions WHERE edition_id = ?')
    .get(editionId).content_expires_at;
  assert.equal(provisional, contentExpiresAt(generatedAt.toISOString(), generatedAt));

  const publishedAt = '2026-09-10T10:00:00.000Z';
  upsertPostFeatures(db, {
    editionId,
    projectId: 'dark-academia',
    format: 'literary',
    topic: 't',
    bodyText: 'draft body',
    mediaPlanned: 'gif',
    mediaActual: 'gif',
    slotKey: '2026-09-01T10:00',
    publishedAt,
    now: new Date('2026-09-10T12:00:00.000Z'),
  });
  const anchored = db
    .prepare('SELECT content_expires_at FROM editions WHERE edition_id = ?')
    .get(editionId).content_expires_at;
  assert.equal(anchored, contentExpiresAt(publishedAt));
  assert.notEqual(anchored, provisional);
  db.close();
});

test('expired edition API hides brief as well as body', () => {
  const db = openDb();
  const editionId = 'c'.repeat(32);
  seedSentPost(db, {
    editionId,
    deliveryId: 'ttl-brief',
    vkPostId: '8801',
    sentAt: '2026-09-01T10:00:00.000Z',
    body: 'видимый текст',
  });
  db.prepare(`UPDATE editions SET brief = ?, content_expires_at = ? WHERE edition_id = ?`).run(
    'секретный бриф',
    '2026-09-15T10:00:00.000Z',
    editionId,
  );
  const detail = getEdition(db, editionId);
  assert.equal(detail.edition.bodyText, null);
  assert.equal(detail.edition.brief, null);
  assert.match(detail.edition.bodyNotice, /30 дней/);
  db.close();
});

test('observed_before_publish does not inflate matchedCount', () => {
  const db = openDb();
  seedSentPost(db, {
    vkPostId: '1001',
    sentAt: '2026-09-20T10:00:00.000Z',
  });
  const csv = [
    'group_id,post_id,observed_at,metric_mode,views,reach_organic,likes,comments,reposts,saves',
    '194579254,1001,2026-09-19T10:00:00.000Z,cumulative,10,8,1,0,0,0',
  ].join('\n');
  const preview = buildImportPreview(db, {
    projectId: 'dark-academia',
    vkGroupId: '194579254',
    observedAt: '2026-09-19T10:00:00.000Z',
    buffer: Buffer.from(csv),
    filename: 'early.csv',
  });
  assert.equal(preview.matchedCount, 0);
  assert.equal(preview.errorCount, 1);
  assert.equal(preview.rows[0].errors[0]?.code, 'observed_before_publish');
  db.close();
});

test('prompt list omits content_text by default; cleanup throttles hourly', () => {
  const db = openDb();
  const registered = registerPromptVersion(db, {
    projectId: 'dark-academia',
    role: 'editor',
    versionLabel: 'list-v1',
    contentText: 'full secret prompt body',
  });
  assert.ok(registered.version);
  const listed = listPromptVersions(db, { projectId: 'dark-academia' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].contentText, undefined);

  const first = runAnalyticsCleanup(db, { now: new Date('2026-10-06T12:00:00.000Z') });
  assert.equal(first.skipped, undefined);
  const second = runAnalyticsCleanup(db, { now: new Date('2026-10-06T12:30:00.000Z') });
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'not_due');
  const forced = runAnalyticsCleanup(db, {
    now: new Date('2026-10-06T12:30:00.000Z'),
    force: true,
  });
  assert.equal(forced.skipped, undefined);
  db.close();
});
