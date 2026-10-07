import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearLoginDefenseState,
  createSession,
  getLoginLockStatus,
  hashPassword,
  recordLoginFailure,
  verifyPassword,
} from '../../bot/cabinet/auth.mjs';
import { openCabinetDb } from '../../bot/cabinet/db.mjs';
import { refreshServiceSnapshot } from '../../bot/cabinet/projects.mjs';
import { startCabinetServer } from '../../bot/cabinet/server.mjs';
import { schedulerHeartbeatStatus } from '../../bot/health.mjs';
import { materializeScheduleSlots, syncProjectState } from '../../bot/cabinet/sync.mjs';
import { buildOverview, patchPlan } from '../../bot/cabinet/overview.mjs';
import {
  aggregateEditionStatus,
  canRetryPublication,
  classifyReleaseSource,
  projectTitle,
  summaryBucket,
} from '../../bot/cabinet/status.mjs';
import {
  isoWeekStart,
  localSlotToUtc,
  scheduledTimesForDay,
  slotKey,
} from '../../bot/cabinet/time.mjs';

const service = {
  providers: {
    'budget-editor': { adapter: 'openrouter', credentialEnv: 'OPENROUTER_API_KEY', model: 'test' },
  },
  destinations: {
    'code-to-think-vk': { platform: 'vk', media: { enabled: false } },
    'connaissance-vk': {
      platform: 'vk',
      media: { enabled: true, kind: 'video', times: ['18:00'] },
    },
    'things-vk': {
      platform: 'vk',
      media: { enabled: true, kind: 'video', times: ['18:00'] },
    },
  },
  projects: {
    'code-to-think': {
      enabled: true,
      format: 'programming',
      schedule: {
        timezone: 'Europe/Moscow',
        times: ['12:00', '18:00'],
        weekly: {
          1: ['12:00', '18:00'],
          2: ['12:00'],
          3: ['12:00', '18:00'],
          4: ['12:00'],
          5: ['12:00', '18:00'],
          6: ['12:00'],
          7: ['12:00', '18:00'],
        },
        missedSlots: 'skip',
      },
      delivery: { destinations: ['code-to-think-vk'] },
      statePath: 'data/projects/code-to-think/state.json',
    },
    'dark-academia': {
      enabled: true,
      format: 'literary',
      schedule: {
        timezone: 'Europe/Moscow',
        times: ['10:00', '18:00'],
        missedSlots: 'skip',
      },
      delivery: { destinations: ['connaissance-vk'] },
      statePath: 'data/projects/dark-academia/state.json',
    },
    things: {
      enabled: true,
      format: 'lifestyle',
      schedule: {
        timezone: 'Europe/Moscow',
        times: ['10:00', '18:00'],
        missedSlots: 'skip',
      },
      delivery: { destinations: ['things-vk'] },
      statePath: 'data/projects/things/state.json',
    },
  },
};

test('auth verifies password hash roundtrip', () => {
  const encoded = hashPassword('secret');
  assert.equal(verifyPassword('secret', encoded), true);
  assert.equal(verifyPassword('wrong', encoded), false);
});

function mockLoginRequest(ip = '203.0.113.9') {
  return { socket: { remoteAddress: ip } };
}

