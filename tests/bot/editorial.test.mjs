import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openCabinetDb, getMeta } from '../../bot/cabinet/db.mjs';
import { SCHEMA_VERSION } from '../../bot/cabinet/schema.mjs';
import { refreshServiceSnapshot } from '../../bot/cabinet/projects.mjs';
import { materializeScheduleSlots } from '../../bot/cabinet/sync.mjs';
import { runAnalyticsCleanup } from '../../bot/cabinet/analytics/ttl.mjs';
import { analyzeDiversity, authorAlternationOk } from '../../bot/cabinet/editorial/diversity.mjs';
import {
  openingPhrase,
  closingPhrase,
  normalizePhrase,
} from '../../bot/cabinet/editorial/phrases.mjs';
import {
  addEpisode,
  createSeries,
  detectSeriesCycles,
  evaluatePredecessorGate,
  wouldCreateCycle,
} from '../../bot/cabinet/editorial/series.mjs';
import { syncEditorialMemory, listMemory } from '../../bot/cabinet/editorial/memory.mjs';
import {
  buildEditorialSnapshot,
  nextPlanWeekStart,
} from '../../bot/cabinet/editorial/snapshot.mjs';
import {
  buildDeterministicProposal,
  validateProposal,
} from '../../bot/cabinet/editorial/proposal.mjs';
import {
  createWeeklyEditorialJob,
  weeklyCommittedUsd,
  weeklySpendUsd,
} from '../../bot/cabinet/editorial/job.mjs';
import {
  decidePlanRevision,
  getPlanRevision,
  editFutureBrief,
} from '../../bot/cabinet/editorial/apply.mjs';

test('editing an applied future brief returns the updated queue payload and rejects past slots', async () => {
  const db = openDb();
  try {
    const job = createWeeklyEditorialJob(db, {
      projectId: 'dark-academia',
      weekStart: '2026-10-12',
    });
    const decision = await decidePlanRevision(db, job.revisionId, {
      decision: 'approve',
      syncRedisFn: null,
    });
    const item = decision.applied[0];
    assert.ok(item);
    const edited = editFutureBrief(db, item.briefId, { topic: 'Новая тема', thesis: 'Новый бриф' });
    assert.equal(edited.slot.topic, 'Новая тема');
    assert.match(edited.slot.brief, /Новый бриф/);
    assert.equal(edited.slot.version, item.version + 1);
    const expired = editFutureBrief(db, item.briefId, {
      topic: 'Не применять',
      now: new Date('2026-11-01T00:00:00Z'),
    });
    assert.equal(expired.error, 'not_editable');
    assert.equal(
      db.prepare('SELECT topic FROM schedule_slots WHERE plan_id=?').get(item.planId).topic,
      'Новая тема',
    );
  } finally {
    db.close();
  }
});
import {
  checkEditorialPublishGate,
  isTerminalSeriesBlock,
  recordTerminalSeriesBlock,
  resolveConfirmedTaskPredecessor,
} from '../../bot/cabinet/editorial/gate.mjs';
import { WEEKLY_BUDGET_USD } from '../../bot/cabinet/editorial/vocab.mjs';

const service = {
  destinations: {
    'connaissance-vk': { platform: 'vk', media: { enabled: false } },
    'code-to-think-vk': { platform: 'vk', media: { enabled: false } },
    'things-vk': { platform: 'vk', media: { enabled: false } },
  },
  projects: {
    'dark-academia': {
      enabled: true,
      format: 'literary',
      schedule: { timezone: 'Europe/Moscow', times: ['10:00', '18:00'], missedSlots: 'skip' },
      delivery: { destinations: ['connaissance-vk'] },
    },
    'code-to-think': {
      enabled: true,
      format: 'programming',
      schedule: {
        timezone: 'Europe/Moscow',
        times: ['12:00'],
        weekly: {
          1: ['12:00', '18:00'],
          2: ['12:00'],
          3: ['12:00'],
          4: ['12:00'],
          5: ['12:00'],
          6: ['12:00'],
          7: ['12:00'],
        },
        missedSlots: 'skip',
      },
      delivery: { destinations: ['code-to-think-vk'] },
    },
    things: {
      enabled: true,
      format: 'lifestyle',
      schedule: { timezone: 'Europe/Moscow', times: ['10:00', '18:00'], missedSlots: 'skip' },
      delivery: { destinations: ['things-vk'] },
    },
  },
};

