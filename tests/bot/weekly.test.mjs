import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openCabinetDb } from '../../bot/cabinet/db.mjs';
import {
  nextWeek,
  weeklySnapshot,
  claimWeeklyJob,
  prepareWeeklyPosts,
  isSundayWeeklyPrepareWindow,
  maybeStartSundayWeeklyPrepare,
  maybeRunQueuedWeeklyPrepare,
  queueWeeklyPrepare,
  currentWeek,
} from '../../bot/cabinet/weekly.mjs';
import { notifyWeeklyPrepareDigest, summarizeWeek } from '../../bot/cabinet/weekly-notify.mjs';
import {
  LegacyVkClient,
  legacyCallbackPage,
  legacyManualLoginPage,
  parseLegacyRedirectUrl,
  getOwnerVkClient,
  getWeeklyVkClient,
  weeklyVkStatus,
} from '../../bot/vk-oauth/legacy.mjs';
import { listWeeklyCommunityTargets } from '../../bot/vk-oauth/community-weekly.mjs';
import { OAuthStore } from '../../bot/vk-oauth/store.mjs';
import { weeklyDelivery } from '../../bot/cabinet/weekly-delivery.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'weekly-test-'));
  const env = { BOT_CABINET_DB_PATH: join(root, 'cabinet.sqlite') };
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = openCabinetDb(env);
  const week = nextWeek(new Date('2026-10-07T10:00:00Z'));
  db.prepare('INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?)').run(
    'things',
    'Вещи',
    1,
    'Europe/Moscow',
    'lifestyle',
    'v1',
    '{}',
    '[]',
    new Date().toISOString(),
  );
  for (const [i, date] of [week.start, week.end].entries())
    db.prepare(
      `INSERT INTO schedule_slots(plan_id,project_id,destination_id,slot_utc,slot_key,publication_kind,expected_media,config_version,created_at,updated_at) VALUES (?,'things','things-vk',?,?,'image','image','v1',?,?)`,
    ).run('p' + i, date + 'T15:00:00.000Z', date + '@18:00[Europe/Moscow]', date, date);
  const dependencies = {
    app: {
      resolveProjectConfig: async () => ({
        contentMode: 'lifestyle',
        vkGroupId: '123',
        openrouterPrompt: 'Base',
        statePath: join(root, 'state.json'),
      }),
    },
    generate: async (config, { id }) => ({
      id,
      kind: 'lifestyle',
      text: config.editorialPlan.topic || 'Свет в доме.',
    }),
    cover: async () => ({ status: 'ready' }),
    upload: async () => 'photo-123_42',
    pause: async () => {},
    notify: async () => ({ skipped: 'test' }),
  };
  return { db, env, week, dependencies };
}

function client(fail, { attachment = 'photo-123_42', postType = 'postponed' } = {}) {
  let writes = 0;
  const receipts = new Map();
  const kind = attachment.startsWith('doc')
    ? 'doc'
    : attachment.startsWith('video')
      ? 'video'
      : 'photo';
  const [, owner, id] = attachment.match(/^(?:photo|doc|video)(-?\d+)_(\d+)/) || [];
  return {
    get writes() {
      return writes;
    },
    accessToken: async () => 'test-secret',
    uploadWeeklyImage: async () => attachment,
    api: async (method, parameters) => {
      if (method === 'wall.post') {
        writes++;
        if (fail && writes === 1) throw fail;
        receipts.set(writes, {
          id: writes,
          owner_id: -123,
          date: parameters.publish_date,
          post_type: postType,
          attachments: [{ type: kind, [kind]: { owner_id: Number(owner), id: Number(id) } }],
        });
        return { post_id: writes };
      }
      return [receipts.get(Number(parameters.posts.split('_')[1]))];
    },
  };
}

test('text slots defer without attachment and skip duplicates on rerun', async (t) => {
  const f = await fixture(t);
  f.db.prepare("UPDATE schedule_slots SET publication_kind='text',expected_media=NULL").run();
  let covers = 0;
  f.dependencies.cover = async () => {
    covers++;
    throw new Error('cover_should_not_run_for_text');
  };
  const c = client();
  await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
    ...f.dependencies,
    client: c,
  });
  assert.equal(covers, 0);
  assert.equal(c.writes, 2);
  assert.equal(weeklySnapshot(f.db, new Date('2026-10-07T10:00:00Z'), 'next').ready, 2);
  assert.equal(
    f.db.prepare("SELECT status FROM vk_weekly_posts WHERE plan_id='p0'").get().status,
    'deferred',
  );
  await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
    ...f.dependencies,
    client: c,
  });
  assert.equal(c.writes, 2);
  f.db.close();
});

