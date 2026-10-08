import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCabinetServer } from '../../bot/cabinet/server.mjs';
import { upsertMemoryFromEdition } from '../../bot/cabinet/editorial/memory.mjs';
import assert from 'node:assert/strict';
import { openCabinetDb, setMeta } from '../../bot/cabinet/db.mjs';
import { syncProjects } from '../../bot/cabinet/projects.mjs';
import { materializeScheduleSlots } from '../../bot/cabinet/sync.mjs';
import { createRubric, listRubrics, changeRubric } from '../../bot/cabinet/rubrics.mjs';
import { buildEditorialSnapshot } from '../../bot/cabinet/editorial/snapshot.mjs';
import { createWeeklyEditorialJob } from '../../bot/cabinet/editorial/job.mjs';
import { decidePlanRevision } from '../../bot/cabinet/editorial/apply.mjs';
import { buildDeterministicProposal } from '../../bot/cabinet/editorial/proposal.mjs';
import {
  rubricSuggestions,
  proposeRubricTest,
  decideRubricTest,
  getRubricTest,
} from '../../bot/cabinet/editorial/rubric-tests.mjs';
const now = new Date('2099-10-07T09:00:00Z');
function fixture(t, dbPath = ':memory:') {
  const db = openCabinetDb({ BOT_CABINET_DB_PATH: dbPath });
  t.after(() => db.close());
  const service = {
    projects: {
      things: {
        enabled: true,
        format: 'lifestyle',
        schedule: { timezone: 'Europe/Moscow', times: ['18:00'] },
        delivery: { destinations: ['things-vk'] },
      },
    },
    destinations: { 'things-vk': { platform: 'vk', media: { enabled: false } } },
  };
  setMeta(db, 'service_config_version', 'test');
  syncProjects(db, service, 'test');
  setMeta(db, 'rubrics_managed:things', '1');
  const rubric = createRubric(
    db,
    service,
    'things',
    {
      name: 'Сценарии',
      days: [1, 2, 3, 4, 5, 6, 7],
      times: ['18:00'],
      media: 'text',
      textPrompt: 'Базовая подача',
    },
    now,
  );
  materializeScheduleSlots(db, service, {}, now);
  const suggestions = rubricSuggestions(db, 'things').suggestions;
  return { db, service, rubric, suggestions };
}
function proposal(f, kind = 'change') {
  return proposeRubricTest(
    f.db,
    f.service,
    { ...f.suggestions.find((s) => s.kind === kind), projectId: 'things' },
    now,
  );
}

test('snapshot and calendar use real rubric ids; rubric changes invalidate the snapshot hash', async (t) => {
  const f = fixture(t);
  const before = buildEditorialSnapshot(f.db, {
    projectId: 'things',
    weekStart: '2099-10-12',
    now,
  });
  const built = buildDeterministicProposal(before.snapshot);
  assert.equal(before.snapshot.rubrics[0].id, f.rubric.id);
  assert.ok(built.proposal.calendar.length);
  assert.ok(built.proposal.calendar.every((c) => c.rubricId === f.rubric.id));
  assert.equal(built.proposal.continue[0].rubricId, f.rubric.id);
  await changeRubric(f.db, f.rubric.id, { ...f.rubric, textPrompt: 'Новая подача' }, { now });
  const after = buildEditorialSnapshot(f.db, { projectId: 'things', weekStart: '2099-10-12', now });
  assert.notEqual(before.inputSnapshotHash, after.inputSnapshotHash);
});

test('new proposal does not alter schedule until applied; applies once and rollback pauses new rubric', async (t) => {
  const f = fixture(t),
    p = proposal(f, 'new');
  assert.equal(listRubrics(f.db).length, 1);
  const started = await decideRubricTest(f.db, f.service, p.id, { decision: 'apply', now });
  assert.equal(started.status, 'testing');
  assert.equal(listRubrics(f.db).length, 2);
  await assert.rejects(
    decideRubricTest(f.db, f.service, p.id, { decision: 'apply', now }),
    (e) => e.code === 'not_decidable',
  );
  materializeScheduleSlots(f.db, f.service, {}, now);
  assert.ok(f.db.prepare('SELECT 1 FROM rubric_slots WHERE rubric_id=?').get(started.rubricId));
  const stopped = await decideRubricTest(f.db, f.service, p.id, {
    decision: 'rollback',
    note: 'Не подходит',
    now,
  });
  assert.equal(stopped.status, 'rolled_back');
  assert.equal(stopped.current.enabled, false);
  assert.equal(stopped.note, 'Не подходит');
});

