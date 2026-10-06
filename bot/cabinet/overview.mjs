import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getMeta, bumpDataVersion, withTransaction } from './db.mjs';
import {
  OPERATOR_STATUS,
  summaryBucket,
  destinationTitle,
  matchesStatusFilter,
  classifyReleaseSource,
} from './status.mjs';
import {
  OPERATOR_TIMEZONE,
  addDaysYmd,
  isoWeekStart,
  localSlotToUtc,
  operatorLabel,
  weekDates,
} from './time.mjs';
import { heartbeatPath, schedulerHeartbeatStatus } from '../health.mjs';

export async function buildOverview(db, { week, projectFilter, statusFilter }, env = process.env) {
  const snapshot = withTransaction(db, () =>
    readOverviewSnapshot(db, { week, projectFilter, statusFilter }),
  );
  const service = await readServiceState(db, env);
  return { ...snapshot, service };
}

function readOverviewSnapshot(db, { week, projectFilter, statusFilter }) {
  const timeZone = OPERATOR_TIMEZONE;
  const weekStart = week ? isoWeekStart(week, timeZone) : isoWeekStart(todayYmd(timeZone), timeZone);
  const weekEnd = addDaysYmd(weekStart, 7, timeZone);
  const rangeStart = localSlotToUtc(weekStart, '00:00', timeZone).toISOString();
  const rangeEnd = localSlotToUtc(weekEnd, '00:00', timeZone).toISOString();

  const projects = db
    .prepare('SELECT project_id, title, enabled FROM projects ORDER BY project_id')
    .all()
    .map((row) => ({
      id: row.project_id,
      title: row.title,
      enabled: row.enabled === 1,
    }));

  const params = [rangeStart, rangeEnd];
  let projectClause = '';
  if (projectFilter) {
    projectClause = ' AND s.project_id = ?';
    params.push(projectFilter);
  }

  const slots = db
    .prepare(
      `SELECT s.*, p.title AS project_title, e.aggregate_status, e.topic AS edition_topic,
              e.body_text, e.body_removed_at, d.status AS delivery_status, d.external_id,
              d.platform, d.vk_group_id
       FROM schedule_slots s
       JOIN projects p ON p.project_id = s.project_id
       LEFT JOIN editions e ON e.edition_id = s.edition_id
       LEFT JOIN deliveries d ON d.edition_id = s.edition_id AND d.destination_id = s.destination_id
       WHERE s.slot_utc >= ? AND s.slot_utc < ?${projectClause}
       ORDER BY s.slot_utc ASC, s.project_id ASC`,
    )
    .all(...params);

  const adHocRows = loadAdHocRows(db, rangeStart, rangeEnd, projectFilter);
  let cards = [...slots.map((row) => mapCard(row, timeZone)), ...adHocRows.map((row) => mapAdHocCard(row, timeZone))];
  cards.sort(
    (left, right) =>
      left.slotUtc.localeCompare(right.slotUtc) ||
      left.projectId.localeCompare(right.projectId) ||
      (left.destinationId || '').localeCompare(right.destinationId || ''),
  );
  if (statusFilter) cards = cards.filter((card) => matchesStatusFilter(card.status, statusFilter));

  const summary = emptySummary();
  for (const card of cards) {
    summary[summaryBucket(card.status)] += 1;
    summary.materials += 1;
  }

  const deliverySummary = emptySummary();
  deliverySummary.materials = 0;
  const deliveryParams = [rangeStart, rangeEnd];
  let deliveryProjectClause = '';
  if (projectFilter) {
    deliveryProjectClause = ' AND d.project_id = ?';
    deliveryParams.push(projectFilter);
  }
  const deliveries = db
    .prepare(
      `SELECT d.status FROM deliveries d
       JOIN editions e ON e.edition_id = d.edition_id
       LEFT JOIN schedule_slots s ON s.edition_id = d.edition_id AND s.destination_id = d.destination_id
       WHERE COALESCE(s.slot_utc, d.sent_at, e.created_at) >= ?
         AND COALESCE(s.slot_utc, d.sent_at, e.created_at) < ?${deliveryProjectClause}`,
    )
    .all(...deliveryParams);
  for (const row of deliveries) {
    deliverySummary[summaryBucket(row.status)] += 1;
    deliverySummary.materials += 1;
  }

  return {
    week: { start: weekStart, end: addDaysYmd(weekStart, 6, timeZone), timezone: timeZone },
    projects,
    summary,
    deliverySummary,
    days: weekDates(weekStart, timeZone).map((date) => ({
      date,
      cards: cards.filter((card) => card.date === date),
    })),
    cards,
    as_of: getMeta(db, 'as_of'),
    data_version: Number(getMeta(db, 'data_version', '0')),
    scheduler_last_seen_at: getMeta(db, 'scheduler_last_seen_at'),
  };
}