async function postCabinetLogin(port, password, origin = 'http://127.0.0.1:4321') {
  return fetch(`http://127.0.0.1:${port}/bot/api/v1/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
    },
    body: JSON.stringify({ password }),
  });
}

test('login lockout after repeated failures', () => {
  clearLoginDefenseState();
  const env = {
    BOT_CABINET_LOGIN_MAX_ATTEMPTS: '3',
    BOT_CABINET_LOGIN_WINDOW_SEC: '60',
    BOT_CABINET_LOGIN_LOCKOUT_SEC: '120',
  };
  const request = mockLoginRequest();
  assert.equal(recordLoginFailure(request, env).locked, false);
  assert.equal(recordLoginFailure(request, env).locked, false);
  const third = recordLoginFailure(request, env);
  assert.equal(third.locked, true);
  assert.ok(third.retryAfterSeconds >= 120);
  const status = getLoginLockStatus(request, env);
  assert.equal(status.locked, true);
  assert.ok(status.retryAfterSeconds > 0);
  clearLoginDefenseState();
});

test('login API returns 429 with Retry-After when locked', async (t) => {
  clearLoginDefenseState();
  t.after(() => clearLoginDefenseState());
  const dir = await mkdtemp(join(tmpdir(), 'cabinet-lockout-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = {
    ...process.env,
    BOT_CABINET_DB_PATH: join(dir, 'cabinet.sqlite'),
    BOT_CABINET_PASSWORD: 'test-password',
    BOT_CABINET_HOST: '127.0.0.1',
    BOT_CABINET_LOGIN_MAX_ATTEMPTS: '2',
    BOT_CABINET_LOGIN_WINDOW_SEC: '60',
    BOT_CABINET_LOGIN_LOCKOUT_SEC: '90',
  };
  openCabinetDb(env).close();
  const server = startCabinetServer({ ...env, BOT_CABINET_PORT: '0' });
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const first = await postCabinetLogin(address.port, 'wrong');
  assert.equal(first.status, 401);
  const second = await postCabinetLogin(address.port, 'wrong');
  assert.equal(second.status, 429);
  assert.equal(second.headers.get('retry-after'), '90');
  const body = await second.json();
  assert.equal(body.error, 'rate_limited');

  const whileLocked = await postCabinetLogin(address.port, 'test-password');
  assert.equal(whileLocked.status, 429);
  assert.ok(Number(whileLocked.headers.get('retry-after')) > 0);
});

test('overview API requires session', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cabinet-http-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const document = JSON.parse(await readFile(join(process.cwd(), 'bot/service.json'), 'utf8'));
  const env = {
    ...process.env,
    BOT_CABINET_DB_PATH: join(dir, 'cabinet.sqlite'),
    BOT_CABINET_PASSWORD: 'test-password',
    BOT_CABINET_HOST: '127.0.0.1',
  };
  const db = openCabinetDb(env);
  refreshServiceSnapshot(db, document);
  materializeScheduleSlots(db, document, env);
  db.close();
  const server = startCabinetServer({ ...env, BOT_CABINET_PORT: '0' });
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const denied = await fetch(`http://127.0.0.1:${address.port}/bot/api/v1/overview`);
  assert.equal(denied.status, 401);
  const checkDb = openCabinetDb(env);
  const session = createSession(checkDb, env);
  const before = checkDb
    .prepare("SELECT value FROM cabinet_meta WHERE key='data_version'")
    .get().value;
  for (const path of ['overview', 'weekly-preparation', 'weekly-preparation?scope=current']) {
    const response = await fetch(`http://127.0.0.1:${address.port}/bot/api/v1/${path}`, {
      headers: { Cookie: `cabinet_session=${session.token}` },
    });
    assert.equal(response.status, 200);
    await response.json();
  }
  assert.equal(
    checkDb.prepare("SELECT value FROM cabinet_meta WHERE key='data_version'").get().value,
    before,
    'reading the calendar and preparation must not rebuild the schedule',
  );
  checkDb.close();
});

test('week boundaries and code schedule respect weekdays', () => {
  assert.equal(isoWeekStart('2026-10-07', 'Europe/Moscow'), '2026-10-05');
  const mondayTimes = scheduledTimesForDay(
    service.projects['code-to-think'].schedule,
    '2026-10-05',
    'Europe/Moscow',
  );
  const tuesdayTimes = scheduledTimesForDay(
    service.projects['code-to-think'].schedule,
    '2026-10-06',
    'Europe/Moscow',
  );
  assert.deepEqual(mondayTimes, ['12:00', '18:00']);
  assert.deepEqual(tuesdayTimes, ['12:00']);
  const key = slotKey('2026-10-05', '10:00', 'Europe/Moscow');
  assert.match(key, /\[Europe\/Moscow\]$/);
  assert.equal(
    localSlotToUtc('2026-10-05', '10:00', 'Europe/Moscow').toISOString(),
    '2026-10-05T07:00:00.000Z',
  );
});