test('gif without postponed confirmation stays uncertain (no auto-repost)', async (t) => {
  const f = await fixture(t);
  f.db.prepare("DELETE FROM schedule_slots WHERE plan_id='p1'").run();
  const c = client(null, { attachment: 'doc-123_9', postType: 'post' });
  await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
    ...f.dependencies,
    client: c,
  });
  assert.equal(c.writes, 1);
  assert.equal(
    f.db.prepare("SELECT status, error FROM vk_weekly_posts WHERE plan_id='p0'").get().status,
    'uncertain',
  );
  // Second run verifies only — must not wall.post again.
  await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
    ...f.dependencies,
    client: c,
  });
  assert.equal(c.writes, 1);
  f.db.close();
});

test('legacy publication_kind gif is prepared like image', async (t) => {
  const f = await fixture(t);
  f.db.prepare("UPDATE schedule_slots SET publication_kind='gif',expected_media='gif'").run();
  const c = client(null, { attachment: 'doc-123_42' });
  await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
    ...f.dependencies,
    client: c,
  });
  assert.equal(c.writes, 2);
  assert.equal(weeklySnapshot(f.db, new Date('2026-10-07T10:00:00Z'), 'next').ready, 2);
  f.db.close();
});

test('uncertain receipt recovers to deferred when VK confirms postponed', async (t) => {
  const f = await fixture(t);
  f.db.prepare("DELETE FROM schedule_slots WHERE plan_id='p1'").run();
  const publishDate = Math.floor(Date.parse(f.week.start + 'T15:00:00.000Z') / 1000);
  f.db
    .prepare(
      `INSERT INTO vk_weekly_posts(plan_id,week_start,status,post_json,attachment,post_id,group_id,attempts,updated_at)
       VALUES ('p0',?,'uncertain',?,?,?,?,1,?)`,
    )
    .run(
      f.week.start,
      JSON.stringify({ id: 'weekly-x', kind: 'lifestyle', text: 'Уже во VK.' }),
      'doc-123_42',
      99,
      '123',
      new Date().toISOString(),
    );
  let writes = 0;
  const c = {
    accessToken: async () => 'test-secret',
    api: async (method) => {
      if (method === 'wall.post') {
        writes++;
        throw new Error('must_not_repost');
      }
      return [
        {
          id: 99,
          owner_id: -123,
          date: publishDate,
          post_type: 'postponed',
          attachments: [{ type: 'doc', doc: { owner_id: -123, id: 42 } }],
        },
      ];
    },
  };
  await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
    ...f.dependencies,
    client: c,
  });
  assert.equal(writes, 0);
  assert.equal(
    f.db.prepare("SELECT status FROM vk_weekly_posts WHERE plan_id='p0'").get().status,
    'deferred',
  );
  f.db.close();
});

test('sunday window and auto-prepare guard fire once per next week', async (t) => {
  assert.equal(isSundayWeeklyPrepareWindow(new Date('2026-10-11T17:00:00Z')), true); // Sun 20:00 MSK
  assert.equal(isSundayWeeklyPrepareWindow(new Date('2026-10-11T16:00:00Z')), false);
  assert.equal(isSundayWeeklyPrepareWindow(new Date('2026-10-10T17:00:00Z')), false);
  const f = await fixture(t);
  let started = 0;
  const first = await maybeStartSundayWeeklyPrepare(
    f.env,
    new Date('2026-10-11T17:05:00Z'),
    {
      ensure: false,
      client: { status: () => ({ canPrepare: true }) },
      prepare: async () => {
        started++;
      },
    },
  );
  assert.equal(first.started, true);
  assert.equal(started, 1);
  const second = await maybeStartSundayWeeklyPrepare(
    f.env,
    new Date('2026-10-11T17:10:00Z'),
    {
      ensure: false,
      client: { status: () => ({ canPrepare: true }) },
      prepare: async () => {
        started++;
      },
    },
  );
  assert.equal(second.skipped, 'already_started');
  assert.equal(started, 1);
  f.db.close();
});

