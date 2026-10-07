import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCabinetDb, setMeta } from '../../bot/cabinet/db.mjs';
import { syncProjects } from '../../bot/cabinet/projects.mjs';
import { materializeScheduleSlots, syncProjectState } from '../../bot/cabinet/sync.mjs';
import { startCabinetServer } from '../../bot/cabinet/server.mjs';
import { buildOverview } from '../../bot/cabinet/overview.mjs';
import {
  ensureRubrics,
  listRubrics,
  rubricService,
  changeRubric,
  createRubric,
  validateRubric,
  applyRubricConfig,
  assertSlotCurrent,
} from '../../bot/cabinet/rubrics.mjs';
import { weeklySnapshot } from '../../bot/cabinet/weekly.mjs';
import { publish } from '../../bot/core.mjs';
import { taskStatusFromState } from '../../bot/redis/runner.mjs';

const now = new Date('2099-10-07T10:00:00Z');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rubrics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    BOT_CABINET_DB_PATH: join(root, 'db.sqlite'),
    BOT_CONFIG_PATH: join(root, 'missing.json'),
  };
  const db = openCabinetDb(env);
  t.after(() => db.close());
  const project = {
    enabled: true,
    format: 'lifestyle',
    schedule: { timezone: 'Europe/Moscow', times: ['18:00'] },
    delivery: { destinations: ['g-vk'] },
  };
  const service = {
    projects: { g: project },
    destinations: {
      'g-vk': { platform: 'vk', media: { kind: 'image', times: ['18:00'], enabled: true } },
    },
  };
  setMeta(db, 'service_config_version', 'test');
  syncProjects(db, service, 'test');
  materializeScheduleSlots(db, service, env, now);
  ensureRubrics(db, service, now);
  materializeScheduleSlots(db, service, env, now);
  const rubric = listRubrics(db)[0];
  const slots = db
    .prepare('SELECT * FROM schedule_slots WHERE slot_utc>? ORDER BY slot_utc')
    .all(now.toISOString());
  return { root, db, env, service, rubric, slots };
}

