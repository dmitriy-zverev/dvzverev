import { randomUUID } from 'node:crypto';
import { PROJECT_RULES } from './vocab.mjs';

const MAX_ACTIVE_NEW_FORMATS = 1;

/**
 * Build a structured weekly proposal from deterministic snapshot data.
 * Optional llmEnrichment may refine copy but must keep evidence IDs and slot counts.
 */
export function buildDeterministicProposal(snapshot, { llmEnrichment = null } = {}) {
  const projectId = snapshot.projectId;
  const rules = PROJECT_RULES[projectId] || { constraints: [] };
  const availableSlots = snapshot.slots.filter((s) => !s.started && s.planStatus === 'planned');
  const diversity = snapshot.diversity || { findings: [], counts: {} };
  const metrics = snapshot.metrics || {};
  const evidenceBase = collectEvidence(snapshot);

  const overview = {
    summary: summarizeRecent(snapshot),
    repeats: diversity.findings || [],
    missingData: metrics.coverageNote || (metrics.stale ? 'данных недостаточно' : null),
    incompleteEditions: snapshot.incompleteEditions?.length || 0,
    evidenceIds: evidenceBase.slice(0, 20),
  };

  const continueRubrics = buildContinue(snapshot, evidenceBase);
  const pauseRubrics = buildPause(snapshot, evidenceBase);
  const newFormats = buildNewFormats(snapshot, evidenceBase);
  const seriesPlans = buildSeriesPlans(snapshot, evidenceBase);
  const calendar = buildCalendar(availableSlots, snapshot, evidenceBase);
  const nextMaterial = buildNextMaterial(snapshot, calendar, evidenceBase);

  let proposal = {
    projectId,
    weekStart: snapshot.weekStart,
    weekEnd: snapshot.weekEnd,
    overview,
    continue: continueRubrics,
    pause: pauseRubrics,
    newFormats,
    series: seriesPlans,
    calendar,
    nextMaterial,
    constraints: rules.constraints || [],
    activeNewFormatsLimit: MAX_ACTIVE_NEW_FORMATS,
    metricsStale: Boolean(metrics.stale),
    generatedBy: llmEnrichment ? 'llm+deterministic' : 'deterministic',
  };

  if (llmEnrichment) {
    proposal = mergeLlmEnrichment(proposal, llmEnrichment);
  }

  const validation = validateProposal(proposal, snapshot);
  return { proposal, validation };
}