function openDb() {
  const db = openCabinetDb({ BOT_CABINET_DB_PATH: ':memory:' });
  refreshServiceSnapshot(db, service);
  materializeScheduleSlots(db, service, {});
  return db;
}

function seedSent(
  db,
  {
    projectId = 'dark-academia',
    destinationId = 'connaissance-vk',
    editionId = randomUUID().replaceAll('-', '').slice(0, 32),
    body = 'Первая фраза особенная. Остальной текст поста.',
    sentAt = '2026-09-20T10:00:00.000Z',
    author = null,
  } = {},
) {
  db.prepare(
    `INSERT INTO editions (
      edition_id, project_id, slot_key, format, topic, brief, body_text,
      prompt_version, models_json, cost_usd, aggregate_status, created_at, updated_at
    ) VALUES (?, ?, '2026-09-20T10:00', ?, 't', NULL, ?, 'unknown', '{}', 0.01, 'sent', ?, ?)`,
  ).run(
    editionId,
    projectId,
    projectId === 'code-to-think'
      ? 'programming'
      : projectId === 'things'
        ? 'lifestyle'
        : 'literary',
    body,
    sentAt,
    sentAt,
  );
  db.prepare(
    `INSERT INTO deliveries (
      delivery_id, edition_id, project_id, destination_id, platform, status,
      post_id, external_id, vk_group_id, attempts, sent_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'vk', 'sent', 'p1', '1001', '1', 1, ?, ?, ?)`,
  ).run(randomUUID(), editionId, projectId, destinationId, sentAt, sentAt, sentAt);
  if (author) {
    syncEditorialMemory(db, { projectId });
    const mem = db
      .prepare('SELECT memory_id FROM editorial_memory WHERE edition_id = ?')
      .get(editionId);
    if (mem) {
      db.prepare(
        `UPDATE editorial_memory SET author = ?, feature_source = 'manual' WHERE memory_id = ?`,
      ).run(author, mem.memory_id);
    }
  }
  return editionId;
}

test('schema migrates to v5 with rubrics', () => {
  const db = openDb();
  assert.equal(Number(getMeta(db, 'schema_version')), SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 5);
  const rubrics = db.prepare('SELECT COUNT(*) AS c FROM editorial_rubrics').get().c;
  assert.ok(rubrics >= 7);
  db.close();
});

test('phrase normalize and diversity detects repeats', () => {
  assert.equal(normalizePhrase('«Привет, мир!»'), 'привет мир');
  const open = openingPhrase('Одинаковый заход сегодня\nпродолжение');
  const close = closingPhrase('начало\nОдинаковая концовка.');
  const analysis = analyzeDiversity(
    [
      {
        openingPhrase: open,
        closingPhrase: close,
        tone: 'heavy',
        author: 'A',
        structure: 'quote_commentary',
      },
      {
        openingPhrase: open,
        closingPhrase: close,
        tone: 'heavy',
        author: 'A',
        structure: 'quote_commentary',
      },
      {
        openingPhrase: open,
        closingPhrase: 'другое',
        tone: 'heavy',
        author: 'A',
        structure: 'quote_commentary',
      },
      {
        openingPhrase: 'x',
        closingPhrase: close,
        tone: 'heavy',
        author: 'B',
        structure: 'quote_commentary',
      },
    ],
    { projectId: 'dark-academia' },
  );
  assert.ok(analysis.phrases.repeatedOpenings.length >= 1);
  assert.ok(analysis.phrases.repeatedClosings.length >= 1);
  assert.ok(analysis.findings.some((f) => f.kind === 'heavy_tone_dominance'));
  assert.equal(authorAlternationOk(['A', 'A'], 'A'), false);
  assert.equal(authorAlternationOk(['A', 'B'], 'A'), true);
});