test('change applies actual prompt, preserves published posts, and rollback restores original config', async (t) => {
  const f = fixture(t),
    p = proposal(f);
  const slot = f.db.prepare('SELECT * FROM schedule_slots ORDER BY slot_utc LIMIT 1').get();
  f.db.prepare("UPDATE schedule_slots SET plan_status='sent' WHERE plan_id=?").run(slot.plan_id);
  const started = await decideRubricTest(f.db, f.service, p.id, { decision: 'apply', now });
  assert.equal(started.current.textPrompt, p.proposal.config.textPrompt);
  assert.equal(
    f.db.prepare('SELECT plan_status FROM schedule_slots WHERE plan_id=?').get(slot.plan_id)
      .plan_status,
    'sent',
  );
  const stopped = await decideRubricTest(f.db, f.service, p.id, { decision: 'rollback', now });
  assert.equal(stopped.current.textPrompt, f.rubric.textPrompt);
  assert.equal(stopped.current.revision, f.rubric.revision + 2);
});

test('stale proposal and stale rollback cannot overwrite manual edits; result can still be recorded', async (t) => {
  const f = fixture(t),
    p = proposal(f);
  await changeRubric(f.db, f.rubric.id, { ...f.rubric, textPrompt: 'Ручное изменение' }, { now });
  await assert.rejects(
    decideRubricTest(f.db, f.service, p.id, { decision: 'apply', now }),
    (e) => e.code === 'rubric_version_conflict',
  );
  assert.equal(getRubricTest(f.db, p.id).status, 'proposed');
  const fresh = proposeRubricTest(
    f.db,
    f.service,
    { ...f.suggestions[0], projectId: 'things', expectedRevision: 2 },
    now,
  );
  const started = await decideRubricTest(f.db, f.service, fresh.id, { decision: 'apply', now });
  await changeRubric(
    f.db,
    started.rubricId,
    { ...started.current, textPrompt: 'Ещё одна правка' },
    { now },
  );
  await assert.rejects(
    decideRubricTest(f.db, f.service, fresh.id, { decision: 'rollback', now }),
    (e) => e.code === 'rubric_version_conflict',
  );
  const kept = await decideRubricTest(f.db, f.service, fresh.id, {
    decision: 'keep',
    note: 'Сохранена ручная версия',
    now,
  });
  assert.equal(kept.current.textPrompt, 'Ещё одна правка');
  assert.equal(kept.note, 'Сохранена ручная версия');
});

test('one active test per group, schedule conflict and project isolation are enforced', async (t) => {
  const f = fixture(t),
    p = proposal(f),
    next = proposal(f, 'new');
  await decideRubricTest(f.db, f.service, p.id, { decision: 'apply', now });
  await assert.rejects(
    decideRubricTest(f.db, f.service, next.id, { decision: 'apply', now }),
    (e) => e.code === 'test_already_active',
  );
  await decideRubricTest(f.db, f.service, p.id, { decision: 'keep', now });
  const conflicting = proposeRubricTest(
    f.db,
    f.service,
    {
      ...f.suggestions.find((s) => s.kind === 'new'),
      projectId: 'things',
      config: { ...f.rubric, name: 'Конфликт' },
    },
    now,
  );
  await assert.rejects(
    decideRubricTest(f.db, f.service, conflicting.id, { decision: 'apply', now }),
    /schedule_conflict/,
  );
  assert.equal(getRubricTest(f.db, conflicting.id).status, 'proposed');
  assert.throws(
    () => proposeRubricTest(f.db, f.service, { ...f.suggestions[0], projectId: 'missing' }, now),
    (e) => e.code === 'rubric_project_invalid',
  );
});