test('sunday nothing_missing stamps meta so ticks stop', async (t) => {
  const f = await fixture(t);
  await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
    ...f.dependencies,
    client: client(),
  });
  const snap = weeklySnapshot(f.db, new Date('2026-10-07T10:00:00Z'), 'next');
  assert.equal(snap.missing, 0);
  assert.equal(snap.uncertain, 0);
  let started = 0;
  const first = await maybeStartSundayWeeklyPrepare(f.env, new Date('2026-10-11T17:05:00Z'), {
    ensure: false,
    client: { status: () => ({ canPrepare: true }) },
    prepare: async () => {
      started++;
    },
  });
  assert.equal(first.skipped, 'nothing_missing');
  assert.equal(started, 0);
  const second = await maybeStartSundayWeeklyPrepare(f.env, new Date('2026-10-11T17:10:00Z'), {
    ensure: false,
    client: { status: () => ({ canPrepare: true }) },
    prepare: async () => {
      started++;
    },
  });
  assert.equal(second.skipped, 'already_started');
  assert.equal(started, 0);
  f.db.close();
});

test('sunday starts prepare when only uncertain slots remain', async (t) => {
  const f = await fixture(t);
  f.db.prepare("DELETE FROM schedule_slots WHERE plan_id='p1'").run();
  f.db
    .prepare(
      `INSERT INTO vk_weekly_posts(plan_id,week_start,status,post_json,attachment,post_id,group_id,attempts,updated_at)
       VALUES ('p0',?,'uncertain',?,?,?,?,1,?)`,
    )
    .run(
      f.week.start,
      JSON.stringify({ id: 'weekly-x', kind: 'lifestyle', text: 'Уже во VK.' }),
      'doc-123_42',
      99,
      '123',
      new Date().toISOString(),
    );
  const snap = weeklySnapshot(f.db, new Date('2026-10-07T10:00:00Z'), 'next');
  assert.equal(snap.missing, 0);
  assert.equal(snap.uncertain, 1);
  let started = 0;
  const first = await maybeStartSundayWeeklyPrepare(f.env, new Date('2026-10-11T17:05:00Z'), {
    ensure: false,
    client: { status: () => ({ canPrepare: true }) },
    prepare: async () => {
      started++;
    },
  });
  assert.equal(first.started, true);
  assert.equal(first.uncertain, 1);
  assert.equal(started, 1);
  f.db.close();
});

test('uncertain verify soft-fail does not abort later failed retries', async (t) => {
  const f = await fixture(t);
  const publishDate = Math.floor(Date.parse(f.week.start + 'T15:00:00.000Z') / 1000);
  f.db
    .prepare(
      `INSERT INTO vk_weekly_posts(plan_id,week_start,status,post_json,attachment,post_id,group_id,attempts,updated_at)
       VALUES ('p0',?,'uncertain',?,?,?,?,3,?)`,
    )
    .run(
      f.week.start,
      JSON.stringify({ id: 'weekly-x', kind: 'lifestyle', text: 'Уже во VK.' }),
      'doc-123_42',
      99,
      '123',
      new Date().toISOString(),
    );
  f.db
    .prepare(
      `INSERT INTO vk_weekly_posts(plan_id,week_start,status,error,attempts,updated_at)
       VALUES ('p1',?,'failed','vk_api_rejected_6',1,?)`,
    )
    .run(f.week.start, new Date().toISOString());
  let writes = 0;
  const receipts = new Map([
    [
      99,
      {
        id: 99,
        owner_id: -123,
        date: publishDate,
        post_type: 'post',
        attachments: [{ type: 'doc', doc: { owner_id: -123, id: 42 } }],
      },
    ],
  ]);
  const c = {
    accessToken: async () => 'test-secret',
    uploadWeeklyImage: async () => 'photo-123_42',
    api: async (method, parameters) => {
      if (method === 'wall.post') {
        writes++;
        const postId = 200 + writes;
        receipts.set(postId, {
          id: postId,
          owner_id: -123,
          date: parameters.publish_date,
          post_type: 'postponed',
          attachments: [{ type: 'photo', photo: { owner_id: -123, id: 42 } }],
        });
        return { post_id: postId };
      }
      return [receipts.get(Number(String(parameters.posts).split('_')[1]))];
    },
  };
  await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
    ...f.dependencies,
    client: c,
  });
  assert.equal(writes, 1);
  assert.equal(
    f.db.prepare("SELECT status FROM vk_weekly_posts WHERE plan_id='p1'").get().status,
    'deferred',
  );
  f.db.close();
});