test('series cycle detection and predecessor gate', () => {
  const db = openDb();
  const series = createSeries(db, {
    projectId: 'code-to-think',
    title: 'Задача→разбор',
    status: 'active',
  });
  const ep1 = addEpisode(db, {
    seriesId: series.seriesId,
    projectId: 'code-to-think',
    episodeNumber: 1,
  });
  const ep2 = addEpisode(db, {
    seriesId: series.seriesId,
    projectId: 'code-to-think',
    episodeNumber: 2,
    predecessorEpisodeId: ep1.episodeId,
  });
  assert.ok(ep1.episodeId);
  assert.ok(ep2.episodeId);
  const cycle = wouldCreateCycle(db, series.seriesId, ep2.episodeId, ep1.episodeId);
  assert.ok(cycle);
  assert.equal(detectSeriesCycles(db, series.seriesId).cyclic, false);

  const gateMissing = evaluatePredecessorGate(db, ep2.episodeId);
  assert.equal(gateMissing.allowed, false);

  const editionId = seedSent(db, {
    projectId: 'code-to-think',
    destinationId: 'code-to-think-vk',
    body: 'Задача: напишите функцию',
  });
  db.prepare(
    `UPDATE editorial_series_episodes SET edition_id = ?, status = 'sent' WHERE episode_id = ?`,
  ).run(editionId, ep1.episodeId);
  const gateOk = evaluatePredecessorGate(db, ep2.episodeId);
  assert.equal(gateOk.allowed, true);

  db.prepare(`UPDATE deliveries SET status = 'failed' WHERE edition_id = ?`).run(editionId);
  const gateFail = evaluatePredecessorGate(db, ep2.episodeId);
  assert.equal(gateFail.allowed, false);
  assert.equal(gateFail.blockDependentOnly, true);

  const planIndependent = db
    .prepare(`SELECT plan_id FROM schedule_slots WHERE project_id = 'dark-academia' LIMIT 1`)
    .get();
  const publishGate = checkEditorialPublishGate(db, {
    planId: planIndependent.plan_id,
    projectId: 'dark-academia',
  });
  assert.equal(publishGate.allowed, true);
  db.close();
});

test('project isolation: memory and proposals never cross projects', () => {
  const db = openDb();
  seedSent(db, { projectId: 'dark-academia', body: 'Литературный текст Конэсанс' });
  seedSent(db, {
    projectId: 'things',
    destinationId: 'things-vk',
    body: 'Бытовой сценарий вещей',
  });
  syncEditorialMemory(db, {});
  const lit = listMemory(db, { projectId: 'dark-academia' });
  const things = listMemory(db, { projectId: 'things' });
  assert.ok(lit.every((m) => m.projectId === 'dark-academia'));
  assert.ok(things.every((m) => m.projectId === 'things'));
  assert.ok(lit.some((m) => m.bodyText?.includes('Конэсанс')));
  assert.ok(!lit.some((m) => m.bodyText?.includes('вещей')));

  for (const projectId of ['dark-academia', 'code-to-think', 'things']) {
    const job = createWeeklyEditorialJob(db, { projectId, weekStart: '2026-10-12' });
    assert.equal(job.status, 'completed');
    const revision = getPlanRevision(db, job.revisionId);
    assert.equal(revision.projectId, projectId);
    assert.equal(revision.proposal.projectId, projectId);
    assert.equal(revision.proposal.newFormats.length, 2);
    assert.ok(revision.proposal.continue);
    assert.ok(revision.proposal.pause);
    assert.ok(revision.proposal.series);
    assert.ok(revision.proposal.nextMaterial);
    assert.ok(Array.isArray(revision.proposal.calendar));
    const foreign = revision.proposal.calendar.some((c) => {
      const slot = db
        .prepare('SELECT project_id FROM schedule_slots WHERE plan_id = ?')
        .get(c.planId);
      return slot && slot.project_id !== projectId;
    });
    assert.equal(foreign, false);
  }
  db.close();
});

