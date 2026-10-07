import { createHash } from 'node:crypto';
import {
  addDaysYmd,
  formatDateYmd,
  localSlotToUtc,
  OPERATOR_TIMEZONE,
  zonedParts,
} from '../time.mjs';
import { listMemory, memoryFingerprint, syncEditorialMemory } from './memory.mjs';
import { analyzeDiversity } from './diversity.mjs';
import { listSeries } from './series.mjs';
import { PROJECT_RULES } from './vocab.mjs';

/** Monday YMD for the plan week: upcoming Monday (today if Monday; tomorrow if Sunday). */
export function nextPlanWeekStart(now = new Date(), timeZone = OPERATOR_TIMEZONE) {
  const parts = zonedParts(now, timeZone);
  const todayYmd = formatDateYmd({
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  });
  const weekday = weekdayNumber(now, timeZone);
  if (weekday === 1) return todayYmd;
  if (weekday === 7) return addDaysYmd(todayYmd, 1, timeZone);
  const daysUntilMonday = 8 - weekday;
  return addDaysYmd(todayYmd, daysUntilMonday, timeZone);
}

function weekdayNumber(now, timeZone) {
  const map = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const short = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(now);
  return map[short] || 1;
}

export function isEditorialProposalWindow(now = new Date(), timeZone = OPERATOR_TIMEZONE) {
  const parts = zonedParts(now, timeZone);
  const weekday = weekdayNumber(now, timeZone);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return weekday === 7 && (hour > 19 || (hour === 19 && minute >= 30));
}

export function buildEditorialSnapshot(
  db,
  { projectId, weekStart = null, now = new Date(), sync = true } = {},
) {
  if (!projectId) throw new Error('project_required');
  if (sync) syncEditorialMemory(db, { projectId, now });

  const planWeek = weekStart || nextPlanWeekStart(now);
  const weekEnd = addDaysYmd(planWeek, 6, OPERATOR_TIMEZONE);
  const rangeStart = localSlotToUtc(planWeek, '00:00', OPERATOR_TIMEZONE).toISOString();
  const rangeEnd = localSlotToUtc(
    addDaysYmd(planWeek, 7, OPERATOR_TIMEZONE),
    '00:00',
    OPERATOR_TIMEZONE,
  ).toISOString();
  const memory = listMemory(db, { projectId, now });
  const diversity = analyzeDiversity(memory, { projectId });
  const series = listSeries(db, { projectId });

  const project = db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId);
  const schedule = project ? JSON.parse(project.schedule_json || '{}') : {};
  const destinations = project ? JSON.parse(project.destinations_json || '[]') : [];

  const slots = db
    .prepare(
      `SELECT plan_id, project_id, destination_id, slot_utc, slot_key, publication_kind,
              expected_media, topic, brief, topic_state, plan_status, edition_id, version
       FROM schedule_slots
       WHERE project_id = ?
         AND slot_utc >= ?
         AND slot_utc < ?
       ORDER BY slot_utc ASC`,
    )
    .all(projectId, rangeStart, rangeEnd);

  // Incomplete editions in memory window — not published/evaluated
  const incomplete = db
    .prepare(
      `SELECT e.edition_id, e.aggregate_status, d.status AS delivery_status, d.sent_at
       FROM editions e
       LEFT JOIN deliveries d ON d.edition_id = e.edition_id
       WHERE e.project_id = ?
         AND (d.status IS NULL OR d.status NOT IN ('sent', 'cancelled'))
       ORDER BY e.created_at DESC LIMIT 40`,
    )
    .all(projectId);

  const metricsMeta = latestMetricsMeta(db, projectId);
  const activePlan = latestApprovedRevision(db, projectId, planWeek);
  const experiments = listOpenExperiments(db, projectId);
  const promptVersions = listActivePromptVersions(db, projectId);

  const snapshot = {
    projectId,
    weekStart: planWeek,
    weekEnd,
    rules: PROJECT_RULES[projectId] || null,
    schedule,
    destinations,
    slots: slots.map((s) => ({
      planId: s.plan_id,
      destinationId: s.destination_id,
      slotUtc: s.slot_utc,
      slotKey: s.slot_key,
      publicationKind: s.publication_kind,
      expectedMedia: s.expected_media,
      topic: s.topic,
      brief: s.brief,
      topicState: s.topic_state,
      planStatus: s.plan_status,
      editionId: s.edition_id,
      version: s.version,
      started: Boolean(s.edition_id),
    })),
    memory: memory.map((m) => ({
      memoryId: m.memoryId,
      editionId: m.editionId,
      sentAt: m.sentAt,
      rubricId: m.rubricId,
      tone: m.tone,
      intensity: m.intensity,
      structure: m.structure,
      author: m.author,
      openingPhrase: m.openingPhrase,
      closingPhrase: m.closingPhrase,
      mediaActual: m.mediaActual,
      coverage: m.coverage,
      observationIds: m.observationIds,
      // body text withheld from LLM context size; available separately if needed within TTL
      hasBody: Boolean(m.bodyText),
    })),
    diversity,
    series,
    incompleteEditions: incomplete.map((r) => ({
      editionId: r.edition_id,
      aggregateStatus: r.aggregate_status,
      deliveryStatus: r.delivery_status,
      sentAt: r.sent_at,
      evaluated: false,
      published: false,
    })),
    metrics: metricsMeta,
    activePlan,
    experiments,
    promptVersions,
    configVersion:
      db.prepare(`SELECT value FROM cabinet_meta WHERE key = ?`).get('service_config_version')
        ?.value || null,
  };

  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        projectId,
        weekStart: planWeek,
        memoryFp: memoryFingerprint(memory),
        slotIds: slots.map((s) => `${s.plan_id}:${s.version}:${s.topic || ''}`),
        metricsObservedAt: metricsMeta.latestObservedAt,
        activeRevisionId: activePlan?.revisionId || null,
        seriesIds: series.map((s) => `${s.seriesId}:${s.status}`),
      }),
    )
    .digest('hex');

  return { snapshot, inputSnapshotHash: hash, metricsStale: metricsMeta.stale };
}

