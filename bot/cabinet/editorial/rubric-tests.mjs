import { randomUUID } from 'node:crypto';
import { bumpDataVersion, withTransaction } from '../db.mjs';
import { createRubric, changeRubric, listRubrics, validateRubric } from '../rubrics.mjs';
import { buildEditorialSnapshot } from './snapshot.mjs';
import { buildDeterministicProposal } from './proposal.mjs';

function fail(code, message, status = 409) {
  throw Object.assign(new Error(message), { code, status });
}
function rowFor(db, id) {
  const row = db.prepare('SELECT * FROM editorial_rubric_tests WHERE id=?').get(id);
  if (!row) fail('not_found', 'Гипотеза не найдена', 404);
  return row;
}
function configEqual(a, b) {
  return JSON.stringify(validateRubric(a)) === JSON.stringify(validateRubric(b));
}

export function rubricSuggestions(db, projectId) {
  const { snapshot, inputSnapshotHash } = buildEditorialSnapshot(db, { projectId });
  const { proposal } = buildDeterministicProposal(snapshot);
  const active = snapshot.rubrics.filter((r) => r.state === 'active' && r.enabled);
  const suggestions = [];
  const counts = snapshot.diversity.counts?.rubrics || {};
  const source = active
    .filter((r) => !r.pending)
    .sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0))[0];
  const formats = proposal.newFormats;
  const reason =
    snapshot.diversity.findings.map((f) => f.label).join('; ') ||
    'Проверить новый редакционный приём на небольшой серии публикаций';
  if (source && source.textPrompt.length < 5500) {
    const format = formats[0];
    suggestions.push({
      kind: 'change',
      rubricId: source.id,
      expectedRevision: source.revision,
      title: `Изменить «${source.name}»`,
      hypothesis: format.hypothesis,
      reason,
      evidenceIds: format.evidenceIds,
      targetPosts: 6,
      reviewDays: 14,
      metric: 'views',
      successRule: 'Медиана просмотров выше предыдущих 6 публикаций рубрики; без снижения качества',
      config: {
        ...validateRubric(source),
        textPrompt: [source.textPrompt, format.exampleBrief, format.qualityLimit]
          .filter(Boolean)
          .join('\n')
          .slice(0, 6000),
      },
    });
  }
  let free;
  for (const time of ['10:00', '14:00', '18:00', '20:00']) {
    for (const day of [3, 5, 1, 2, 4, 6, 7]) {
      if (!active.some((r) => r.days.includes(day) && r.times.includes(time))) {
        free = { day, time };
        break;
      }
    }
    if (free) break;
  }
  if (free) {
    const format = formats[1];
    suggestions.push({
      kind: 'new',
      title: format.title,
      hypothesis: format.hypothesis,
      reason,
      evidenceIds: format.evidenceIds,
      targetPosts: 3,
      reviewDays: 21,
      metric: 'views',
      successRule:
        'Медиана просмотров не ниже последних 6 публикаций сообщества; оценить качество вручную',
      config: validateRubric({
        name: format.title,
        days: [free.day],
        times: [free.time],
        media: 'text',
        textPrompt: `${format.exampleBrief}\n${format.qualityLimit}`,
        mediaPrompt: '',
        enabled: true,
        color: '#5640ad',
      }),
    });
  }
  return {
    projectId,
    rubrics: snapshot.rubrics,
    suggestions,
    inputSnapshotHash,
    metricsStale: snapshot.metrics.stale,
    reason,
  };
}