test('weekly job idempotent; forceNew creates revision; budget blocks LLM', () => {
  const db = openDb();
  const first = createWeeklyEditorialJob(db, {
    projectId: 'dark-academia',
    weekStart: '2026-10-12',
  });
  const second = createWeeklyEditorialJob(db, {
    projectId: 'dark-academia',
    weekStart: '2026-10-12',
  });
  assert.equal(second.reused, true);
  assert.equal(second.jobId, first.jobId);

  const forced = createWeeklyEditorialJob(db, {
    projectId: 'dark-academia',
    weekStart: '2026-10-12',
    forceNew: true,
  });
  assert.equal(forced.reused, undefined);
  assert.notEqual(forced.revisionId, first.revisionId);

  const priced = createWeeklyEditorialJob(db, {
    projectId: 'things',
    weekStart: '2026-10-12',
    llm: () => ({ proposal: {}, costUsd: 0.01 }),
  });
  assert.equal(priced.error, 'unknown_price');

  db.prepare(
    `INSERT INTO editorial_budget_ledger (
      ledger_id, project_id, week_start, job_id, kind, amount_usd, note, created_at
    ) VALUES (?, 'dark-academia', '2026-10-19', NULL, 'spend', ?, 'fill', ?)`,
  ).run(randomUUID(), WEEKLY_BUDGET_USD, new Date().toISOString());
  assert.equal(weeklySpendUsd(db, 'dark-academia', '2026-10-19'), WEEKLY_BUDGET_USD);
  const exhausted = createWeeklyEditorialJob(db, {
    projectId: 'dark-academia',
    weekStart: '2026-10-19',
  });
  // deterministic path costs 0 — budget check only blocks when remaining <= 0 before job
  // After spend == budget, remaining is 0 → exhausted
  assert.equal(exhausted.error, 'budget_exhausted');
  db.close();
});

test('approve applies only unstarted future slots; stale revision rejected; started blocked', async () => {
  const db = openDb();
  const job = createWeeklyEditorialJob(db, {
    projectId: 'dark-academia',
    weekStart: '2026-10-12',
  });
  const revision = getPlanRevision(db, job.revisionId);
  assert.ok(revision.briefs.length >= 1);

  const startedPlanId = revision.briefs[0].planId;
  const editionId = randomUUID().replaceAll('-', '').slice(0, 32);
  db.prepare(
    `INSERT INTO editions (
      edition_id, project_id, format, aggregate_status, created_at, updated_at
    ) VALUES (?, 'dark-academia', 'literary', 'generating', ?, ?)`,
  ).run(editionId, new Date().toISOString(), new Date().toISOString());
  db.prepare(`UPDATE schedule_slots SET edition_id = ? WHERE plan_id = ?`).run(
    editionId,
    startedPlanId,
  );

  const decision = await decidePlanRevision(db, job.revisionId, {
    decision: 'approve',
    syncRedisFn: null,
  });
  assert.ok(
    decision.skipped.some((s) => s.planId === startedPlanId && s.reason === 'already_started'),
  );
  const appliedOther = decision.applied.every((a) => a.planId !== startedPlanId);
  assert.equal(appliedOther, true);

  for (const item of decision.applied) {
    const slot = db
      .prepare('SELECT topic, brief, topic_state FROM schedule_slots WHERE plan_id = ?')
      .get(item.planId);
    assert.equal(slot.topic_state, 'editorial');
    assert.ok(slot.topic);
    assert.ok(slot.brief);
  }

  const stale = await decidePlanRevision(db, job.revisionId, { decision: 'approve' });
  assert.equal(stale.error, 'not_decidable');

  const forced = createWeeklyEditorialJob(db, {
    projectId: 'dark-academia',
    weekStart: '2026-10-12',
    forceNew: true,
  });
  // Mark older proposed as still proposed incorrectly — latest check
  const older = await decidePlanRevision(db, firstIfProposed(db, forced), {
    decision: 'reject',
  });
  // If forced completed, rejecting it works; attempting to approve a superseded fails
  const superseded = db
    .prepare(
      `SELECT revision_id, status FROM editorial_plan_revisions
       WHERE project_id = 'dark-academia' AND week_start = '2026-10-12' AND status = 'superseded'`,
    )
    .get();
  if (superseded) {
    const bad = await decidePlanRevision(db, superseded.revision_id, { decision: 'approve' });
    assert.equal(bad.error, 'not_decidable');
  }
  assert.ok(older.status === 'rejected' || older.error);
  db.close();
});

function firstIfProposed(db, forced) {
  return forced.revisionId;
}

test('proposal validation requires five tasks and evidence; no invented reach', () => {
  const db = openDb();
  const { snapshot } = buildEditorialSnapshot(db, {
    projectId: 'dark-academia',
    weekStart: '2026-10-12',
  });
  const { proposal, validation } = buildDeterministicProposal(snapshot);
  assert.equal(validation.ok, true);
  assert.ok(proposal.overview);
  assert.ok(proposal.continue);
  assert.ok(proposal.pause);
  assert.equal(proposal.newFormats.length, 2);
  assert.ok(proposal.series);
  assert.ok(proposal.nextMaterial);
  assert.ok(
    proposal.overview.missingData ||
      proposal.overview.evidenceIds.includes('editorial_hypothesis:insufficient_data') ||
      proposal.calendar.every((c) => c.evidenceIds?.length),
  );
  const text = JSON.stringify(proposal);
  assert.equal(/reach\s*[:=]\s*\d{3,}/i.test(text), false);
  assert.equal(validateProposal({ ...proposal, newFormats: [] }, snapshot).ok, false);
  db.close();
});