function loadAdHocRows(db, rangeStart, rangeEnd, projectFilter) {
  const params = [rangeStart, rangeEnd];
  let projectClause = '';
  if (projectFilter) {
    projectClause = ' AND e.project_id = ?';
    params.push(projectFilter);
  }
  return db
    .prepare(
      `SELECT e.*, p.title AS project_title, d.status AS delivery_status, d.external_id,
              d.platform, d.vk_group_id, d.destination_id, d.post_id, d.sent_at
       FROM editions e
       JOIN projects p ON p.project_id = e.project_id
       JOIN deliveries d ON d.edition_id = e.edition_id
       LEFT JOIN schedule_slots s ON s.edition_id = e.edition_id
       WHERE s.plan_id IS NULL
         AND COALESCE(d.sent_at, e.created_at) >= ?
         AND COALESCE(d.sent_at, e.created_at) < ?${projectClause}
       ORDER BY COALESCE(d.sent_at, e.created_at) ASC, e.project_id ASC`,
    )
    .all(...params);
}

function mapAdHocCard(row, timeZone) {
  const eventInstant = row.sent_at || row.created_at;
  const slotDate = new Date(eventInstant);
  const { date, time } = operatorDateParts(slotDate, timeZone);
  const status = row.aggregate_status ?? row.delivery_status;
  const operator = OPERATOR_STATUS[status] || OPERATOR_STATUS.planned;
  const topic = row.topic;
  let contentPreview = null;
  if (row.body_removed_at) contentPreview = 'содержимое удалено после 30 дней';
  else if (row.body_text) contentPreview = row.body_text.slice(0, 160);
  const release = classifyReleaseSource(row.slot_key, row.post_id);
  const vkUrl = vkPostUrl(row);
  return {
    planId: null,
    editionId: row.edition_id,
    projectId: row.project_id,
    projectTitle: row.project_title,
    destinationId: row.destination_id,
    destinationTitle: destinationTitle(row.destination_id),
    date,
    time,
    slotUtc: slotDate.toISOString(),
    slotLabel: operatorLabel(slotDate, timeZone),
    publicationKind: 'text',
    expectedMedia: null,
    topic: topic || null,
    topicLabel: topic || release.label,
    topicState: topic ? 'known' : 'unknown',
    brief: null,
    status,
    statusLabel: operator.label,
    statusIcon: operator.icon,
    contentPreview,
    vkUrl,
    version: null,
    adHoc: true,
    releaseSource: release.source,
    releaseLabel: release.label,
  };
}

function operatorDateParts(slotDate, timeZone) {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(slotDate);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(slotDate)
      .map(({ type, value }) => [type, value]),
  );
  const time = `${parts.hour}:${parts.minute}`;
  return { date, time };
}