test('reports count only published test revision and latest cumulative metrics, not duplicate observations', async (t) => {
  const f = fixture(t),
    p = proposal(f);
  const started = await decideRubricTest(f.db, f.service, p.id, { decision: 'apply', now });
  materializeScheduleSlots(f.db, f.service, {}, now);
  const slot = f.db
    .prepare(
      'SELECT s.* FROM schedule_slots s JOIN rubric_slots r USING(plan_id) WHERE r.rubric_id=? AND r.revision=? AND r.hidden=0 AND s.slot_utc>=? ORDER BY s.slot_utc LIMIT 1',
    )
    .get(started.rubricId, started.appliedRevision, now.toISOString());
  f.db
    .prepare(
      `INSERT INTO editions(edition_id,project_id,slot_key,format,aggregate_status,created_at,updated_at) VALUES ('e','things',?,'lifestyle','sent',?,?)`,
    )
    .run(slot.slot_key, now.toISOString(), now.toISOString());
  f.db
    .prepare("UPDATE schedule_slots SET edition_id='e',plan_status='sent' WHERE plan_id=?")
    .run(slot.plan_id);
  for (const [id, at, value, mode] of [
    ['a', '2099-10-08', 50, 'cumulative'],
    ['b', '2099-10-09', 100, 'cumulative'],
    ['c', '2099-10-10', 3, 'period'],
  ]) {
    f.db
      .prepare(
        `INSERT INTO metric_observations(observation_id,project_id,edition_id,vk_group_id,vk_post_id,source,observed_at,metric_mode,views,schema_version,created_at,updated_at) VALUES (?,'things','e','1','1','test',?,?,?,'1',?,?)`,
      )
      .run(id, at, mode, value, at, at);
  }
  const report = getRubricTest(f.db, p.id, new Date('2099-11-01')).report;
  assert.equal(report.test.posts, 1);
  assert.equal(report.test.measured, 1);
  assert.equal(report.test.median, 100);
  assert.equal(report.reviewDue, true);
});

test('interrupted mutation is retryable without replacing already committed rubric twice', async (t) => {
  const f = fixture(t),
    p = proposal(f);
  f.db.prepare("UPDATE editorial_rubric_tests SET status='applying' WHERE id=?").run(p.id);
  await changeRubric(
    f.db,
    f.rubric.id,
    { ...p.proposal.config, revision: f.rubric.revision },
    { now },
  );
  const result = await decideRubricTest(f.db, f.service, p.id, { decision: 'apply', now });
  assert.equal(result.status, 'testing');
  assert.equal(result.current.revision, 2);
});

test('memory uses actual binding and upgrades an existing synthetic rubric id', (t) => {
  const f = fixture(t);
  const slot = f.db.prepare('SELECT * FROM schedule_slots ORDER BY slot_utc LIMIT 1').get();
  f.db
    .prepare(
      `INSERT INTO editions(edition_id,project_id,slot_key,format,body_text,aggregate_status,created_at,updated_at) VALUES ('memory-ed','things',?,'lifestyle','Текст','sent',?,?)`,
    )
    .run(slot.slot_key, now.toISOString(), now.toISOString());
  const row = {
    ...f.db.prepare("SELECT * FROM editions WHERE edition_id='memory-ed'").get(),
    sent_at: now.toISOString(),
    vk_post_id: '1',
    delivery_id: null,
  };
  upsertMemoryFromEdition(f.db, row, now);
  assert.equal(
    f.db.prepare("SELECT rubric_id FROM editorial_memory WHERE edition_id='memory-ed'").get()
      .rubric_id,
    'things:scenario',
  );
  f.db
    .prepare("UPDATE schedule_slots SET edition_id='memory-ed',plan_status='sent' WHERE plan_id=?")
    .run(slot.plan_id);
  upsertMemoryFromEdition(f.db, row, now);
  assert.equal(
    f.db.prepare("SELECT rubric_id FROM editorial_memory WHERE edition_id='memory-ed'").get()
      .rubric_id,
    f.rubric.id,
  );
});