export function validateProposal(proposal, snapshot) {
  const errors = [];
  if (!proposal?.projectId || proposal.projectId !== snapshot.projectId) {
    errors.push('project_mismatch');
  }
  if (!proposal.overview) errors.push('missing_overview');
  if (!Array.isArray(proposal.continue)) errors.push('missing_continue');
  if (!Array.isArray(proposal.pause)) errors.push('missing_pause');
  if (!Array.isArray(proposal.newFormats) || proposal.newFormats.length !== 2) {
    errors.push('new_formats_must_be_two');
  }
  if (!Array.isArray(proposal.series)) errors.push('missing_series');
  if (!Array.isArray(proposal.calendar)) errors.push('missing_calendar');
  if (!proposal.nextMaterial) errors.push('missing_next_material');

  const available = new Set(
    snapshot.slots.filter((s) => !s.started && s.planStatus === 'planned').map((s) => s.planId),
  );
  for (const item of proposal.calendar || []) {
    if (!item.planId || !available.has(item.planId)) {
      errors.push(`invalid_slot:${item.planId || 'missing'}`);
    }
    if (!item.topic || !item.thesis) errors.push(`brief_incomplete:${item.planId}`);
    if (!Array.isArray(item.evidenceIds)) errors.push(`missing_evidence:${item.planId}`);
  }

  const activateCount = (proposal.newFormats || []).filter((f) => f.activate).length;
  if (activateCount > MAX_ACTIVE_NEW_FORMATS) {
    errors.push('too_many_active_new_formats');
  }

  // Series dependency acyclicity within proposal
  const pred = new Map();
  for (const s of proposal.series || []) {
    for (const ep of s.episodes || []) {
      if (ep.predecessorPlanId) pred.set(ep.planId, ep.predecessorPlanId);
    }
  }
  for (const [planId, predecessor] of pred) {
    let cursor = predecessor;
    const seen = new Set([planId]);
    while (cursor) {
      if (seen.has(cursor)) {
        errors.push(`series_cycle:${planId}`);
        break;
      }
      seen.add(cursor);
      cursor = pred.get(cursor);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function diffProposals(current, next) {
  const currentSlots = new Map((current?.calendar || []).map((c) => [c.planId, c]));
  const nextSlots = new Map((next?.calendar || []).map((c) => [c.planId, c]));
  const changes = [];
  for (const [planId, brief] of nextSlots) {
    const prev = currentSlots.get(planId);
    if (!prev) {
      changes.push({ planId, kind: 'added', topic: brief.topic });
      continue;
    }
    if (prev.topic !== brief.topic || prev.thesis !== brief.thesis) {
      changes.push({
        planId,
        kind: 'changed',
        from: { topic: prev.topic, thesis: prev.thesis },
        to: { topic: brief.topic, thesis: brief.thesis },
      });
    }
  }
  for (const [planId, brief] of currentSlots) {
    if (!nextSlots.has(planId)) {
      changes.push({ planId, kind: 'removed', topic: brief.topic });
    }
  }
  return {
    changes,
    continueChanged:
      JSON.stringify(current?.continue || []) !== JSON.stringify(next?.continue || []),
    pauseChanged: JSON.stringify(current?.pause || []) !== JSON.stringify(next?.pause || []),
    seriesChanged: JSON.stringify(current?.series || []) !== JSON.stringify(next?.series || []),
  };
}

function collectEvidence(snapshot) {
  const ids = [];
  for (const m of snapshot.memory || []) {
    if (m.memoryId) ids.push(`memory:${m.memoryId}`);
    for (const oid of m.observationIds || []) ids.push(`observation:${oid}`);
  }
  for (const finding of snapshot.diversity?.findings || []) {
    ids.push(`finding:${finding.kind}`);
  }
  if (!ids.length) ids.push('editorial_hypothesis:insufficient_data');
  return ids;
}

function summarizeRecent(snapshot) {
  const n = snapshot.memory?.length || 0;
  const findings = snapshot.diversity?.findings?.length || 0;
  const incomplete = snapshot.incompleteEditions?.length || 0;
  return `За 30 дней: ${n} подтверждённых VK-постов; повторов/замечаний: ${findings}; незавершённых выпусков (не оценены): ${incomplete}.`;
}

function buildContinue(snapshot, evidenceIds) {
  const rubrics = snapshot.diversity?.counts?.rubrics || {};
  const ranked = Object.entries(rubrics).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) {
    return [
      {
        rubricId: defaultRubric(snapshot.projectId),
        reason: 'данных недостаточно — сохранить базовую рубрику',
        evidenceIds: ['editorial_hypothesis:insufficient_data'],
        suggestedTopics: [],
        suggestedPlanIds: snapshot.slots
          .filter((s) => !s.started)
          .slice(0, 2)
          .map((s) => s.planId),
      },
    ];
  }
  return ranked.slice(0, 2).map(([rubricId]) => ({
    rubricId,
    reason: 'рубрика уже присутствует в памяти; продолжить с чередованием темы',
    evidenceIds: evidenceIds
      .filter((id) => id.startsWith('memory:') || id.startsWith('finding:'))
      .slice(0, 5),
    suggestedTopics: [],
    suggestedPlanIds: [],
  }));
}

function buildPause(snapshot, evidenceIds) {
  const heavy = (snapshot.diversity?.findings || []).find((f) => f.kind === 'heavy_tone_dominance');
  if (!heavy) {
    return [
      {
        rubricId: null,
        reason: 'пауза не требуется',
        pauseUntil: null,
        reviewAt: null,
        evidenceIds: ['editorial_hypothesis:no_pause'],
      },
    ];
  }
  const reviewAt = snapshot.weekEnd;
  return [
    {
      rubricId: null,
      tone: 'heavy',
      reason: 'слишком высокая доля тяжёлого тона',
      pauseUntil: reviewAt,
      reviewAt,
      evidenceIds: evidenceIds
        .filter((id) => id.includes('heavy') || id.startsWith('finding:'))
        .slice(0, 5),
    },
  ];
}

function buildNewFormats(snapshot, evidenceIds) {
  const projectId = snapshot.projectId;
  const candidates = {
    'dark-academia': [
      {
        id: 'format:lighter-tone-arc',
        title: 'Лёгкая дуга памяти',
        hypothesis: 'чередование спокойного тона снизит однообразие концовок',
        exampleBrief:
          'Короткая цитата о возвращении; комментарий в спокойном тоне без тяжёлой финальной фразы',
        kpi: 'меньше повторов закрывающих фраз; editorial_hypothesis',
        qualityLimit: 'цитата только из проверенного источника',
      },
      {
        id: 'format:author-rotation-focus',
        title: 'Фокус на чередовании авторов',
        hypothesis: 'жёсткое чередование авторов улучшит разнообразие',
        exampleBrief: 'Выбрать автора, которого не было в последних двух постах',
        kpi: 'доля уникальных авторов за неделю',
        qualityLimit: 'не ослаблять проверку цитат',
      },
    ],
    'code-to-think': [
      {
        id: 'format:midweek-editorial',
        title: 'Срединный редакторский материал',
        hypothesis: 'короткий материал между задачами повышает связность',
        exampleBrief: 'Одна полезная штука по теме недавней задачи без нового кода на запуск',
        kpi: 'editorial_hypothesis',
        qualityLimit: 'техническая проверка обязательна',
      },
      {
        id: 'format:solution-bridge',
        title: 'Мост к разбору',
        hypothesis: 'явная связка задача→разбор снижает lost context',
        exampleBrief: 'Разбор только для sent-задачи с ссылкой на wall',
        kpi: 'доля разборов с подтверждённым predecessor',
        qualityLimit: 'нельзя разбирать uncertain/failed задачу как published',
      },
    ],
    things: [
      {
        id: 'format:reframe-pair',
        title: 'Пара сценарий→другой взгляд',
        hypothesis: 'парный взгляд на один сценарий усиливает серию',
        exampleBrief: 'Утренний сценарий и вечерний reframe без цен и ссылок',
        kpi: 'editorial_hypothesis',
        qualityLimit: 'без товарных свойств и медицины',
      },
      {
        id: 'format:material-focus',
        title: 'Фокус на материале вещи',
        hypothesis: 'акцент на материал/текстуру без бренда',
        exampleBrief: 'Практическая деталь материала в бытовом сценарии',
        kpi: 'editorial_hypothesis',
        qualityLimit: 'без вымышленных тестов',
      },
    ],
  };
  const list = (candidates[projectId] || candidates.things).slice(0, 2).map((c, index) => ({
    ...c,
    activate: index === 0,
    evidenceIds: evidenceIds.slice(0, 3),
  }));
  return list;
}

function buildSeriesPlans(snapshot, evidenceIds) {
  const open = (snapshot.series || []).filter((s) =>
    ['draft', 'approved', 'active'].includes(s.status),
  );
  if (!open.length) {
    return [
      {
        seriesId: null,
        title: 'Новая короткая серия (предложение)',
        goal: '2–3 связанных выпуска в пределах недельного окна',
        status: 'proposed',
        episodes: [],
        completion: 'завершить до конца окна или paused',
        evidenceIds: ['editorial_hypothesis:new_series'],
      },
    ];
  }
  return open.slice(0, 3).map((s) => ({
    seriesId: s.seriesId,
    title: s.title,
    goal: s.goal,
    status: s.status,
    episodes: [],
    completion: s.plannedEndAt || snapshot.weekEnd,
    evidenceIds: evidenceIds.slice(0, 3),
  }));
}

function buildCalendar(availableSlots, snapshot, evidenceIds) {
  const rubrics = Object.keys(snapshot.diversity?.counts?.rubrics || {});
  const defaultRubricId = rubrics[0] || defaultRubric(snapshot.projectId);
  return availableSlots.map((slot, index) => ({
    briefId: randomUUID(),
    planId: slot.planId,
    slotUtc: slot.slotUtc,
    slotKey: slot.slotKey,
    rubricId: defaultRubricId,
    topic: topicForSlot(snapshot.projectId, index, slot),
    thesis: thesisForSlot(snapshot.projectId, index),
    tone: toneForSlot(snapshot, index),
    structure: structureForProject(snapshot.projectId),
    constraints: PROJECT_RULES[snapshot.projectId]?.constraints || [],
    sources: [],
    seriesId: null,
    experimentId: snapshot.experiments?.[0]?.experimentId || null,
    evidenceIds: evidenceIds.slice(0, 5),
    goal: 'сохранить разнообразие и достоверность источников',
  }));
}

function buildNextMaterial(snapshot, calendar, evidenceIds) {
  const first = calendar[0];
  const lastMemory = snapshot.memory?.[0];
  return {
    planId: first?.planId || null,
    continuesFromEditionId: lastMemory?.editionId || null,
    link:
      lastMemory?.editionId && first
        ? 'продолжает тему предыдущего подтверждённого выпуска, оставаясь самостоятельным'
        : 'первый слот недели без жёсткой зависимости',
    readerValue: 'ясная следующая мысль без требования читать весь архив',
    evidenceIds: evidenceIds.slice(0, 3),
  };
}

function mergeLlmEnrichment(proposal, enrichment) {
  if (!enrichment || typeof enrichment !== 'object') return proposal;
  const next = { ...proposal };
  if (enrichment.overview?.summary) {
    next.overview = {
      ...next.overview,
      summary: String(enrichment.overview.summary).slice(0, 800),
    };
  }
  if (Array.isArray(enrichment.calendar)) {
    const byPlan = new Map(enrichment.calendar.map((c) => [c.planId, c]));
    next.calendar = proposal.calendar.map((item) => {
      const patch = byPlan.get(item.planId);
      if (!patch) return item;
      return {
        ...item,
        topic: String(patch.topic || item.topic).slice(0, 500),
        thesis: String(patch.thesis || item.thesis).slice(0, 2000),
        tone: patch.tone || item.tone,
        // never drop evidence
        evidenceIds: item.evidenceIds,
      };
    });
  }
  return next;
}

function defaultRubric(projectId) {
  if (projectId === 'code-to-think') return 'code-to-think:task';
  if (projectId === 'things') return 'things:scenario';
  return 'dark-academia:quote';
}

function topicForSlot(projectId, index) {
  if (projectId === 'code-to-think') {
    return index % 2 === 0 ? 'Задача недели' : 'Разбор или редакторский материал';
  }
  if (projectId === 'things') {
    return index % 2 === 0 ? 'Бытовой сценарий' : 'Другой взгляд на сценарий';
  }
  return index % 2 === 0 ? 'Память и привязанность' : 'Невозможность возвращения';
}

function thesisForSlot(projectId, index) {
  if (projectId === 'code-to-think') {
    return index % 2 === 0
      ? 'Самостоятельная задача с проверяемым условием'
      : 'Связать с подтверждённой задачей или дать отдельный редакционный материал';
  }
  if (projectId === 'things') {
    return 'Практическая деталь без цен, ссылок и медицинских советов';
  }
  return 'Короткая проверенная цитата и самостоятельный комментарий без повтора недавних заходов';
}

function toneForSlot(snapshot, index) {
  const heavy = (snapshot.diversity?.findings || []).some((f) => f.kind === 'heavy_tone_dominance');
  if (heavy) return index % 2 === 0 ? 'calm' : 'warm';
  return index % 3 === 0 ? 'reflective' : 'calm';
}

function structureForProject(projectId) {
  if (projectId === 'code-to-think') return 'task';
  if (projectId === 'things') return 'scenario_tip';
  return 'quote_commentary';
}