test('aggregate status distinguishes partial and uncertain', () => {
  assert.equal(aggregateEditionStatus(['sent', 'failed']), 'partially_sent');
  assert.equal(summaryBucket('partially_sent'), 'sent');
  assert.notEqual(summaryBucket('uncertain'), 'sent');
  assert.equal(aggregateEditionStatus(['uncertain']), 'uncertain');
});

test('materialize is idempotent and marks missed slots', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cabinet-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, BOT_CABINET_DB_PATH: join(dir, 'cabinet.sqlite') };
  const db = openCabinetDb(env);
  refreshServiceSnapshot(db, service);
  const now = new Date('2026-10-06T08:00:00Z');
  const first = materializeScheduleSlots(db, service, env, now);
  const second = materializeScheduleSlots(db, service, env, now);
  assert.ok(first > 0);
  assert.equal(second, 0);
  const missed = db
    .prepare(
      `SELECT COUNT(*) AS count FROM schedule_slots WHERE plan_status = 'missed' AND slot_key LIKE '2026-10-05@%'`,
    )
    .get().count;
  assert.ok(missed > 0);
  db.close();
});

test('resync does not inflate open incident count', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cabinet-incident-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = {
    ...process.env,
    BOT_CABINET_DB_PATH: join(dir, 'cabinet.sqlite'),
    BOT_CONFIG_PATH: join(dir, 'service.json'),
    OPENROUTER_API_KEY: 'test-key',
    VK_DARK_ACADEMIA_ACCESS_TOKEN: 'vk-test',
    VK_DARK_ACADEMIA_GROUP_ID: '1',
  };
  await writeFile(env.BOT_CONFIG_PATH, JSON.stringify(service));
  const stateDir = join(dir, 'data/projects/partial');
  await mkdir(stateDir, { recursive: true });
  service.projects.partial = {
    enabled: true,
    format: 'literary',
    postSource: 'openrouter',
    generation: { provider: 'budget-editor' },
    schedule: service.projects['dark-academia'].schedule,
    delivery: { destinations: ['connaissance-vk'] },
    statePath: 'data/projects/partial/state.json',
  };
  await writeFile(env.BOT_CONFIG_PATH, JSON.stringify(service));
  const slot = '2026-10-06@10:00[Europe/Moscow]';
  const stateBody = {
    version: 1,
    chatId: '',
    entries: [
      {
        slot,
        status: 'failed',
        platform: 'vk',
        postId: 'p1',
        createdAt: '2026-10-06T07:05:00.000Z',
        attempts: 2,
        errors: [{ platform: 'vk', reason: 'vk_error', errorCode: 6, attempts: 2 }],
      },
    ],
    pauses: {},
    cooldowns: {},
  };
  await writeFile(join(dir, service.projects.partial.statePath), JSON.stringify(stateBody));
  const db = openCabinetDb(env);
  refreshServiceSnapshot(db, service);
  materializeScheduleSlots(db, service, env, new Date('2026-10-06T12:00:00Z'));
  await syncProjectState(db, service, 'partial', env, new Date('2026-10-06T12:00:00Z'));
  await syncProjectState(db, service, 'partial', env, new Date('2026-10-06T12:05:00Z'));
  const row = db
    .prepare(`SELECT count FROM incidents WHERE project_id = 'partial' AND status = 'open'`)
    .get();
  assert.equal(row?.count, 1);
  db.close();
});