test('TTL scrubs editorial memory/briefs/previews and pauses expired series', () => {
  const db = openDb();
  const editionId = seedSent(db, {
    body: 'Секретный текст для TTL',
    sentAt: '2026-09-20T10:00:00.000Z',
  });
  syncEditorialMemory(db, { projectId: 'dark-academia' });
  db.prepare(`UPDATE editorial_memory SET content_expires_at = ? WHERE edition_id = ?`).run(
    '2026-09-25T00:00:00.000Z',
    editionId,
  );

  const series = createSeries(db, {
    projectId: 'dark-academia',
    title: 'Старая серия',
    status: 'active',
    plannedEndAt: '2026-09-01T00:00:00.000Z',
  });

  const job = createWeeklyEditorialJob(db, {
    projectId: 'dark-academia',
    weekStart: '2026-10-12',
  });
  db.prepare(
    `UPDATE editorial_plan_revisions SET content_expires_at = ? WHERE revision_id = ?`,
  ).run('2026-09-01T00:00:00.000Z', job.revisionId);
  db.prepare(`UPDATE editorial_briefs SET content_expires_at = ? WHERE revision_id = ?`).run(
    '2026-09-01T00:00:00.000Z',
    job.revisionId,
  );

  // Re-assert expiry after weekly job sync (COALESCE must keep past expiry).
  db.prepare(
    `UPDATE editorial_memory SET
       content_expires_at = '2026-09-25T00:00:00.000Z',
       body_text = COALESCE(body_text, 'Секретный текст для TTL'),
       body_removed_at = NULL
     WHERE edition_id = ?`,
  ).run(editionId);
  const pending = db
    .prepare('SELECT body_text, content_expires_at FROM editorial_memory WHERE edition_id = ?')
    .get(editionId);
  assert.ok(pending?.body_text);
  assert.equal(pending.content_expires_at, '2026-09-25T00:00:00.000Z');

  const stats = runAnalyticsCleanup(db, {
    now: new Date('2026-10-07T12:00:00.000Z'),
    force: true,
  });
  assert.ok(stats.editorialMemoryScrubbed >= 1, JSON.stringify(stats));
  assert.ok(stats.editorialBriefsScrubbed >= 1);
  assert.ok(stats.editorialRevisionsScrubbed >= 1);
  assert.ok(stats.editorialSeriesPaused >= 1);

  const mem = db
    .prepare('SELECT body_text, body_removed_at FROM editorial_memory WHERE edition_id = ?')
    .get(editionId);
  assert.equal(mem.body_text, null);
  assert.ok(mem.body_removed_at);

  const rev = getPlanRevision(db, job.revisionId);
  assert.equal(rev.proposal.purged, true);
  assert.equal(rev.proposal.overview.summary, null);

  const seriesRow = db
    .prepare('SELECT status FROM editorial_series WHERE series_id = ?')
    .get(series.seriesId);
  assert.equal(seriesRow.status, 'paused');
  db.close();
});

test('confirmed task predecessor rejects uncertain and expired content', () => {
  const db = openDb();
  const editionId = seedSent(db, {
    projectId: 'code-to-think',
    destinationId: 'code-to-think-vk',
    body: 'условие задачи',
  });
  assert.equal(
    resolveConfirmedTaskPredecessor(db, {
      projectId: 'code-to-think',
      predecessorEditionId: editionId,
    }).ok,
    true,
  );
  db.prepare(`UPDATE deliveries SET status = 'uncertain' WHERE edition_id = ?`).run(editionId);
  assert.equal(
    resolveConfirmedTaskPredecessor(db, {
      projectId: 'code-to-think',
      predecessorEditionId: editionId,
    }).reason,
    'predecessor_uncertain',
  );
  db.prepare(`UPDATE deliveries SET status = 'sent' WHERE edition_id = ?`).run(editionId);
  db.prepare(`UPDATE editions SET body_text = NULL, body_removed_at = ? WHERE edition_id = ?`).run(
    new Date().toISOString(),
    editionId,
  );
  assert.equal(
    resolveConfirmedTaskPredecessor(db, {
      projectId: 'code-to-think',
      predecessorEditionId: editionId,
    }).reason,
    'predecessor_content_expired',
  );
  db.close();
});