export function proposeRubricTest(db, service, input, now = new Date()) {
  const { projectId, kind, rubricId = null } = input;
  if (!service.projects?.[projectId]) fail('rubric_project_invalid', 'Выберите сообщество', 400);
  if (!['new', 'change'].includes(kind))
    fail('invalid_kind', 'Выберите новую или текущую рубрику', 400);
  const current = listRubrics(db, projectId).find((r) => r.id === rubricId);
  if (kind === 'change' && (!current || current.state !== 'active' || current.pending))
    fail('rubric_not_found', 'Рубрика недоступна для изменения');
  if (kind === 'change' && Number(input.expectedRevision) !== current.revision)
    fail('rubric_version_conflict', 'Рубрика изменилась. Соберите предложение заново');
  const hypothesis = String(input.hypothesis || '').trim();
  const successRule = String(input.successRule || '').trim();
  if (!hypothesis || hypothesis.length > 2000 || !successRule || successRule.length > 2000)
    fail('hypothesis_invalid', 'Укажите гипотезу и критерий успеха (до 2000 символов)', 400);
  const targetPosts = Number(input.targetPosts),
    reviewDays = Number(input.reviewDays);
  if (
    !Number.isInteger(targetPosts) ||
    targetPosts < 2 ||
    targetPosts > 30 ||
    !Number.isInteger(reviewDays) ||
    reviewDays < 1 ||
    reviewDays > 60 ||
    !['views', 'likes', 'comments', 'reposts'].includes(input.metric)
  )
    fail('test_window_invalid', 'Проверьте число публикаций, срок и метрику', 400);
  const config = validateRubric(input.config);
  if (kind === 'change' && configEqual(current, config))
    fail('change_required', 'Предложение должно менять настройки рубрики', 400);
  if (!config.enabled) fail('test_disabled', 'Тестируемая рубрика должна быть включена', 400);
  const proposal = {
    hypothesis,
    successRule,
    targetPosts,
    reviewDays,
    metric: input.metric,
    config,
    reason: String(input.reason || '').slice(0, 2000),
    evidenceIds: (Array.isArray(input.evidenceIds) ? input.evidenceIds : [])
      .slice(0, 30)
      .map(String),
  };
  const id = randomUUID();
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO editorial_rubric_tests
      (id,project_id,kind,rubric_id,expected_revision,proposal_json,before_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      projectId,
      kind,
      kind === 'change' ? rubricId : null,
      current?.revision ?? null,
      JSON.stringify(proposal),
      current ? JSON.stringify(validateRubric(current)) : null,
      now.toISOString(),
      now.toISOString(),
    );
    bumpDataVersion(db);
  });
  return getRubricTest(db, id, now);
}

function claim(db, row, from, to, now) {
  withTransaction(db, () => {
    if (['applying', 'stopping'].includes(to)) {
      const other = db
        .prepare(
          "SELECT id FROM editorial_rubric_tests WHERE project_id=? AND id!=? AND status IN ('applying','testing','stopping')",
        )
        .get(row.project_id, row.id);
      if (other) fail('test_already_active', 'Завершите текущий тест перед запуском следующего');
    }
    const result = db
      .prepare('UPDATE editorial_rubric_tests SET status=?,updated_at=? WHERE id=? AND status=?')
      .run(to, now.toISOString(), row.id, from);
    if (to === 'applying')
      db.prepare('UPDATE editorial_rubric_tests SET started_at=? WHERE id=?').run(
        now.toISOString(),
        row.id,
      );
    if (result.changes !== 1)
      fail('test_version_conflict', 'Состояние теста изменилось. Обновите страницу');
    bumpDataVersion(db);
  });
}