test('weekly digest summarizes deferred holes once', async (t) => {
  const f = await fixture(t);
  const c = client();
  await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
    ...f.dependencies,
    client: c,
  });
  f.db
    .prepare(
      "UPDATE vk_weekly_posts SET status='failed', error='vk_api_rejected_6' WHERE plan_id='p1'",
    )
    .run();
  let messages = [];
  const first = await notifyWeeklyPrepareDigest(f.db, {
    weekStart: f.week.start,
    source: 'schedule',
    env: {
      ...f.env,
      TELEGRAM_BOT_TOKEN: '1:token',
      BOT_ALERT_CHAT_ID: '1',
    },
    notify: async (_config, html) => {
      messages.push(html);
    },
  });
  assert.equal(first.sent, true);
  assert.match(messages[0], /отложено: <b>1<\/b>/);
  assert.match(messages[0], /не готово: <b>1<\/b>/);
  const second = await notifyWeeklyPrepareDigest(f.db, {
    weekStart: f.week.start,
    source: 'schedule',
    env: {
      ...f.env,
      TELEGRAM_BOT_TOKEN: '1:token',
      BOT_ALERT_CHAT_ID: '1',
    },
    notify: async (_config, html) => {
      messages.push(html);
    },
  });
  assert.equal(second.skipped, 'deduped');
  assert.equal(messages.length, 1);
  assert.equal(summarizeWeek(f.db, f.week.start).deferred, 1);
  f.db.close();
});

test('digest ignores past pending slots for current week', async (t) => {
  const f = await fixture(t);
  const week = currentWeek(new Date('2026-10-08T12:00:00Z'));
  f.db.prepare('DELETE FROM schedule_slots').run();
  const stamp = new Date().toISOString();
  f.db
    .prepare(
      `INSERT INTO schedule_slots(plan_id,project_id,destination_id,slot_utc,slot_key,publication_kind,expected_media,config_version,created_at,updated_at)
       VALUES ('past','things','things-vk',?,?, 'text',NULL,'v1',?,?)`,
    )
    .run('2026-10-06T07:00:00.000Z', '2026-10-06@10:00[Europe/Moscow]', stamp, stamp);
  f.db
    .prepare(
      `INSERT INTO schedule_slots(plan_id,project_id,destination_id,slot_utc,slot_key,publication_kind,expected_media,config_version,created_at,updated_at)
       VALUES ('future','things','things-vk',?,?, 'text',NULL,'v1',?,?)`,
    )
    .run('2026-10-10T07:00:00.000Z', '2026-10-10@10:00[Europe/Moscow]', stamp, stamp);
  const summary = summarizeWeek(f.db, week.start, new Date('2026-10-08T12:00:00Z'));
  assert.equal(summary.total, 2);
  assert.equal(summary.missing, 1);
  assert.equal(summary.holes.length, 1);
  assert.match(summary.holes[0].when, /10\.10\.2026/);
  f.db.close();
});

test('cabinet button queues prepare for poster to run', async (t) => {
  const f = await fixture(t);
  queueWeeklyPrepare(f.db, f.week.start, 'button');
  assert.equal(weeklySnapshot(f.db, new Date('2026-10-07T10:00:00Z'), 'next').running, true);
  let started = 0;
  const result = await maybeRunQueuedWeeklyPrepare(f.env, new Date('2026-10-07T10:00:00Z'), {
    client: { status: () => ({ canPrepare: true }) },
    prepare: async (_env, week, owner) => {
      started += 1;
      assert.equal(week, f.week.start);
      assert.ok(owner);
    },
  });
  assert.equal(result.started, true);
  assert.equal(started, 1);
  // Meta cleared; job lease still held until real prepare finishes.
  const snap = weeklySnapshot(f.db, new Date('2026-10-07T10:00:00Z'), 'next');
  assert.equal(snap.running, true);
  const again = await maybeRunQueuedWeeklyPrepare(f.env, new Date('2026-10-07T10:00:00Z'), {
    client: { status: () => ({ canPrepare: true }) },
    prepare: async () => {
      started += 1;
    },
  });
  assert.equal(again.skipped, 'nothing_queued');
  assert.equal(started, 1);
  f.db.close();
});

test('weekly prepare skips video slots until user OAuth for video returns', async (t) => {
  const f = await fixture(t);
  f.db.prepare("UPDATE schedule_slots SET publication_kind='video',expected_media='video'").run();
  let writes = 0;
  const c = {
    accessToken: async () => 'test-secret',
    api: async () => {
      writes++;
      throw new Error('video_should_not_run');
    },
  };
  await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
    ...f.dependencies,
    client: c,
  });
  assert.equal(writes, 0);
  assert.equal(weeklySnapshot(f.db, new Date('2026-10-07T10:00:00Z'), 'next').total, 0);
});