test('HTTP proposals, apply and rollback synchronize actual rubrics and calendar, with auth and Origin guards', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'editorial-http-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = join(root, 'db.sqlite'),
    f = fixture(t, dbPath),
    configPath = join(root, 'service.json');
  writeFileSync(configPath, JSON.stringify(f.service));
  const server = startCabinetServer({
    BOT_CABINET_DB_PATH: dbPath,
    BOT_CONFIG_PATH: configPath,
    BOT_CABINET_PASSWORD: 'test-password',
    BOT_CABINET_HOST: '127.0.0.1',
    BOT_CABINET_PORT: '0',
    BOT_CABINET_ALLOWED_ORIGINS: 'https://cabinet.test',
  });
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/bot/api/v1`;
  assert.equal((await fetch(base + '/editorial/rubric-tests?project=things')).status, 401);
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
  const bundle = await (
    await fetch(base + '/editorial/rubric-tests?project=things', { headers })
  ).json();
  assert.equal(bundle.rubrics[0].id, f.rubric.id);
  const input = { ...bundle.suggestions.find((s) => s.kind === 'new'), projectId: 'things' };
  assert.equal(
    (
      await fetch(base + '/editorial/rubric-tests', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
    ).status,
    403,
  );
  const created = await fetch(base + '/editorial/rubric-tests', {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  });
  assert.equal(created.status, 200);
  const p = await created.json();
  const apply = await fetch(base + `/editorial/rubric-tests/${p.id}/decide`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ decision: 'apply' }),
  });
  assert.equal(apply.status, 200);
  const started = await apply.json();
  assert.equal(started.status, 'testing');
  const rubrics = await (await fetch(base + '/rubrics', { headers })).json();
  assert.ok(rubrics.rubrics.some((r) => r.id === started.rubricId && r.enabled));
  assert.ok(
    f.db.prepare('SELECT 1 FROM rubric_slots WHERE rubric_id=? AND hidden=0').get(started.rubricId),
  );
  const stop = await fetch(base + `/editorial/rubric-tests/${p.id}/decide`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ decision: 'rollback', note: 'Проверка завершена' }),
  });
  assert.equal(stop.status, 200);
  assert.equal((await stop.json()).current.enabled, false);
});

test('weekly themes become stale when actual rubric revision changes', async (t) => {
  const f = fixture(t);
  const job = createWeeklyEditorialJob(f.db, { projectId: 'things', weekStart: '2099-10-12', now });
  await changeRubric(
    f.db,
    f.rubric.id,
    { ...f.rubric, textPrompt: 'Ручная новая подача' },
    { now },
  );
  const decision = await decidePlanRevision(f.db, job.revisionId, {
    decision: 'approve',
    syncRedisFn: null,
    now,
  });
  assert.equal(decision.error, 'rubric_version_conflict');
  const next = createWeeklyEditorialJob(f.db, {
    projectId: 'things',
    weekStart: '2099-10-12',
    now,
  });
  assert.notEqual(next.revisionId, job.revisionId);
});

test('test retains cancellation intent after network error and safely resumes', async (t) => {
  const f = fixture(t),
    p = proposal(f);
  const slot = f.db
    .prepare('SELECT * FROM schedule_slots WHERE slot_utc>? ORDER BY slot_utc LIMIT 1')
    .get(now.toISOString());
  f.db
    .prepare(
      "INSERT INTO vk_weekly_posts(plan_id,week_start,status,post_id,group_id,updated_at) VALUES (?,?,'scheduled',42,'123',?)",
    )
    .run(slot.plan_id, '2099-10-05', now.toISOString());
  let fail = true,
    removed = 0;
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
    decideRubricTest(f.db, f.service, p.id, { decision: 'apply', client, now }),
    /network/,
  );
  assert.equal(getRubricTest(f.db, p.id).status, 'applying');
  assert.equal(getRubricTest(f.db, p.id).current.pending, true);
  fail = false;
  const result = await decideRubricTest(f.db, f.service, p.id, { decision: 'apply', client, now });
  assert.equal(result.status, 'testing');
  assert.equal(removed, 1);
  assert.equal(result.current.revision, 2);
});