export async function decideRubricTest(
  db,
  service,
  id,
  { decision, note = '', client = null, now = new Date() } = {},
) {
  let row = rowFor(db, id);
  const proposal = JSON.parse(row.proposal_json);
  if (!service.projects?.[row.project_id]) fail('rubric_project_invalid', 'Сообщество недоступно');
  const stamp = now.toISOString();
  if (decision === 'reject') {
    if (row.status !== 'proposed') fail('not_decidable', 'Можно отклонить только предложение');
    claim(db, row, 'proposed', 'rejected', now);
  } else if (decision === 'apply') {
    if (!['proposed', 'applying'].includes(row.status))
      fail('not_decidable', 'Предложение уже решено');
    if (row.status === 'proposed') claim(db, row, 'proposed', 'applying', now);
    try {
      if (row.kind === 'new') {
        withTransaction(db, () => {
          row = rowFor(db, id);
          if (row.status !== 'applying') fail('not_decidable', 'Предложение уже решено');
          const rubric = createRubric(db, service, row.project_id, proposal.config, now);
          db.prepare(
            "UPDATE editorial_rubric_tests SET rubric_id=?,applied_revision=?,status='testing',started_at=?,updated_at=? WHERE id=?",
          ).run(rubric.id, rubric.revision, stamp, stamp, id);
        });
      } else {
        const current = listRubrics(db, row.project_id).find((r) => r.id === row.rubric_id);
        if (!current) fail('rubric_not_found', 'Рубрика удалена');
        if (
          current.pending &&
          (current.pendingAction !== 'edit' || !configEqual(current, proposal.config))
        )
          fail('rubric_version_conflict', 'Другая правка рубрики ещё не завершена');
        // Recover a completed mutation after a process restart without repeating cancellation.
        if (!(
          current.state === 'active' &&
          current.revision === row.expected_revision + 1 &&
          configEqual(current, proposal.config)
        )) {
          if (current.revision !== row.expected_revision)
            fail('rubric_version_conflict', 'Рубрика изменилась. Соберите предложение заново');
          await changeRubric(
            db,
            current.id,
            { ...proposal.config, revision: row.expected_revision },
            { client, now },
          );
        }
        db.prepare(
          "UPDATE editorial_rubric_tests SET applied_revision=?,status='testing',started_at=COALESCE(started_at,?),updated_at=? WHERE id=? AND status='applying'",
        ).run(row.expected_revision + 1, stamp, stamp, id);
      }
    } catch (error) {
      const current = listRubrics(db, row.project_id).find((r) => r.id === row.rubric_id);
      if (
        !current?.pending ||
        current.pendingAction !== 'edit' ||
        !configEqual(current, proposal.config)
      )
        db.prepare(
          "UPDATE editorial_rubric_tests SET status='proposed',started_at=NULL,updated_at=? WHERE id=? AND status='applying'",
        ).run(stamp, id);
      throw error;
    }
  } else if (decision === 'keep') {
    if (row.status !== 'testing') fail('not_decidable', 'Тест ещё не запущен или уже завершён');
    const current = listRubrics(db, row.project_id).find((r) => r.id === row.rubric_id);
    if (current?.pending) fail('rubric_preparation_busy', 'Сначала завершите изменение рубрики');
    claim(db, row, row.status, 'kept', now);
  } else if (decision === 'rollback') {
    if (!['testing', 'stopping'].includes(row.status))
      fail('not_decidable', 'Тест недоступен для отката');
    const current = listRubrics(db, row.project_id).find((r) => r.id === row.rubric_id);
    if (!current) fail('rubric_not_found', 'Рубрика удалена');
    const restored =
      row.kind === 'new' ? { ...proposal.config, enabled: false } : JSON.parse(row.before_json);
    if (current.pending && (current.pendingAction !== 'edit' || !configEqual(current, restored)))
      fail('rubric_version_conflict', 'Другая правка рубрики ещё не завершена');
    const recovered =
      row.status === 'stopping' &&
      current.state === 'active' &&
      current.revision === row.applied_revision + 1 &&
      configEqual(current, restored);
    if (!recovered && current.revision !== row.applied_revision)
      fail(
        'rubric_version_conflict',
        'Рубрика изменена вручную после запуска. Откатите нужные настройки в разделе «Рубрики»',
      );
    if (row.status === 'testing') claim(db, row, 'testing', 'stopping', now);
    if (!recovered)
      await changeRubric(
        db,
        current.id,
        { ...restored, revision: row.applied_revision },
        { client, now },
      );
    db.prepare(
      "UPDATE editorial_rubric_tests SET status='rolled_back',updated_at=? WHERE id=? AND status='stopping'",
    ).run(stamp, id);
  } else fail('invalid_decision', 'Неизвестное действие', 400);
  if (['keep', 'rollback', 'reject'].includes(decision))
    db.prepare('UPDATE editorial_rubric_tests SET ended_at=?,result_note=? WHERE id=?').run(
      stamp,
      String(note).slice(0, 2000),
      id,
    );
  db.prepare(
    'INSERT INTO audit_log(audit_id,actor,action,payload_json,created_at) VALUES (?,?,?,?,?)',
  ).run(
    randomUUID(),
    'owner',
    `editorial_rubric_${decision}`,
    JSON.stringify({ id, projectId: row.project_id, rubricId: rowFor(db, id).rubric_id }),
    stamp,
  );
  bumpDataVersion(db);
  return getRubricTest(db, id, now);
}