test('bootstrap preserves existing slot ids and creates each group schedule only once', async (t) => {
  const f = await fixture(t);
  ensureRubrics(f.db, f.service, now);
  assert.equal(listRubrics(f.db).length, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM rubric_slots').get().n, 21);
  assert.equal(
    f.db.prepare('SELECT plan_id FROM schedule_slots WHERE plan_id=?').get(f.slots[0].plan_id)
      .plan_id,
    f.slots[0].plan_id,
  );
});

test('reject conflicts within group, accept same time in another group and paused rubric', async (t) => {
  const f = await fixture(t);
  assert.throws(
    () => createRubric(f.db, f.service, 'g', { ...f.rubric, name: 'Другая' }),
    /schedule_conflict/,
  );
  assert.doesNotThrow(() =>
    createRubric(f.db, f.service, 'g', { ...f.rubric, name: 'Пауза', enabled: false }),
  );
  f.service.projects.other = f.service.projects.g;
  assert.doesNotThrow(() =>
    createRubric(f.db, f.service, 'other', { ...f.rubric, name: 'Другая группа' }),
  );
  assert.throws(() => validateRubric({ ...f.rubric, days: [0] }), /invalid/);
  assert.throws(() => validateRubric({ ...f.rubric, times: ['25:00'] }), /invalid/);
});

test('editing rebuilds unpublished slots but keeps published badge and content', async (t) => {
  const f = await fixture(t);
  const published = f.slots[0];
  f.db
    .prepare(
      `INSERT INTO editions(edition_id,project_id,slot_key,format,body_text,aggregate_status,created_at,updated_at) VALUES ('sent','g',?,'lifestyle','Старый текст','sent',?,?)`,
    )
    .run(published.slot_key, now.toISOString(), now.toISOString());
  f.db
    .prepare("UPDATE schedule_slots SET edition_id='sent',plan_status='sent' WHERE plan_id=?")
    .run(published.plan_id);
  await changeRubric(
    f.db,
    f.rubric.id,
    { ...f.rubric, name: 'Новое имя', textPrompt: 'Новый промпт' },
    { now },
  );
  materializeScheduleSlots(f.db, f.service, f.env, now);
  assert.equal(
    f.db.prepare('SELECT label FROM rubric_slots WHERE plan_id=?').get(published.plan_id).label,
    f.rubric.name,
  );
  assert.equal(
    f.db.prepare('SELECT body_text FROM editions WHERE edition_id=?').get('sent').body_text,
    'Старый текст',
  );
  assert.equal(
    f.db
      .prepare('SELECT label,hidden,revision FROM rubric_slots WHERE plan_id=?')
      .get(f.slots[1].plan_id).label,
    'Новое имя',
  );
  assert.equal(
    assertSlotCurrent(
      f.db,
      f.db.prepare('SELECT * FROM schedule_slots WHERE plan_id=?').get(f.slots[1].plan_id),
    ).revision,
    2,
  );
  assert.throws(() => assertSlotCurrent(f.db, f.slots[1]), /cancelled/);
});

test('deleting hides every calendar post and never resurrects the former schedule', async (t) => {
  const f = await fixture(t);
  f.db
    .prepare(
      `INSERT INTO editions(edition_id,project_id,slot_key,format,body_text,aggregate_status,created_at,updated_at) VALUES ('published','g',?,'lifestyle','Опубликованный текст','sent',?,?)`,
    )
    .run(f.slots[0].slot_key, now.toISOString(), now.toISOString());
  f.db
    .prepare("UPDATE schedule_slots SET edition_id='published',plan_status='sent' WHERE plan_id=?")
    .run(f.slots[0].plan_id);
  await changeRubric(f.db, f.rubric.id, { revision: 1 }, { remove: true, now });
  ensureRubrics(f.db, f.service, now);
  materializeScheduleSlots(f.db, f.service, f.env, now);
  assert.deepEqual(rubricService(f.db, f.service).projects.g.schedule.times, []);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM rubric_slots WHERE hidden=0').get().n, 0);
  const overview = await buildOverview(f.db, { week: '2099-10-07' }, f.env);
  assert.equal(overview.cards.length, 0);
  assert.equal(
    f.db.prepare("SELECT body_text FROM editions WHERE edition_id='published'").get().body_text,
    'Опубликованный текст',
  );
});

test('VK cancellation requires login and is durable and retryable after network failure', async (t) => {
  const f = await fixture(t);
  const slot = f.slots[0];
  f.db
    .prepare(
      "INSERT INTO vk_weekly_posts(plan_id,week_start,status,post_id,group_id,updated_at) VALUES (?,?,'scheduled',42,'123',?)",
    )
    .run(slot.plan_id, '2099-10-05', now.toISOString());
  await assert.rejects(
    changeRubric(f.db, f.rubric.id, { revision: 1 }, { remove: true, now }),
    /vk_login_required/,
  );
  assert.equal(listRubrics(f.db)[0].state, 'active');
  let fail = true;
  let removed = 0;
  const client = {
    status: () => ({ canPrepare: true }),
    api: async (method) => {
      if (method === 'wall.getById')
        return [
          { id: 42, owner_id: -123, date: Date.parse(slot.slot_utc) / 1000, post_type: 'postpone' },
        ];
      if (fail) throw new Error('network');
      removed++;
      return 1;
    },
  };
  await assert.rejects(
    changeRubric(f.db, f.rubric.id, { revision: 1 }, { remove: true, client, now }),
    /network/,
  );
  assert.equal(listRubrics(f.db)[0].state, 'deleting');
  assert.deepEqual(rubricService(f.db, f.service).projects.g.schedule.times, []);
  fail = false;
  await changeRubric(f.db, f.rubric.id, { revision: 1 }, { remove: true, client, now });
  assert.equal(removed, 1);
  assert.equal(listRubrics(f.db).length, 0);
});

test('unknown outcomes and media preparation block edits before changing schedule', async (t) => {
  const f = await fixture(t);
  f.db
    .prepare(
      "INSERT INTO vk_weekly_posts(plan_id,week_start,status,updated_at) VALUES (?,?,'posting',?)",
    )
    .run(f.slots[0].plan_id, '2099-10-05', now.toISOString());
  await assert.rejects(
    changeRubric(f.db, f.rubric.id, { ...f.rubric, name: 'Changed' }, { now }),
    /preparation_busy/,
  );
  assert.equal(listRubrics(f.db)[0].revision, 1);
});

test('rubric prompts supplement system style and media format determines weekly preparation', () => {
  const c = applyRubricConfig(
    { openrouterPrompt: 'SYSTEM', coverPrompt: 'GROUP STYLE', videoPrompt: 'CAMERA' },
    {
      id: 'r',
      revision: 2,
      name: 'Новая',
      textPrompt: 'TEXT',
      mediaPrompt: 'DETAIL',
      media: 'video',
      times: ['18:00'],
    },
  );
  assert.match(c.openrouterPrompt, /SYSTEM[\s\S]*TEXT/);
  assert.match(c.coverPrompt, /GROUP STYLE[\s\S]*DETAIL/);
  assert.match(c.videoPrompt, /CAMERA[\s\S]*DETAIL/);
  assert.equal(c.weeklyImages, true);
});

test('Redis ignores failures and unfinished generation from the old rubric revision', () => {
  const task = { slotKey: 's', status: 'planned', rubricRevision: 2 };
  assert.equal(
    taskStatusFromState(task, {
      entries: [{ slot: 's', status: 'failed', rubricRevision: 1 }],
      pendingGeneration: { slot: 's', rubricRevision: 1 },
    }),
    'planned',
  );
  assert.equal(
    taskStatusFromState(
      { ...task, status: 'cancelled' },
      { entries: [{ slot: 's', status: 'sent', platform: 'vk' }] },
    ),
    'cancelled',
  );
});

test('published VK receipt is preserved during editing, even before local receipt sync', async (t) => {
  const f = await fixture(t);
  const slot = f.slots[0];
  let deleted = 0;
  f.db
    .prepare(
      "INSERT INTO vk_weekly_posts(plan_id,week_start,status,post_id,group_id,updated_at) VALUES (?,?,'scheduled',42,'123',?)",
    )
    .run(slot.plan_id, '2099-10-05', now.toISOString());
  const client = {
    status: () => ({ canPrepare: true }),
    api: async (method) => {
      if (method === 'wall.delete') {
        deleted++;
        return 1;
      }
      return [{ id: 42, owner_id: -123, date: now.getTime() / 1000, post_type: 'post' }];
    },
  };
  await changeRubric(f.db, f.rubric.id, { ...f.rubric, name: 'Новое имя' }, { client, now });
  assert.equal(deleted, 0);
  assert.equal(
    f.db.prepare('SELECT plan_status FROM schedule_slots WHERE plan_id=?').get(slot.plan_id)
      .plan_status,
    'sent',
  );
  assert.equal(
    f.db.prepare('SELECT label FROM rubric_slots WHERE plan_id=?').get(slot.plan_id).label,
    f.rubric.name,
  );
});

test('concurrent cancellation cannot modify the same rubric twice', async (t) => {
  const f = await fixture(t);
  const slot = f.slots[0];
  f.db
    .prepare(
      "INSERT INTO vk_weekly_posts(plan_id,week_start,status,post_id,group_id,updated_at) VALUES (?,?,'scheduled',42,'123',?)",
    )
    .run(slot.plan_id, '2099-10-05', now.toISOString());
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const client = {
    status: () => ({ canPrepare: true }),
    api: async (method) => {
      if (method === 'wall.delete') {
        await gate;
        return 1;
      }
      return [
        { id: 42, owner_id: -123, date: Date.parse(slot.slot_utc) / 1000, post_type: 'postpone' },
      ];
    },
  };
  const first = changeRubric(f.db, f.rubric.id, { revision: 1 }, { remove: true, client, now });
  await assert.rejects(
    changeRubric(f.db, f.rubric.id, { revision: 1 }, { remove: true, client, now }),
    /preparation_busy/,
  );
  release();
  await first;
  assert.equal(
    f.db.prepare('SELECT revision FROM schedule_rubrics WHERE id=?').get(f.rubric.id).revision,
    2,
  );
});

test('calendar exposes rubric badges and filters before computing calendar counters', async (t) => {
  const f = await fixture(t);
  const overview = await buildOverview(
    f.db,
    { week: '2099-10-07', rubricFilter: f.rubric.id },
    f.env,
  );
  assert.equal(overview.cards.length, 7);
  assert.equal(overview.cards[0].rubricLabel, f.rubric.name);
  const none = await buildOverview(f.db, { week: '2099-10-07', rubricFilter: 'none' }, f.env);
  assert.equal(none.cards.length, 0);
  assert.equal(none.summary.materials, 0);
});

test('current week supplement contains only remaining future media slots', async (t) => {
  const f = await fixture(t);
  const snapshot = weeklySnapshot(f.db, now, true);
  assert.ok(snapshot.total > 0);
  assert.ok(snapshot.posts.every((p) => p.date > now.toISOString()));
  assert.ok(snapshot.posts.every((p) => p.date < snapshot.week.to));
});

test('stale scheduler task cannot generate or send after rubric deletion', async (t) => {
  const f = await fixture(t);
  const slot = f.slots[0];
  await changeRubric(f.db, f.rubric.id, { revision: 1 }, { remove: true, now });
  let calls = 0;
  const result = await publish(
    {
      projectId: 'g',
      rubricsManaged: true,
      cabinetDbPath: f.env.BOT_CABINET_DB_PATH,
      statePath: join(f.root, 'state.json'),
    },
    {
      now,
      scheduledTask: { id: slot.plan_id, slotKey: slot.slot_key, version: 1 },
      generate: async () => {
        calls++;
      },
      sendVK: async () => {
        calls++;
      },
    },
  );
  assert.equal(result.status, 'cancelled');
  assert.equal(calls, 0);
});

test('old state sync cannot restore cancelled or edited rubric slots', async (t) => {
  const f = await fixture(t);
  const slot = f.slots[0];
  f.service.projects.g.statePath = 'state/g.json';
  await mkdir(join(f.root, 'state'));
  await writeFile(
    join(f.root, 'state/g.json'),
    JSON.stringify({
      entries: [{ slot: slot.slot_key, status: 'retry_wait', platform: 'vk', html: 'Old draft' }],
    }),
  );
  await changeRubric(f.db, f.rubric.id, { revision: 1 }, { remove: true, now });
  await syncProjectState(f.db, f.service, 'g', f.env, now);
  assert.equal(
    f.db
      .prepare('SELECT plan_status,edition_id FROM schedule_slots WHERE plan_id=?')
      .get(slot.plan_id).plan_status,
    'cancelled',
  );
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM editions').get().n, 0);
});

test('recreating a rubric at the same time never adopts the deleted rubric draft', async (t) => {
  const f = await fixture(t);
  const slot = f.slots[0];
  f.service.projects.g.statePath = 'state/g.json';
  await mkdir(join(f.root, 'state'));
  await writeFile(
    join(f.root, 'state/g.json'),
    JSON.stringify({
      entries: [
        {
          slot: slot.slot_key,
          status: 'retry_wait',
          platform: 'vk',
          html: 'Deleted draft',
          rubricRevision: 1,
          rubricId: f.rubric.id,
        },
      ],
    }),
  );
  await changeRubric(f.db, f.rubric.id, { revision: 1 }, { remove: true, now });
  const fresh = createRubric(f.db, f.service, 'g', { ...f.rubric, name: 'Другая рубрика' }, now);
  materializeScheduleSlots(f.db, f.service, f.env, now);
  assert.equal(
    f.db.prepare('SELECT rubric_id FROM rubric_slots WHERE plan_id=?').get(slot.plan_id).rubric_id,
    fresh.id,
  );
  await syncProjectState(f.db, f.service, 'g', f.env, now);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM editions').get().n, 0);
  assert.equal(
    taskStatusFromState(
      { slotKey: slot.slot_key, status: 'planned', rubricRevision: 1, rubricId: fresh.id },
      {
        entries: [
          { slot: slot.slot_key, status: 'retry_wait', rubricId: f.rubric.id, rubricRevision: 1 },
        ],
      },
    ),
    'planned',
  );
});

test('rubric HTTP API protects session, Origin and revisions and supports DELETE preflight', async (t) => {
  const f = await fixture(t);
  await writeFile(f.env.BOT_CONFIG_PATH, JSON.stringify(f.service));
  const env = {
    ...f.env,
    BOT_CABINET_PASSWORD: 'test-password',
    BOT_CABINET_HOST: '127.0.0.1',
    BOT_CABINET_PORT: '0',
    BOT_CABINET_ALLOWED_ORIGINS: 'https://cabinet.test',
  };
  const server = startCabinetServer(env);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/bot/api/v1`;
  assert.equal((await fetch(base + '/rubrics')).status, 401);
  const login = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { Origin: 'https://cabinet.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-password' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = {
    Cookie: cookie,
    Origin: 'https://cabinet.test',
    'Content-Type': 'application/json',
  };
  const preflight = await fetch(base + '/rubrics/' + f.rubric.id, {
    method: 'OPTIONS',
    headers: { Origin: 'https://cabinet.test', 'Access-Control-Request-Method': 'DELETE' },
  });
  assert.match(preflight.headers.get('access-control-allow-methods'), /DELETE/);
  assert.equal(
    (
      await fetch(base + '/rubrics/' + f.rubric.id, {
        method: 'DELETE',
        headers: { Cookie: cookie },
        body: JSON.stringify({ revision: 1 }),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + '/rubrics/' + f.rubric.id, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ ...f.rubric, revision: 0 }),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await fetch(base + '/rubrics/' + f.rubric.id, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ revision: 1 }),
      })
    ).status,
    200,
  );
  assert.equal(listRubrics(f.db).length, 0);
});