test('next week is Monday through Sunday in Moscow even around UTC midnight', () => {
  assert.equal(nextWeek(new Date('2026-10-11T22:00:00Z')).start, '2026-10-19');
  assert.equal(nextWeek(new Date('2026-10-11T20:00:00Z')).start, '2026-10-12');
  assert.equal(currentWeek(new Date('2026-10-08T12:00:00Z')).start, '2026-10-05');
});

test('current week excludes past and already published from missing', async (t) => {
  const f = await fixture(t);
  const week = currentWeek(new Date('2026-10-08T12:00:00Z'));
  f.db.prepare('DELETE FROM schedule_slots').run();
  const stamp = new Date().toISOString();
  f.db
    .prepare(
      `INSERT INTO schedule_slots(plan_id,project_id,destination_id,slot_utc,slot_key,publication_kind,expected_media,plan_status,config_version,created_at,updated_at)
       VALUES ('past','things','things-vk',?,?, 'image','image','pending','v1',?,?)`,
    )
    .run('2026-10-06T15:00:00.000Z', '2026-10-06@18:00[Europe/Moscow]', stamp, stamp);
  f.db
    .prepare(
      `INSERT INTO schedule_slots(plan_id,project_id,destination_id,slot_utc,slot_key,publication_kind,expected_media,plan_status,config_version,created_at,updated_at)
       VALUES ('pub','things','things-vk',?,?, 'image','image','sent','v1',?,?)`,
    )
    .run('2026-10-09T15:00:00.000Z', '2026-10-09@18:00[Europe/Moscow]', stamp, stamp);
  f.db
    .prepare(
      `INSERT INTO schedule_slots(plan_id,project_id,destination_id,slot_utc,slot_key,publication_kind,expected_media,plan_status,config_version,created_at,updated_at)
       VALUES ('hole','things','things-vk',?,?, 'image','image','pending','v1',?,?)`,
    )
    .run('2026-10-10T15:00:00.000Z', '2026-10-10@18:00[Europe/Moscow]', stamp, stamp);
  const snap = weeklySnapshot(f.db, new Date('2026-10-08T12:00:00Z'), 'current');
  assert.equal(snap.week.start, week.start);
  assert.equal(snap.total, 3);
  assert.equal(snap.ready, 1);
  assert.equal(snap.missing, 1);
  assert.equal(snap.posts.find((p) => p.planId === 'pub').status, 'sent');
  assert.equal(snap.posts.find((p) => p.planId === 'past').past, true);
  f.db.close();
});

test('prepare skips slots already sent via plan_status', async (t) => {
  const f = await fixture(t);
  f.db.prepare("UPDATE schedule_slots SET plan_status='sent' WHERE plan_id='p0'").run();
  const c = client();
  await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
    ...f.dependencies,
    client: c,
  });
  assert.equal(c.writes, 1);
  assert.equal(
    f.db.prepare("SELECT status FROM vk_weekly_posts WHERE plan_id='p1'").get()?.status,
    'deferred',
  );
  assert.equal(
    f.db.prepare("SELECT status FROM vk_weekly_posts WHERE plan_id='p0'").get(),
    undefined,
  );
  f.db.close();
});

test('prepare only missing image posts; preserve editor brief and VK receipts across reruns', async (t) => {
  const f = await fixture(t);
  const c = client();
  f.db
    .prepare("UPDATE schedule_slots SET topic='Тёплый свет',brief='Без списков' WHERE plan_id='p0'")
    .run();
  let briefs = [];
  f.dependencies.generate = async (config, { id }) => {
    briefs.push(config);
    return { id, kind: 'lifestyle', text: 'Тёплый свет.' };
  };
  const owner = claimWeeklyJob(f.db, f.week.start);
  assert.equal(claimWeeklyJob(f.db, f.week.start), null);
  await prepareWeeklyPosts(f.env, f.week.start, owner, { ...f.dependencies, client: c });
  assert.equal(c.writes, 2);
  assert.deepEqual(briefs[0].editorialPlan, { topic: 'Тёплый свет', brief: 'Без списков' });
  assert.match(briefs[0].openrouterPrompt, /Без списков/);
  assert.equal(weeklySnapshot(f.db, new Date('2026-10-07T10:00:00Z'), 'next').complete, true);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM editions').get().n, 2);
  const second = claimWeeklyJob(f.db, f.week.start);
  await prepareWeeklyPosts(f.env, f.week.start, second, { ...f.dependencies, client: c });
  assert.equal(c.writes, 2);
  f.db.close();
});