function latestMetricsMeta(db, projectId) {
  try {
    const row = db
      .prepare(
        `SELECT observed_at, import_id FROM metric_observations
         WHERE project_id = ? AND is_active = 1
         ORDER BY observed_at DESC LIMIT 1`,
      )
      .get(projectId);
    const importRow = db
      .prepare(
        `SELECT import_id, committed_at, observed_at FROM metric_imports
         WHERE project_id = ? AND status = 'committed'
         ORDER BY committed_at DESC LIMIT 1`,
      )
      .get(projectId);
    const latestObservedAt = row?.observed_at || null;
    const ageDays = latestObservedAt
      ? (Date.now() - Date.parse(latestObservedAt)) / 86400000
      : null;
    return {
      latestObservedAt,
      latestImportId: importRow?.import_id || null,
      latestImportAt: importRow?.committed_at || null,
      ageDays,
      stale: ageDays == null || ageDays > 10,
      coverageNote:
        ageDays == null
          ? 'данных недостаточно'
          : ageDays > 10
            ? 'метрики устарели относительно недельного окна'
            : null,
    };
  } catch {
    return {
      latestObservedAt: null,
      stale: true,
      coverageNote: 'данных недостаточно',
    };
  }
}

function latestApprovedRevision(db, projectId, weekStart) {
  const row = db
    .prepare(
      `SELECT * FROM editorial_plan_revisions
       WHERE project_id = ? AND week_start = ? AND status IN ('approved', 'partial')
       ORDER BY revision_number DESC LIMIT 1`,
    )
    .get(projectId, weekStart);
  if (!row) return null;
  return {
    revisionId: row.revision_id,
    revisionNumber: row.revision_number,
    status: row.status,
    decidedAt: row.decided_at,
  };
}

function listOpenExperiments(db, projectId) {
  try {
    return db
      .prepare(
        `SELECT experiment_id, name, factor, status FROM experiments
         WHERE project_id = ? AND status IN ('draft', 'active') LIMIT 20`,
      )
      .all(projectId)
      .map((r) => ({
        experimentId: r.experiment_id,
        name: r.name,
        factor: r.factor,
        status: r.status,
      }));
  } catch {
    return [];
  }
}

function listActivePromptVersions(db, projectId) {
  try {
    return db
      .prepare(
        `SELECT version_id, role, version_label, status FROM prompt_versions
         WHERE project_id = ? AND status = 'active'`,
      )
      .all(projectId)
      .map((r) => ({
        versionId: r.version_id,
        role: r.role,
        versionLabel: r.version_label,
        status: r.status,
      }));
  } catch {
    return [];
  }
}