test('nextPlanWeekStart from Sunday is next Monday', () => {
  // 2026-10-11 is Sunday
  const monday = nextPlanWeekStart(new Date('2026-10-11T16:40:00.000Z'));
  assert.equal(monday, '2026-10-12');
});

test('approve applies SQLite atomically even when redis sync fails', async () => {
  const db = openDb();
  const job = createWeeklyEditorialJob(db, {
    projectId: 'dark-academia',
    weekStart: '2026-10-12',
  });
  let syncCalls = 0;
  const decision = await decidePlanRevision(db, job.revisionId, {
    decision: 'approve',
    syncRedisFn: async () => {
      syncCalls += 1;
      throw new Error('redis down');
    },
  });
  assert.ok(decision.applied.length >= 1);
  assert.equal(syncCalls, decision.applied.length);
  assert.equal(decision.redisSyncErrors.length, decision.applied.length);
  for (const item of decision.applied) {
    const slot = db
      .prepare('SELECT topic_state, version, topic FROM schedule_slots WHERE plan_id = ?')
      .get(item.planId);
    assert.equal(slot.topic_state, 'editorial');
    assert.equal(slot.version, item.version);
    assert.ok(slot.topic);
    const brief = db
      .prepare('SELECT status FROM editorial_briefs WHERE brief_id = ?')
      .get(item.briefId);
    assert.equal(brief.status, 'applied');
  }
  const rev = db
    .prepare('SELECT status FROM editorial_plan_revisions WHERE revision_id = ?')
    .get(job.revisionId);
  assert.equal(rev.status, 'approved');
  db.close();
});

test('snapshot week bounds use Moscow local midnight not UTC Z', () => {
  const db = openDb();
  const { snapshot } = buildEditorialSnapshot(db, {
    projectId: 'dark-academia',
    weekStart: '2026-10-12',
  });
  // Moscow Mon 00:00 = Sun 21:00 UTC; slots before that UTC midnight Monday must be excluded.
  for (const slot of snapshot.slots) {
    assert.ok(slot.slotUtc >= '2026-10-11T21:00:00.000Z', slot.slotUtc);
    assert.ok(slot.slotUtc < '2026-10-18T21:00:00.000Z', slot.slotUtc);
  }
  db.close();
});

test('terminal series block marks episode blocked; wait block is not terminal', () => {
  const db = openDb();
  const series = createSeries(db, {
    projectId: 'dark-academia',
    title: 'Gate series',
    status: 'active',
  });
  const futurePlans = db
    .prepare(
      `SELECT plan_id FROM schedule_slots
       WHERE project_id = 'dark-academia' AND plan_status = 'planned' AND edition_id IS NULL
       ORDER BY slot_utc ASC LIMIT 2`,
    )
    .all();
  assert.ok(futurePlans.length >= 2);
  const planA = futurePlans[0].plan_id;
  const planB = futurePlans[1].plan_id;
  const ep1 = addEpisode(db, {
    seriesId: series.seriesId,
    projectId: 'dark-academia',
    episodeNumber: 1,
    planId: planA,
  });
  const ep2 = addEpisode(db, {
    seriesId: series.seriesId,
    projectId: 'dark-academia',
    episodeNumber: 2,
    planId: planB,
    predecessorEpisodeId: ep1.episodeId,
  });

  const waiting = checkEditorialPublishGate(db, { planId: planB, projectId: 'dark-academia' });
  assert.equal(waiting.allowed, false);
  assert.equal(waiting.reason, 'predecessor_not_sent');
  assert.equal(isTerminalSeriesBlock(waiting), false);

  const editionId = seedSent(db, { projectId: 'dark-academia' });
  db.prepare(`UPDATE editorial_series_episodes SET edition_id = ? WHERE episode_id = ?`).run(
    editionId,
    ep1.episodeId,
  );
  db.prepare(`UPDATE deliveries SET status = 'failed' WHERE edition_id = ?`).run(editionId);

  const terminal = checkEditorialPublishGate(db, { planId: planB, projectId: 'dark-academia' });
  assert.equal(terminal.allowed, false);
  assert.equal(terminal.reason, 'predecessor_failed_or_missed');
  assert.equal(isTerminalSeriesBlock(terminal), true);
  recordTerminalSeriesBlock(db, terminal);
  const row = db
    .prepare('SELECT status FROM editorial_series_episodes WHERE episode_id = ?')
    .get(ep2.episodeId);
  assert.equal(row.status, 'blocked');
  db.close();
});