test('explicit write rejection allows retry; successful slots and saved content are not regenerated', async (t) => {
  const f = await fixture(t);
  const rejection = Object.assign(new Error('vk_api_rejected_6'), { vkCode: 6 });
  const c = client(rejection);
  let generations = 0;
  f.dependencies.generate = async (config, { id }) => {
    generations++;
    return { id, kind: 'lifestyle', text: 'Дом.' };
  };
  await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
    ...f.dependencies,
    client: c,
  });
  assert.equal(weeklySnapshot(f.db, new Date('2026-10-07T10:00:00Z'), 'next').ready, 1);
  await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
    ...f.dependencies,
    client: c,
  });
  assert.equal(c.writes, 3);
  assert.equal(generations, 2);
  f.db.close();
});

test('slot stops after three attempts and is not selected again', async (t) => {
  const f = await fixture(t);
  f.db.prepare("DELETE FROM schedule_slots WHERE plan_id='p1'").run();
  let writes = 0;
  const c = {
    accessToken: async () => 'test-secret',
    uploadWeeklyImage: async () => 'doc-123_42',
    api: async (method, parameters) => {
      if (method === 'wall.post') {
        writes++;
        throw Object.assign(new Error('vk_api_rejected_6'), { vkCode: 6 });
      }
      return [];
    },
  };
  for (let i = 0; i < 4; i++) {
    await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
      ...f.dependencies,
      client: c,
    });
  }
  const row = f.db.prepare("SELECT status, attempts FROM vk_weekly_posts WHERE plan_id='p0'").get();
  assert.equal(row.status, 'exhausted');
  assert.equal(row.attempts, 3);
  assert.equal(writes, 3);
  assert.equal(weeklySnapshot(f.db, new Date('2026-10-07T10:00:00Z'), 'next').exhausted, 1);
  f.db.close();
});

test('three consecutive slot failures abort the rest of the weekly job', async (t) => {
  const f = await fixture(t);
  for (let i = 2; i < 5; i++) {
    const date = f.week.start;
    f.db
      .prepare(
        `INSERT INTO schedule_slots(plan_id,project_id,destination_id,slot_utc,slot_key,publication_kind,expected_media,config_version,created_at,updated_at) VALUES (?,'things','things-vk',?,?,'image','image','v1',?,?)`,
      )
      .run(
        'p' + i,
        date + 'T1' + i + ':00:00.000Z',
        date + '@1' + i + ':00[Europe/Moscow]',
        date,
        date,
      );
  }
  let tokens = 0;
  const c = {
    accessToken: async () => {
      tokens++;
      throw new Error('boom_not_vk_code');
    },
    api: async () => {
      throw new Error('should_not_reach_api');
    },
  };
  await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
    ...f.dependencies,
    client: c,
  });
  assert.equal(tokens, 3);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM vk_weekly_posts WHERE status='failed'").get().n,
    3,
  );
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vk_weekly_posts').get().n, 3);
  f.db.close();
});

test('unknown write outcome blocks that slot on every retry', async (t) => {
  const f = await fixture(t);
  const c = client(new Error('vk_api_transport_failure_no_retry'));
  await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
    ...f.dependencies,
    client: c,
  });
  const status = weeklySnapshot(f.db, new Date('2026-10-07T10:00:00Z'), 'next');
  assert.equal(status.uncertain, 1);
  assert.equal(status.missing, 0);
  await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
    ...f.dependencies,
    client: c,
  });
  assert.equal(c.writes, 2);
  f.db.close();
});

test('lost process lease turns posting into uncertain and never assumes success', async (t) => {
  const f = await fixture(t);
  f.db
    .prepare(
      "INSERT INTO vk_weekly_posts(plan_id,week_start,status,updated_at) VALUES ('p0',?,'posting',?)",
    )
    .run(f.week.start, new Date().toISOString());
  claimWeeklyJob(f.db, f.week.start);
  assert.equal(
    f.db.prepare("SELECT status FROM vk_weekly_posts WHERE plan_id='p0'").get().status,
    'uncertain',
  );
  f.db.close();
});

