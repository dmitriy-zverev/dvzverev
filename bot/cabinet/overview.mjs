import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getMeta, bumpDataVersion, withTransaction } from './db.mjs';
import {
  OPERATOR_STATUS,
  canRetryPublication,
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
import { redisConfigured, getRedis } from '../redis/client.mjs';
import { getTask } from '../redis/schedule.mjs';
import { encodeTask } from '../redis/codec.mjs';
import { taskKey } from '../redis/keys.mjs';
import { upsertPlanFromRedisTask } from '../redis/sqlite-bridge.mjs';
import { heartbeatPath, schedulerHeartbeatStatus } from '../health.mjs';
import { DELIVERY_SNAPSHOT } from './delivery-snapshot.mjs';
import { readReportOperatorState } from './reports/status.mjs';
import { loadServiceForCabinet } from './projects.mjs';
import { listRubrics } from './rubrics.mjs';

export async function buildOverview(
  db,
  { week, projectFilter, statusFilter, rubricFilter },
  env = process.env,
) {
  const snapshot = withTransaction(db, () =>
    readOverviewSnapshot(db, { week, projectFilter, statusFilter, rubricFilter }),
  );
  const service = await readServiceState(db, env);
  let reports = null;
  try {
    const { document } = await loadServiceForCabinet(env);
    reports = readReportOperatorState(db, document);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return {
    ...snapshot,
    service: reports ? { ...service, reports } : service,
  };
}

function readOverviewSnapshot(db, { week, projectFilter, statusFilter, rubricFilter }) {
  const timeZone = OPERATOR_TIMEZONE;
  const weekStart = week
    ? isoWeekStart(week, timeZone)
    : isoWeekStart(todayYmd(timeZone), timeZone);
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
      `${DELIVERY_SNAPSHOT}
       SELECT s.*, p.title AS project_title, e.aggregate_status, e.topic AS edition_topic,
              e.body_text, e.body_removed_at, e.content_expires_at, d.status AS delivery_status,
              d.external_id, d.platform, d.vk_group_id, w.status AS weekly_status,
              rs.rubric_id, rs.label AS rubric_label, rs.color AS rubric_color
       FROM schedule_slots s
       JOIN projects p ON p.project_id = s.project_id
       LEFT JOIN editions e ON e.edition_id = s.edition_id
       LEFT JOIN vk_weekly_posts w ON w.plan_id = s.plan_id
       LEFT JOIN rubric_slots rs ON rs.plan_id = s.plan_id
       LEFT JOIN current_deliveries d ON d.edition_id = s.edition_id AND d.destination_id = s.destination_id
       WHERE s.slot_utc >= ? AND s.slot_utc < ? AND COALESCE(rs.hidden,0)=0${projectClause}
       ORDER BY s.slot_utc ASC, s.project_id ASC`,
    )
    .all(...params);

  const adHocRows = loadAdHocRows(db, rangeStart, rangeEnd, projectFilter);
  let cards = [
    ...slots.map((row) => mapCard(row, timeZone)),
    ...adHocRows.map((row) => mapAdHocCard(row, timeZone)),
  ];
  cards.sort(
    (left, right) =>
      left.slotUtc.localeCompare(right.slotUtc) ||
      left.projectId.localeCompare(right.projectId) ||
      (left.destinationId || '').localeCompare(right.destinationId || ''),
  );
  if (statusFilter) cards = cards.filter((card) => matchesStatusFilter(card.status, statusFilter));
  if (rubricFilter)
    cards = cards.filter((card) =>
      rubricFilter === 'none' ? !card.rubricId : card.rubricId === rubricFilter,
    );

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
  if (rubricFilter) {
    deliveryProjectClause +=
      rubricFilter === 'none' ? ' AND rs.rubric_id IS NULL' : ' AND rs.rubric_id = ?';
    if (rubricFilter !== 'none') deliveryParams.push(rubricFilter);
  }
  const deliveries = db
    .prepare(
      `${DELIVERY_SNAPSHOT}
       SELECT d.status FROM current_deliveries d
       JOIN editions e ON e.edition_id = d.edition_id
       LEFT JOIN schedule_slots s ON s.edition_id = d.edition_id AND s.destination_id = d.destination_id
       LEFT JOIN rubric_slots rs ON rs.plan_id = s.plan_id
       WHERE COALESCE(s.slot_utc, d.sent_at, e.created_at) >= ?
         AND COALESCE(s.slot_utc, d.sent_at, e.created_at) < ? AND COALESCE(rs.hidden,0)=0 AND e.aggregate_status != 'cancelled'${deliveryProjectClause}`,
    )
    .all(...deliveryParams);
  for (const row of deliveries) {
    deliverySummary[summaryBucket(row.status)] += 1;
    deliverySummary.materials += 1;
  }

  return {
    week: { start: weekStart, end: addDaysYmd(weekStart, 6, timeZone), timezone: timeZone },
    projects,
    rubrics: listRubrics(db, projectFilter),
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
      `${DELIVERY_SNAPSHOT}
       SELECT e.*, p.title AS project_title, d.status AS delivery_status, d.external_id,
              d.platform, d.vk_group_id, d.destination_id, d.post_id, d.sent_at
       FROM editions e
       JOIN projects p ON p.project_id = e.project_id
       JOIN current_deliveries d ON d.edition_id = e.edition_id
       LEFT JOIN schedule_slots s ON s.edition_id = e.edition_id
       WHERE s.plan_id IS NULL
         AND e.aggregate_status != 'cancelled'
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
  if (isPayloadExpired(row)) contentPreview = 'содержимое удалено после 30 дней';
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
    weeklyStatus: row.weekly_status || null,
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
  const expired = isPayloadExpired(row);
  let contentPreview = null;
  if (expired) contentPreview = 'содержимое удалено после 30 дней';
  else if (row.body_text) contentPreview = row.body_text.slice(0, 160);
  const vkUrl = vkPostUrl(row);
  return {
    planId: row.plan_id,
    rubricId: row.rubric_id || null,
    rubricLabel: row.rubric_label || null,
    rubricColor: row.rubric_color || null,
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
    brief: expired ? null : row.brief,
    status,
    statusLabel: operator.label,
    statusIcon: operator.icon,
    contentPreview,
    vkUrl,
    version: row.version,
  };
}

function isPayloadExpired(row, now = new Date()) {
  if (row.body_removed_at) return true;
  if (row.content_expires_at && row.content_expires_at <= now.toISOString()) return true;
  return false;
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
  const plan = db
    .prepare('SELECT * FROM schedule_slots WHERE edition_id = ? LIMIT 1')
    .get(editionId);
  const primaryDelivery = deliveries[0];
  const release = plan ? null : classifyReleaseSource(edition.slot_key, primaryDelivery?.post_id);
  const expired = isPayloadExpired(edition);
  const detail = {
    edition: {
      id: edition.edition_id,
      projectId: edition.project_id,
      slotKey: edition.slot_key,
      format: edition.format,
      topic: edition.topic || plan?.topic || null,
      brief: expired ? null : edition.brief || plan?.brief || null,
      bodyText: expired ? null : edition.body_text,
      bodyNotice: expired ? 'содержимое удалено после 30 дней' : null,
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
  detail.retryable = canRetryPublication(detail);
  return detail;
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

export async function patchPlan(
  db,
  planId,
  { topic, brief, expectedVersion },
  actor = 'owner',
  env = process.env,
) {
  if (expectedVersion == null) return { error: 'version_required', status: 400 };

  const sqlitePlan = db
    .prepare('SELECT edition_id, plan_status FROM schedule_slots WHERE plan_id = ?')
    .get(planId);
  if (sqlitePlan?.edition_id) return { error: 'already_started', status: 409 };
  const weekly = db
    .prepare('SELECT status,post_json FROM vk_weekly_posts WHERE plan_id=?')
    .get(planId);
  if (weekly && (weekly.post_json || weekly.status === 'preparing' || weekly.status === 'posting'))
    return { error: 'already_started', status: 409 };

  if (redisConfigured(env)) {
    const redis = await getRedis(env);
    const task = await getTask(redis, planId);
    if (!task) return { error: 'not_found', status: 404 };
    if (!['planned', 'missed'].includes(task.status)) return { error: 'not_editable', status: 409 };
    const version = Number(expectedVersion);
    if (!Number.isFinite(version) || version !== task.version) {
      return { error: 'version_conflict', status: 409 };
    }
    const now = new Date().toISOString();
    const nextTopic = topic !== undefined ? String(topic).slice(0, 500) : task.topic;
    const nextBrief = brief !== undefined ? String(brief).slice(0, 4000) : task.brief;
    const nextTask = {
      ...task,
      topic: nextTopic,
      brief: nextBrief,
      version: task.version + 1,
    };
    const planPayload = {
      id: planId,
      topic: nextTopic,
      brief: nextBrief,
      topicState: nextTopic?.trim() ? 'manual' : 'unknown',
      version: nextTask.version,
    };
    const previousRaw = await redis.get(taskKey(planId));
    withTransaction(db, () => {
      upsertPlanFromRedisTask(db, nextTask, now);
      db.prepare(
        'INSERT INTO audit_log (audit_id, actor, action, plan_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        randomUUID(),
        actor,
        'patch_plan',
        planId,
        JSON.stringify({ topic: nextTopic, brief: nextBrief, source: 'redis' }),
        now,
      );
      bumpDataVersion(db);
    });
    try {
      await redis.set(taskKey(planId), encodeTask(nextTask));
    } catch (error) {
      if (previousRaw != null) {
        await redis.set(taskKey(planId), previousRaw);
      }
      throw error;
    }
    return { plan: planPayload, task: nextTask };
  }

  const plan = db.prepare('SELECT * FROM schedule_slots WHERE plan_id = ?').get(planId);
  if (!plan) return { error: 'not_found', status: 404 };
  if (plan.edition_id) return { error: 'already_started', status: 409 };
  if (!['planned', 'missed'].includes(plan.plan_status))
    return { error: 'not_editable', status: 409 };
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