function mapCard(row, timeZone) {
  const slotDate = new Date(row.slot_utc);
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(slotDate);
  const time = row.slot_key.match(/@(\d{2}:\d{2})\[/)?.[1] || '00:00';
  const status = row.aggregate_status ?? row.plan_status;
  const operator = OPERATOR_STATUS[status] || OPERATOR_STATUS.planned;
  const topic = row.topic || row.edition_topic;
  let contentPreview = null;
  if (row.body_removed_at) contentPreview = 'содержимое удалено после 30 дней';
  else if (row.body_text) contentPreview = row.body_text.slice(0, 160);
  const vkUrl = vkPostUrl(row);
  return {
    planId: row.plan_id,
    editionId: row.edition_id,
    projectId: row.project_id,
    projectTitle: row.project_title,
    destinationId: row.destination_id,
    destinationTitle: destinationTitle(row.destination_id),
    date,
    time,
    slotUtc: row.slot_utc,
    slotLabel: operatorLabel(slotDate, timeZone),
    publicationKind: row.publication_kind,
    expectedMedia: row.expected_media,
    topic: topic || null,
    topicLabel: topic || 'тема ещё не выбрана',
    topicState: topic ? 'known' : row.topic_state,
    brief: row.brief,
    status,
    statusLabel: operator.label,
    statusIcon: operator.icon,
    contentPreview,
    vkUrl,
    version: row.version,
  };
}

function vkPostUrl(row) {
  if (row.platform !== 'vk' || row.delivery_status !== 'sent' || !row.external_id) return null;
  if (!row.vk_group_id) return null;
  return `https://vk.com/wall-${row.vk_group_id}_${row.external_id}`;
}

function emptySummary() {
  return {
    materials: 0,
    planned: 0,
    readying: 0,
    sent: 0,
    delayed: 0,
    failed: 0,
    uncertain: 0,
    missed: 0,
  };
}

function todayYmd(timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date())
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function readServiceState(db, env) {
  let heartbeat = { ok: false, updatedAt: null, ageSeconds: null };
  try {
    const raw = JSON.parse(await readFile(heartbeatPath(env), 'utf8'));
    heartbeat = { ...heartbeat, ...schedulerHeartbeatStatus(raw) };
  } catch {
    heartbeat.ok = false;
  }
  return {
    heartbeat,
    pauses: JSON.parse(getMeta(db, 'scheduler_pauses_json') || '{}'),
    cooldowns: JSON.parse(getMeta(db, 'scheduler_cooldowns_json') || '[]'),
    stale: !heartbeat.ok || (heartbeat.ageSeconds != null && heartbeat.ageSeconds > 120),
  };
}

export function getEdition(db, editionId) {
  const edition = db.prepare('SELECT * FROM editions WHERE edition_id = ?').get(editionId);
  if (!edition) return null;
  const deliveries = db
    .prepare('SELECT * FROM deliveries WHERE edition_id = ? ORDER BY platform')
    .all(editionId);
  const events = db
    .prepare('SELECT * FROM events WHERE edition_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(editionId);
  const plan = db.prepare('SELECT * FROM schedule_slots WHERE edition_id = ? LIMIT 1').get(editionId);
  const primaryDelivery = deliveries[0];
  const release = plan ? null : classifyReleaseSource(edition.slot_key, primaryDelivery?.post_id);
  return {
    edition: {
      id: edition.edition_id,
      projectId: edition.project_id,
      slotKey: edition.slot_key,
      format: edition.format,
      topic: edition.topic || plan?.topic || null,
      brief: edition.brief || plan?.brief || null,
      bodyText: edition.body_removed_at ? null : edition.body_text,
      bodyNotice: edition.body_removed_at ? 'содержимое удалено после 30 дней' : null,
      promptVersion: edition.prompt_version,
      models: edition.models_json ? JSON.parse(edition.models_json) : null,
      costUsd: edition.cost_usd,
      status: edition.aggregate_status,
      statusLabel: (OPERATOR_STATUS[edition.aggregate_status] || OPERATOR_STATUS.planned).label,
    },
    deliveries: deliveries.map((row) => ({
      id: row.delivery_id,
      destinationId: row.destination_id,
      platform: row.platform,
      status: row.status,
      statusLabel: (OPERATOR_STATUS[row.status] || OPERATOR_STATUS.planned).label,
      externalId: row.external_id,
      vkUrl: vkPostUrl(row),
      retryAt: row.retry_at,
      failureReason: row.failure_reason,
      attempts: row.attempts,
      sentAt: row.sent_at,
    })),
    plan: plan
      ? {
          id: plan.plan_id,
          publicationKind: plan.publication_kind,
          expectedMedia: plan.expected_media,
          version: plan.version,
        }
      : null,
    adHoc: !plan,
    releaseSource: release?.source ?? null,
    releaseLabel: release?.label ?? null,
    events: events.map((row) => ({
      id: row.event_id,
      stage: row.stage,
      code: row.code,
      message: row.message,
      attempt: row.attempt,
      createdAt: row.created_at,
    })),
  };
}

export function listIncidents(db, { project, status = 'open', cursor = 0, limit = 30 }) {
  const params = [];
  let where = 'WHERE 1=1';
  if (project) {
    where += ' AND project_id = ?';
    params.push(project);
  }
  if (status) {
    where += ' AND status = ?';
    params.push(status);
  }
  params.push(limit, cursor);
  const rows = db
    .prepare(`SELECT * FROM incidents ${where} ORDER BY last_seen_at DESC LIMIT ? OFFSET ?`)
    .all(...params);
  return {
    items: rows.map((row) => ({
      id: row.incident_id,
      projectId: row.project_id,
      stage: row.stage,
      code: row.code,
      message: row.message,
      status: row.status,
      count: row.count,
      editionId: row.edition_id,
      destinationId: row.destination_id,
      recovery: row.recovery,
      nextRetryAt: row.next_retry_at,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    })),
    nextCursor: rows.length === limit ? cursor + limit : null,
  };
}

export function listProjects(db) {
  return db
    .prepare(
      'SELECT project_id, title, enabled, timezone, schedule_json, destinations_json FROM projects',
    )
    .all()
    .map((row) => ({
      id: row.project_id,
      title: row.title,
      enabled: row.enabled === 1,
      timezone: row.timezone,
      schedule: JSON.parse(row.schedule_json),
      destinations: JSON.parse(row.destinations_json),
    }));
}

export function patchPlan(db, planId, { topic, brief, expectedVersion }, actor = 'owner') {
  const plan = db.prepare('SELECT * FROM schedule_slots WHERE plan_id = ?').get(planId);
  if (!plan) return { error: 'not_found', status: 404 };
  if (plan.edition_id) return { error: 'already_started', status: 409 };
  if (!['planned', 'missed'].includes(plan.plan_status))
    return { error: 'not_editable', status: 409 };
  if (expectedVersion == null) return { error: 'version_required', status: 400 };
  const version = Number(expectedVersion);
  if (!Number.isFinite(version) || version !== plan.version)
    return { error: 'version_conflict', status: 409 };

  const now = new Date().toISOString();
  const nextTopic = topic !== undefined ? String(topic).slice(0, 500) : plan.topic;
  const nextBrief = brief !== undefined ? String(brief).slice(0, 4000) : plan.brief;
  const topicState = nextTopic?.trim() ? 'manual' : 'unknown';
  const updated = db
    .prepare(
      `UPDATE schedule_slots SET topic = ?, brief = ?, topic_state = ?, version = version + 1, updated_at = ?
       WHERE plan_id = ? AND edition_id IS NULL AND plan_status IN ('planned', 'missed') AND version = ?`,
    )
    .run(nextTopic, nextBrief, topicState, now, planId, version);
  if (updated.changes !== 1) return { error: 'version_conflict', status: 409 };

  db.prepare(
    'INSERT INTO audit_log (audit_id, actor, action, plan_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    randomUUID(),
    actor,
    'patch_plan',
    planId,
    JSON.stringify({ topic: nextTopic, brief: nextBrief }),
    now,
  );
  bumpDataVersion(db);

  return {
    plan: {
      id: planId,
      topic: nextTopic,
      brief: nextBrief,
      topicState,
      version: plan.version + 1,
      updatedAt: now,
    },
  };
}