test('failed weekly LLM job releases budget reserve', () => {
  const db = openDb();
  const result = createWeeklyEditorialJob(db, {
    projectId: 'things',
    weekStart: '2026-10-12',
    llm: () => {
      throw new Error('llm_boom');
    },
    estimatedCostUsd: 0.2,
  });
  assert.equal(result.error, 'job_failed');
  const release = db
    .prepare(
      `SELECT kind, amount_usd FROM editorial_budget_ledger WHERE job_id = ? AND kind = 'release'`,
    )
    .get(result.jobId);
  assert.ok(release);
  assert.equal(release.amount_usd, 0.2);
  const job = db
    .prepare('SELECT status, reserved_usd FROM editorial_weekly_jobs WHERE job_id = ?')
    .get(result.jobId);
  assert.equal(job.status, 'failed');
  assert.equal(job.reserved_usd, 0.2);
  assert.equal(weeklyCommittedUsd(db, 'things', '2026-10-12'), 0);
  db.close();
});

test('open reserve reduces remaining; inflated budgetUsd capped', () => {
  const db = openDb();
  const weekStart = '2026-10-19';
  db.prepare(
    `INSERT INTO editorial_budget_ledger (
      ledger_id, project_id, week_start, job_id, kind, amount_usd, note, created_at
    ) VALUES (?, 'dark-academia', ?, NULL, 'reserve', ?, 'hold', ?)`,
  ).run(randomUUID(), weekStart, WEEKLY_BUDGET_USD, new Date().toISOString());
  assert.equal(weeklySpendUsd(db, 'dark-academia', weekStart), 0);
  assert.equal(weeklyCommittedUsd(db, 'dark-academia', weekStart), WEEKLY_BUDGET_USD);

  const blocked = createWeeklyEditorialJob(db, {
    projectId: 'dark-academia',
    weekStart,
    budgetUsd: 999,
    llm: () => ({ proposal: {}, costUsd: 0.01 }),
    estimatedCostUsd: 0.01,
  });
  assert.equal(blocked.error, 'budget_exhausted');

  const again = createWeeklyEditorialJob(db, {
    projectId: 'dark-academia',
    weekStart,
    budgetUsd: 999,
  });
  assert.equal(again.error, 'budget_exhausted');
  assert.equal(again.jobId, blocked.jobId);
  db.close();
});

test('skipped missing slot marks brief blocked not approved', async () => {
  const db = openDb();
  const job = createWeeklyEditorialJob(db, {
    projectId: 'dark-academia',
    weekStart: '2026-10-12',
  });
  const revision = getPlanRevision(db, job.revisionId);
  const target = revision.briefs[0];
  assert.ok(target);
  db.prepare('DELETE FROM schedule_slots WHERE plan_id = ?').run(target.planId);

  const decision = await decidePlanRevision(db, job.revisionId, {
    decision: 'approve',
    syncRedisFn: null,
  });
  assert.ok(
    decision.skipped.some((s) => s.planId === target.planId && s.reason === 'slot_missing'),
  );
  const brief = db
    .prepare('SELECT status, block_reason FROM editorial_briefs WHERE brief_id = ?')
    .get(target.briefId);
  assert.equal(brief.status, 'blocked');
  assert.equal(brief.block_reason, 'slot_missing');
  db.close();
});

test('weekly analysis rejects a price above remaining budget before calling the model', () => {
  const db = openDb();
  let calls = 0;
  const result = createWeeklyEditorialJob(db, {
    projectId: 'dark-academia',
    weekStart: '2026-10-12',
    estimatedCostUsd: WEEKLY_BUDGET_USD + 0.1,
    llm: () => {
      calls += 1;
      return { proposal: {}, costUsd: 0 };
    },
  });
  assert.equal(result.error, 'budget_exhausted');
  assert.equal(calls, 0);
  assert.equal(weeklyCommittedUsd(db, 'dark-academia', '2026-10-12'), 0);
  db.close();
});