test('schedulerHeartbeatStatus ignores foreign PID when file is fresh', () => {
  const now = Date.now();
  const status = schedulerHeartbeatStatus({ pid: 999999, updatedAt: now - 3000 }, now);
  assert.equal(status.ok, true);
  assert.equal(status.ageSeconds, 3);
});

test('partial delivery counts as sent bucket not full failure', async () => {
  assert.equal(summaryBucket('partially_sent'), 'sent');
  assert.equal(summaryBucket('failed'), 'failed');
});

test('fixture partial delivery summary matches registry', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cabinet-fixture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = {
    ...process.env,
    BOT_CABINET_DB_PATH: join(dir, 'cabinet.sqlite'),
    BOT_CONFIG_PATH: join(dir, 'service.json'),
    OPENROUTER_API_KEY: 'test-key',
    VK_DARK_ACADEMIA_ACCESS_TOKEN: 'vk-test',
    VK_DARK_ACADEMIA_GROUP_ID: '1',
  };
  await writeFile(env.BOT_CONFIG_PATH, JSON.stringify(service));
  const stateDir = join(dir, 'data/projects/partial');
  await mkdir(stateDir, { recursive: true });
  service.projects.partial = {
    enabled: true,
    format: 'literary',
    postSource: 'openrouter',
    generation: { provider: 'budget-editor' },
    schedule: service.projects['dark-academia'].schedule,
    delivery: { destinations: ['connaissance-vk'] },
    statePath: 'data/projects/partial/state.json',
  };
  await writeFile(env.BOT_CONFIG_PATH, JSON.stringify(service));
  const slot = '2026-10-06@10:00[Europe/Moscow]';
  await writeFile(
    join(dir, service.projects.partial.statePath),
    JSON.stringify({
      version: 1,
      chatId: '',
      entries: [
        {
          slot,
          status: 'sent',
          platform: 'vk',
          postId: 'p1',
          vkPostId: 100,
          vkGroupId: '1',
          createdAt: '2026-10-06T07:05:00.000Z',
          attempts: 1,
          vkText: 'hello',
          sentAt: '2026-10-06T07:06:00.000Z',
        },
      ],
      pauses: {},
      cooldowns: {},
    }),
  );
  const db = openCabinetDb(env);
  refreshServiceSnapshot(db, service);
  materializeScheduleSlots(db, service, env, new Date('2026-10-06T12:00:00Z'));
  await syncProjectState(db, service, 'partial', env, new Date('2026-10-06T12:00:00Z'));
  const planRow = db
    .prepare(
      'SELECT plan_status, edition_id FROM schedule_slots WHERE project_id = ? AND slot_key = ?',
    )
    .get('partial', slot);
  assert.equal(planRow.plan_status, 'sent');
  assert.ok(planRow.edition_id);
  const overview = await buildOverview(db, { week: '2026-10-06' }, env);
  const card = overview.cards.find(
    (item) =>
      item.projectId === 'partial' &&
      item.slotUtc === localSlotToUtc('2026-10-06', '10:00', 'Europe/Moscow').toISOString(),
  );
  assert.equal(card?.status, 'sent');
  assert.ok(overview.summary.sent >= 1);
  db.close();
});

test('three projects materialize distinct weekly patterns', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cabinet-three-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, BOT_CABINET_DB_PATH: join(dir, 'cabinet.sqlite') };
  const db = openCabinetDb(env);
  refreshServiceSnapshot(db, service);
  materializeScheduleSlots(db, service, env, new Date('2026-10-06T08:00:00Z'));
  const codeTuesday = db
    .prepare(
      `SELECT COUNT(*) AS count FROM schedule_slots WHERE project_id = 'code-to-think' AND slot_key LIKE '2026-10-06@%'`,
    )
    .get().count;
  const thingsTuesday = db
    .prepare(
      `SELECT COUNT(*) AS count FROM schedule_slots WHERE project_id = 'things' AND slot_key LIKE '2026-10-06@%'`,
    )
    .get().count;
  assert.equal(codeTuesday, 1);
  assert.equal(thingsTuesday, 2);
  db.close();
});