test('regular worker checks postponed receipt and marks sent only after real publication', async (t) => {
  const f = await fixture(t);
  const c = client();
  await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
    ...f.dependencies,
    client: c,
  });
  const slot = f.db.prepare("SELECT * FROM schedule_slots WHERE plan_id='p0'").get();
  const config = {
    projectId: 'things',
    destinationIds: ['things-vk'],
    vkToken: 'fake-community-key',
  };
  let type = 'postponed';
  let calls = 0;
  const fetcher = async (url, options) => {
    calls++;
    assert.match(url, /wall.getById$/);
    assert.equal(options.body.get('access_token'), 'fake-community-key');
    return {
      ok: true,
      json: async () => ({
        response: [
          { id: 1, owner_id: -123, date: Date.parse(slot.slot_utc) / 1000, post_type: type },
        ],
      }),
    };
  };
  const now = new Date(Date.parse(slot.slot_utc) + 1000);
  const delayed = await weeklyDelivery(config, slot.slot_key, now, fetcher, f.env);
  assert.equal(delayed.status, 'vk_scheduled');
  assert.equal(
    f.db.prepare("SELECT status FROM vk_weekly_posts WHERE plan_id='p0'").get().status,
    'deferred',
  );
  type = 'post';
  const sent = await weeklyDelivery(config, slot.slot_key, now, fetcher, f.env);
  assert.equal(sent.status, 'sent');
  assert.equal(sent.entry.image.vk.attachment, 'photo-123_42');
  await weeklyDelivery(config, slot.slot_key, now, fetcher, f.env);
  assert.equal(calls, 2);
  assert.equal(c.writes, 2);
  f.db.close();
});

test('successful write with missing photo remains uncertain and never posts again', async (t) => {
  const f = await fixture(t);
  const c = client();
  const api = c.api;
  c.api = async (method, p) => (method === 'wall.getById' ? [] : api(method, p));
  await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
    ...f.dependencies,
    client: c,
  });
  assert.equal(weeklySnapshot(f.db, new Date('2026-10-07T10:00:00Z'), 'next').uncertain, 2);
  await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
    ...f.dependencies,
    client: c,
  });
  assert.equal(c.writes, 2);
  f.db.close();
});

test('login verifies real user and permissions, consumes state once and never refreshes another app', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'legacy-test-'));
  const store = new OAuthStore(join(root, 'oauth.sqlite'), randomBytes(32).toString('hex'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  let now = 100000;
  const fetcher = async (url) => ({
    ok: true,
    json: async () => ({ response: url.includes('users.get') ? [{ id: 42 }] : 270340 }),
  });
  const legacy = new LegacyVkClient(
    store,
    {
      clientId: '54809516',
      redirectUri: 'https://oauth.vk.ru/blank.html',
      allowedUserId: '42',
    },
    fetcher,
    () => now,
  );
  const url = new URL(legacy.begin('session'));
  assert.equal(url.searchParams.get('response_type'), 'token');
  const body = {
    state: url.searchParams.get('state'),
    access_token: 'vk1.a.' + 'a'.repeat(30),
    expires_in: '86400',
  };
  const returnedUrl = 'https://oauth.vk.ru/blank.html#' + new URLSearchParams(body);
  assert.deepEqual(parseLegacyRedirectUrl(returnedUrl), body);
  await legacy.complete(parseLegacyRedirectUrl(returnedUrl), 'session');
  assert.equal(legacy.status().canPrepare, true);
  assert.equal(legacy.status().refreshAvailable, false);
  await assert.rejects(legacy.complete(body, 'session'), /invalid_state/);
  now += 86400001;
  assert.equal(legacy.status().canPrepare, false);
  await assert.rejects(legacy.accessToken(), /login_required/);
  const page = legacyCallbackPage();
  assert.match(page.html, /history.replaceState/);
  assert.match(page.html, /\/bot\/\?vk=connected/);
  const manual = legacyManualLoginPage(url.href);
  assert.match(manual.html, /id="vk-return" type="password"/);
  assert.match(manual.html, /credentials:'same-origin'/);
  assert.equal(manual.html.includes(body.access_token), false);
  assert.throws(
    () => parseLegacyRedirectUrl(returnedUrl.replace('oauth.vk.ru', 'evil.test')),
    /invalid_redirect/,
  );
  assert.throws(
    () => parseLegacyRedirectUrl(returnedUrl.replace('https:', 'http:')),
    /invalid_redirect/,
  );
  assert.throws(
    () => parseLegacyRedirectUrl('https://oauth.vk.ru/blank.html#error=access_denied'),
    /consent_required/,
  );
  const wrong = new URL(legacy.begin('session'));
  await assert.rejects(
    legacy.complete({ ...body, state: wrong.searchParams.get('state') }, 'other-session'),
    /invalid_state/,
  );
  legacy.config.redirectUri = 'https://oauth.vk.com/blank.html';
  const comLogin = new URL(legacy.begin('session'));
  assert.equal(comLogin.origin, 'https://oauth.vk.com');
  assert.equal(comLogin.searchParams.get('redirect_uri'), 'https://oauth.vk.com/blank.html');
});