export function listRubricTests(db, projectId, now = new Date()) {
  return db
    .prepare(
      'SELECT id FROM editorial_rubric_tests WHERE project_id=? ORDER BY created_at DESC LIMIT 50',
    )
    .all(projectId)
    .map((row) => getRubricTest(db, row.id, now));
}
export function getRubricTest(db, id, now = new Date()) {
  const row = rowFor(db, id),
    proposal = JSON.parse(row.proposal_json);
  const current = listRubrics(db, row.project_id).find((r) => r.id === row.rubric_id) || null;
  const published = row.started_at
    ? db
        .prepare(
          `SELECT s.edition_id,s.slot_utc FROM schedule_slots s
    JOIN rubric_slots r USING(plan_id) WHERE r.rubric_id=? AND r.revision=?
    AND s.project_id=? AND s.plan_status='sent' AND s.slot_utc>=? AND (? IS NULL OR s.slot_utc<=?)
    ORDER BY s.slot_utc`,
        )
        .all(
          row.rubric_id,
          row.applied_revision,
          row.project_id,
          row.started_at,
          row.ended_at,
          row.ended_at,
        )
    : [];
  const baseline = row.started_at
    ? db
        .prepare(
          `SELECT DISTINCT s.edition_id,s.slot_utc FROM schedule_slots s
    LEFT JOIN rubric_slots r USING(plan_id) WHERE s.project_id=? AND s.plan_status='sent' AND s.slot_utc<?
    AND (?='new' OR r.rubric_id=?) ORDER BY s.slot_utc DESC LIMIT 6`,
        )
        .all(row.project_id, row.started_at, row.kind, row.rubric_id)
    : [];
  function measure(items) {
    const values = items
      .map(
        (item) =>
          db
            .prepare(
              `SELECT ${proposal.metric} AS value FROM metric_observations
      WHERE project_id=? AND edition_id=? AND is_active=1 AND metric_mode='cumulative'
      ORDER BY observed_at DESC LIMIT 1`,
            )
            .get(row.project_id, item.edition_id)?.value,
      )
      .filter((v) => v != null)
      .sort((a, b) => a - b);
    const n = values.length;
    return {
      posts: items.length,
      measured: n,
      median: n ? (values[Math.floor((n - 1) / 2)] + values[Math.floor(n / 2)]) / 2 : null,
    };
  }
  const reviewAt = row.started_at
    ? new Date(Date.parse(row.started_at) + proposal.reviewDays * 86400000).toISOString()
    : null;
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    rubricId: row.rubric_id,
    expectedRevision: row.expected_revision,
    appliedRevision: row.applied_revision,
    status: row.status,
    proposal,
    before: row.before_json ? JSON.parse(row.before_json) : null,
    current,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    note: row.result_note,
    report: {
      test: measure(published),
      baseline: measure(baseline),
      reviewAt,
      reviewDue:
        !!reviewAt &&
        (Date.parse(reviewAt) <= now.getTime() || published.length >= proposal.targetPosts),
      changedManually:
        !!current && !!row.applied_revision && current.revision !== row.applied_revision,
      warning:
        'Это последовательная проверка гипотезы. Сравнение не доказывает причинность; возраст публикаций и продвижение могут отличаться.',
    },
  };
}