test('sync keeps distinct edition ids for same slot key across projects', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cabinet-edition-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = {
    ...process.env,
    BOT_CABINET_DB_PATH: join(dir, 'cabinet.sqlite'),
    BOT_CONFIG_PATH: join(dir, 'service.json'),
  };
  await writeFile(env.BOT_CONFIG_PATH, JSON.stringify(service));
  const slot = '2026-10-06@10:00[Europe/Moscow]';
  const writeState = async (projectId, statePath) => {
    const stateDir = join(dir, 'data/projects', projectId);
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(dir, statePath),
      JSON.stringify({
        version: 1,
        chatId: '',
        entries: [
          {
            slot,
            status: 'sent',
            platform: 'vk',
            postId: `${projectId}-post`,
            vkPostId: 1,
            vkGroupId: '1',
            createdAt: '2026-10-06T07:05:00.000Z',
            sentAt: '2026-10-06T07:06:00.000Z',
            attempts: 1,
            vkText: projectId,
          },
        ],
        pauses: {},
        cooldowns: {},
      }),
    );
  };
  await writeState('things', service.projects.things.statePath);
  await writeState('dark-academia', service.projects['dark-academia'].statePath);
  const db = openCabinetDb(env);
  refreshServiceSnapshot(db, service);
  materializeScheduleSlots(db, service, env, new Date('2026-10-06T08:00:00Z'));
  await syncProjectState(db, service, 'things', env, new Date('2026-10-06T12:00:00Z'));
  await syncProjectState(db, service, 'dark-academia', env, new Date('2026-10-06T12:00:00Z'));
  const rows = db
    .prepare('SELECT edition_id, project_id FROM editions WHERE slot_key = ? ORDER BY project_id')
    .all(slot);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].edition_id, rows[1].edition_id);
  db.close();
});

test('patch plan rejects stale version', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cabinet-patch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, BOT_CABINET_DB_PATH: join(dir, 'cabinet.sqlite') };
  const db = openCabinetDb(env);
  refreshServiceSnapshot(db, service);
  materializeScheduleSlots(db, service, env, new Date('2026-10-06T08:00:00Z'));
  const plan = db.prepare('SELECT plan_id, version FROM schedule_slots LIMIT 1').get();
  const ok = await patchPlan(db, plan.plan_id, { topic: 't1', expectedVersion: plan.version });
  assert.ok(ok.plan);
  const conflict = await patchPlan(db, plan.plan_id, {
    topic: 't2',
    expectedVersion: plan.version,
  });
  assert.equal(conflict.error, 'version_conflict');
  db.close();
});

test('retry is offered only for an unpublished failure from today', () => {
  const now = new Date('2026-10-07T12:00:00Z');
  const edition = { slotKey: '2026-10-07@18:00[Europe/Moscow]', status: 'exhausted' };
  const failed = { edition, deliveries: [{ status: 'exhausted' }] };
  assert.equal(canRetryPublication(failed, now), true);
  assert.equal(canRetryPublication({ edition, deliveries: [{ status: 'sent' }] }, now), false);
  assert.equal(canRetryPublication({ edition, deliveries: [{ status: 'uncertain' }] }, now), false);
  assert.equal(
    canRetryPublication(
      {
        edition: { ...edition, slotKey: '2026-10-06@18:00[Europe/Moscow]' },
        deliveries: [{ status: 'exhausted' }],
      },
      now,
    ),
    false,
  );
  assert.equal(canRetryPublication(failed, new Date('2026-10-07T21:00:00Z')), false);
});

test('projectTitle uses editorial brand names', () => {
  assert.equal(projectTitle('dark-academia', null), 'Конэсанс');
  assert.equal(projectTitle('code-to-think', null), 'Код на подумать');
  assert.equal(projectTitle('things', null), 'Вещи — кстати');
});