test('weekly preparation defaults to community tokens when user oauth is disabled', () => {
  const env = {
    VK_LEGACY_OAUTH_ENABLED: 'false',
    VK_WEEKLY_OAUTH_ENABLED: 'false',
    BOT_CONFIG_PATH: join(process.cwd(), 'bot/service.json'),
    VK_ACCESS_TOKEN: 'vk1.a.community-code',
    VK_CODE_TO_THINK_GROUP_ID: '242034586',
    VK_DARK_ACADEMIA_ACCESS_TOKEN: 'vk1.a.community-dark',
    VK_DARK_ACADEMIA_GROUP_ID: '194579254',
    VK_THINGS_ACCESS_TOKEN: 'vk1.a.community-things',
    VK_THINGS_GROUP_ID: '242058626',
  };
  const targets = listWeeklyCommunityTargets(env);
  assert.equal(targets.length, 3);
  const client = getWeeklyVkClient(env);
  assert.equal(client.mode, 'community');
  assert.equal(client.status().canPrepare, true);
  client.bindGroup('194579254');
  assert.equal(client.accessToken(), 'vk1.a.community-dark');
});

test('owner oauth can be enabled while weekly posts stay on community', () => {
  const env = {
    VK_LEGACY_OAUTH_ENABLED: 'false',
    VK_WEEKLY_OAUTH_ENABLED: 'true',
    VK_WEEKLY_CLIENT_ID: '54809454',
    VK_OAUTH_REDIRECT_URI: 'https://www.dvzverev.ru/vk/callback/',
    VK_OAUTH_ENCRYPTION_KEY: 'a'.repeat(64),
    VK_OAUTH_STORE_PATH: join(tmpdir(), `vk-owner-${Date.now()}.sqlite`),
    BOT_CONFIG_PATH: join(process.cwd(), 'bot/service.json'),
    VK_ACCESS_TOKEN: 'vk1.a.community-code',
    VK_CODE_TO_THINK_GROUP_ID: '242034586',
    VK_DARK_ACADEMIA_ACCESS_TOKEN: 'vk1.a.community-dark',
    VK_DARK_ACADEMIA_GROUP_ID: '194579254',
    VK_THINGS_ACCESS_TOKEN: 'vk1.a.community-things',
    VK_THINGS_GROUP_ID: '242058626',
  };
  assert.equal(getWeeklyVkClient(env).mode, 'community');
  const owner = getOwnerVkClient(env);
  assert.equal(owner.mode || owner.status().mode, 'owner');
  const status = weeklyVkStatus(env);
  assert.equal(status.mode, 'community');
  assert.equal(status.canPrepare, true);
  assert.equal(status.ownerOAuth.available, true);
  assert.equal(status.ownerOAuth.connected, false);
  owner.store.close();
});

test('rejected manual token is never stored and its attempt cannot be replayed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vk-rejected-'));
  const store = new OAuthStore(join(root, 'oauth.sqlite'), randomBytes(32).toString('hex'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const client = new LegacyVkClient(
    store,
    {
      clientId: '54809516',
      redirectUri: 'https://oauth.vk.ru/blank.html',
      allowedUserId: '42',
    },
    async () => ({
      ok: true,
      json: async () => ({
        error: {
          error_code: 5,
          error_msg: 'User authorization failed: access_token was given to another ip address.',
        },
      }),
    }),
  );
  const body = {
    state: new URL(client.begin('session')).searchParams.get('state'),
    access_token: 'vk1.a.' + 'a'.repeat(30),
    expires_in: '86400',
  };
  await assert.rejects(client.complete(body, 'session'), /vk_api_rejected_5_ip_mismatch/);
  assert.equal(store.get('token'), null);
  assert.equal(client.status().connected, false);
  await assert.rejects(client.complete(body, 'session'), /invalid_state/);
});