test('classifyReleaseSource distinguishes manual and test posts', () => {
  assert.equal(classifyReleaseSource('manual:abc', 'llm-1').source, 'manual');
  assert.equal(classifyReleaseSource('manual:abc', 'test-post-1').source, 'test');
  assert.equal(classifyReleaseSource('2026-10-06@10:00[Europe/Moscow]', null).source, 'unplanned');
});

test('overview includes ad-hoc manual delivery without schedule slot', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cabinet-adhoc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = {
    ...process.env,
    BOT_CABINET_DB_PATH: join(dir, 'cabinet.sqlite'),
    BOT_CONFIG_PATH: join(dir, 'service.json'),
  };
  await writeFile(env.BOT_CONFIG_PATH, JSON.stringify(service));
  const stateDir = join(dir, 'data/projects/adhoc');
  await mkdir(stateDir, { recursive: true });
  service.projects.adhoc = {
    enabled: true,
    format: 'programming',
    schedule: service.projects['code-to-think'].schedule,
    delivery: { destinations: ['code-to-think-vk'] },
    statePath: 'data/projects/adhoc/state.json',
  };
  await writeFile(env.BOT_CONFIG_PATH, JSON.stringify(service));
  const manualSlot = 'manual:11111111-2222-4333-8444-555555555555';
  await writeFile(
    join(dir, service.projects.adhoc.statePath),
    JSON.stringify({
      version: 1,
      chatId: '',
      entries: [
        {
          slot: manualSlot,
          status: 'sent',
          platform: 'vk',
          postId: 'test-manual-send',
          vkPostId: 42,
          vkGroupId: '242034586',
          createdAt: '2026-10-06T14:20:00.000Z',
          sentAt: '2026-10-06T14:21:00.000Z',
          attempts: 1,
          vkText: 'adhoc body',
          generation: { title: 'Sudden post' },
        },
      ],
      pauses: {},
      cooldowns: {},
    }),
  );
  const db = openCabinetDb(env);
  refreshServiceSnapshot(db, service);
  await syncProjectState(db, service, 'adhoc', env, new Date('2026-10-06T15:00:00Z'));
  const linked = db
    .prepare('SELECT COUNT(*) AS count FROM schedule_slots WHERE edition_id IS NOT NULL')
    .get().count;
  assert.equal(linked, 0);
  const overview = await buildOverview(db, { week: '2026-10-06', projectFilter: 'adhoc' }, env);
  const card = overview.cards.find((item) => item.adHoc);
  assert.ok(card);
  assert.equal(card.releaseSource, 'test');
  assert.equal(card.status, 'sent');
  assert.equal(card.time, '17:21');
  assert.equal(card.topic, 'Sudden post');
  const filtered = await buildOverview(
    db,
    { week: '2026-10-06', projectFilter: 'adhoc', statusFilter: 'sent' },
    env,
  );
  assert.ok(filtered.cards.some((item) => item.adHoc));
  const empty = await buildOverview(
    db,
    { week: '2026-10-06', projectFilter: 'adhoc', statusFilter: 'planned' },
    env,
  );
  assert.equal(empty.cards.length, 0);
  db.close();
});

test('restart materialize does not duplicate slots', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cabinet-dup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, BOT_CABINET_DB_PATH: join(dir, 'cabinet.sqlite') };
  const db = openCabinetDb(env);
  refreshServiceSnapshot(db, service);
  materializeScheduleSlots(db, service, env, new Date('2026-10-06T08:00:00Z'));
  const before = db.prepare('SELECT COUNT(*) AS count FROM schedule_slots').get().count;
  materializeScheduleSlots(db, service, env, new Date('2026-10-06T08:10:00Z'));
  const after = db.prepare('SELECT COUNT(*) AS count FROM schedule_slots').get().count;
  assert.equal(before, after);
  db.close();
});
