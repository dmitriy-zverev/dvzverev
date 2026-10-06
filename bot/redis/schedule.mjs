import { randomUUID } from 'node:crypto';
import { decodeTask, encodeTask } from './codec.mjs';
import {
  DUE_ZSET,
  META_MATERIALIZED,
  META_WEEK,
  lockKey,
  occupancyKey,
  slotUtcMs,
  taskKey,
  weekIndexKey,
} from './keys.mjs';
import { publicationKind } from '../cabinet/status.mjs';
import {
  addDaysYmd,
  formatDateYmd,
  isoWeekStart,
  localSlotToUtc,
  scheduledTimesForDay,
  slotKey,
  weekDates,
  zonedParts,
  OPERATOR_TIMEZONE,
} from '../cabinet/time.mjs';

const SLOT_WINDOW_MS = 5 * 60 * 1000;
const MIN_ADHOC_GAP_MS = 60 * 60 * 1000;
const LOCK_TTL_SEC = 900;

export function currentWeekStartYmd(now = new Date(), timeZone = OPERATOR_TIMEZONE) {
  const parts = zonedParts(now, timeZone);
  const todayYmd = formatDateYmd({
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  });
  return isoWeekStart(todayYmd, timeZone);
}

export function weekUtcBounds(weekStartYmd, timeZone = OPERATOR_TIMEZONE) {
  const start = localSlotToUtc(weekStartYmd, '00:00', timeZone);
  const endYmd = addDaysYmd(weekStartYmd, 7, timeZone);
  const end = localSlotToUtc(endYmd, '00:00', timeZone);
  return { startMs: start.getTime(), endMs: end.getTime(), endYmd };
}

function buildTaskRecord({
  projectId,
  destinationId,
  dateYmd,
  time,
  timezone,
  destination,
  weekStart,
  now,
  existing,
  adHoc = false,
}) {
  const key = slotKey(dateYmd, time, timezone);
  const slotUtc = localSlotToUtc(dateYmd, time, timezone).toISOString();
  const publication = publicationKind(
    { mediaTimes: destination.media?.times, coverMode: destination.media?.kind },
    key,
    destination,
  );
  const slotAgeMs = now.getTime() - Date.parse(slotUtc);
  let status = 'planned';
  if (
    slotAgeMs > SLOT_WINDOW_MS &&
    !existing?.editionId &&
    (existing?.missedSlotsPolicy || 'skip') === 'skip'
  ) {
    status = 'missed';
  } else if (existing?.status === 'missed' && slotAgeMs <= SLOT_WINDOW_MS) {
    status = 'planned';
  } else if (existing?.status) {
    status = existing.status;
  }

  return {
    id: existing?.id || randomUUID(),
    projectId,
    destinationId,
    slotUtc,
    slotKey: key,
    topic: existing?.topic ?? null,
    brief: existing?.brief ?? null,
    version: existing?.version ?? 1,
    status,
    publicationKind: publication.kind,
    expectedMedia: publication.media,
    adHoc,
    weekStart,
  };
}

async function removeTask(redis, task) {
  const ms = slotUtcMs(task.slotUtc);
  await redis.del(taskKey(task.id));
  await redis.zRem(DUE_ZSET, task.id);
  await redis.del(occupancyKey(task.projectId, task.destinationId, ms));
  await redis.sRem(weekIndexKey(task.weekStart), task.id);
}

async function saveTask(redis, task, { reserveOccupancy = false } = {}) {
  const ms = slotUtcMs(task.slotUtc);
  const encoded = encodeTask(task);
  const occ = occupancyKey(task.projectId, task.destinationId, ms);
  if (reserveOccupancy) {
    const reserved = await redis.set(occ, task.id, { NX: true });
    if (!reserved) return false;
  } else {
    await redis.set(occ, task.id);
  }
  try {
    await redis.set(taskKey(task.id), encoded);
    await redis.zAdd(DUE_ZSET, { score: ms, value: task.id });
    await redis.sAdd(weekIndexKey(task.weekStart), task.id);
    return true;
  } catch (error) {
    await redis.del(taskKey(task.id));
    await redis.zRem(DUE_ZSET, task.id);
    await redis.sRem(weekIndexKey(task.weekStart), task.id);
    await redis.del(occ);
    throw error;
  }
}

export async function getTask(redis, taskId) {
  return decodeTask(await redis.get(taskKey(taskId)));
}

export async function clearWeek(redis, weekStartYmd) {
  if (!weekStartYmd) return;
  const ids = await redis.sMembers(weekIndexKey(weekStartYmd));
  for (const id of ids) {
    const task = await getTask(redis, id);
    if (task) await removeTask(redis, task);
  }
  await redis.del(weekIndexKey(weekStartYmd));
}

export async function materializeWeek(redis, service, weekStartYmd, now = new Date(), seed = new Map()) {
  const timeZone = OPERATOR_TIMEZONE;
  const dates = weekDates(weekStartYmd, timeZone);
  let inserted = 0;

  for (const [projectId, project] of Object.entries(service.projects || {})) {
    if (!project.enabled) continue;
    const timezone = project.schedule?.timezone || timeZone;
    const missedSlotsPolicy = project.schedule?.missedSlots || 'skip';
    for (const dateYmd of dates) {
      const times = scheduledTimesForDay(project.schedule, dateYmd, timezone);
      for (const destinationId of project.delivery?.destinations || []) {
        const destination = service.destinations?.[destinationId];
        if (!destination) continue;
        for (const time of times) {
          const slotUtc = localSlotToUtc(dateYmd, time, timezone).toISOString();
          const seedKey = `${projectId}:${destinationId}:${slotUtc}`;
          const existingSeed = seed.get(seedKey);
          const task = buildTaskRecord({
            projectId,
            destinationId,
            dateYmd,
            time,
            timezone,
            destination,
            weekStart: weekStartYmd,
            now,
            existing: existingSeed
              ? {
                  id: existingSeed.plan_id,
                  topic: existingSeed.topic,
                  brief: existingSeed.brief,
                  version: existingSeed.version,
                  status: existingSeed.plan_status,
                  editionId: existingSeed.edition_id,
                  missedSlotsPolicy,
                }
              : { missedSlotsPolicy },
            adHoc: false,
          });
          if (existingSeed?.edition_id) continue;
          await saveTask(redis, task);
          inserted += 1;
        }
      }
    }
  }

  await redis.set(META_WEEK, weekStartYmd);
  await redis.set(META_MATERIALIZED, now.toISOString());
  return { weekStartYmd, inserted };
}

export function seedMapFromRows(rows) {
  const seed = new Map();
  for (const row of rows) {
    seed.set(`${row.project_id}:${row.destination_id}:${row.slot_utc}`, row);
  }
  return seed;
}

export async function ensureCurrentWeek(redis, service, { now = new Date(), seedRows = [] } = {}) {
  const weekStart = currentWeekStartYmd(now);
  const storedWeek = await redis.get(META_WEEK);
  if (storedWeek === weekStart) {
    return { weekStartYmd: weekStart, rolled: false, inserted: 0 };
  }
  if (storedWeek) {
    await clearWeek(redis, storedWeek);
  }
  const seed = seedMapFromRows(seedRows);
  const result = await materializeWeek(redis, service, weekStart, now, seed);
  return { ...result, rolled: Boolean(storedWeek && storedWeek !== weekStart) };
}

export async function updateTaskEditorial(redis, taskId, { topic, brief, expectedVersion }) {
  if (expectedVersion == null) return { error: 'version_required', status: 400 };
  const task = await getTask(redis, taskId);
  if (!task) return { error: 'not_found', status: 404 };
  if (!['planned', 'missed'].includes(task.status)) return { error: 'not_editable', status: 409 };
  const version = Number(expectedVersion);
  if (!Number.isFinite(version) || version !== task.version) {
    return { error: 'version_conflict', status: 409 };
  }
  const nextTopic = topic !== undefined ? String(topic).slice(0, 500) : task.topic;
  const nextBrief = brief !== undefined ? String(brief).slice(0, 4000) : task.brief;
  task.topic = nextTopic;
  task.brief = nextBrief;
  task.version = task.version + 1;
  await redis.set(taskKey(task.id), encodeTask(task));
  return {
    plan: {
      id: task.id,
      topic: nextTopic,
      brief: nextBrief,
      topicState: nextTopic?.trim() ? 'manual' : 'unknown',
      version: task.version,
    },
    task,
  };
}

async function isOccupied(redis, projectId, destinationId, slotUtcIso, ignoreTaskId = null) {
  const ms = slotUtcMs(slotUtcIso);
  const holder = await redis.get(occupancyKey(projectId, destinationId, ms));
  if (!holder) return false;
  if (ignoreTaskId && holder === ignoreTaskId) return false;
  return true;
}

export async function findNextFreeSlotUtc(
  redis,
  projectId,
  destinationId,
  fromUtcIso,
  { minGapMs = MIN_ADHOC_GAP_MS, maxAttempts = 168 } = {},
) {
  let cursor = Date.parse(fromUtcIso);
  if (!Number.isFinite(cursor)) throw new Error('invalid_from_utc');
  cursor += minGapMs;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = new Date(cursor).toISOString();
    const occupied = await isOccupied(redis, projectId, destinationId, candidate);
    if (!occupied) return candidate;
    cursor += minGapMs;
  }
  return null;
}

export async function createAdHocTask(
  redis,
  service,
  { projectId, destinationId, slotUtc, topic, brief },
  now = new Date(),
) {
  const project = service.projects?.[projectId];
  const destination = service.destinations?.[destinationId];
  if (!project?.enabled || !destination) return { error: 'not_found', status: 404 };
  if (!project.delivery?.destinations?.includes(destinationId)) {
    return { error: 'invalid_destination', status: 400 };
  }
  const weekStart = currentWeekStartYmd(now);
  const { startMs, endMs } = weekUtcBounds(weekStart);
  const slotMs = slotUtcMs(slotUtc);
  if (slotMs < startMs || slotMs >= endMs) {
    return { error: 'outside_current_week', status: 400 };
  }
  if (await isOccupied(redis, projectId, destinationId, slotUtc)) {
    const suggested = await findNextFreeSlotUtc(redis, projectId, destinationId, slotUtc);
    return {
      error: 'slot_conflict',
      status: 409,
      suggestedSlotUtc: suggested,
    };
  }
  const timezone = project.schedule?.timezone || OPERATOR_TIMEZONE;
  const parts = zonedParts(new Date(slotMs), timezone);
  const dateYmd = formatDateYmd({
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  });
  const time = `${parts.hour}:${parts.minute}`;
  const task = buildTaskRecord({
    projectId,
    destinationId,
    dateYmd,
    time,
    timezone,
    destination,
    weekStart,
    now,
    existing: {
      topic,
      brief,
      version: 1,
      status: 'planned',
      missedSlotsPolicy: 'skip',
    },
    adHoc: true,
  });
  task.topic = topic !== undefined ? String(topic).slice(0, 500) : null;
  task.brief = brief !== undefined ? String(brief).slice(0, 4000) : null;
  const saved = await saveTask(redis, task, { reserveOccupancy: true });
  if (!saved) {
    const suggested = await findNextFreeSlotUtc(redis, projectId, destinationId, slotUtc);
    return {
      error: 'slot_conflict',
      status: 409,
      suggestedSlotUtc: suggested,
    };
  }
  return { task };
}

export async function discardTask(redis, taskId) {
  const task = await getTask(redis, taskId);
  if (task) await removeTask(redis, task);
}

export async function claimDueTasks(redis, now = new Date(), { projectId = null, limit = 4 } = {}) {
  const nowMs = now.getTime();
  const ids = await redis.zRangeByScore(DUE_ZSET, 0, nowMs, { LIMIT: { offset: 0, count: limit * 3 } });
  const claimed = [];
  for (const id of ids) {
    if (claimed.length >= limit) break;
    const locked = await redis.set(lockKey(id), '1', { NX: true, EX: LOCK_TTL_SEC });
    if (!locked) continue;
    const task = await getTask(redis, id);
    if (!task || task.status !== 'planned') {
      await redis.del(lockKey(id));
      continue;
    }
    if (projectId && task.projectId !== projectId) {
      await redis.del(lockKey(id));
      continue;
    }
    const slotMs = slotUtcMs(task.slotUtc);
    const ageMs = nowMs - slotMs;
    if (ageMs < 0 || ageMs >= SLOT_WINDOW_MS) {
      await redis.del(lockKey(id));
      continue;
    }
    claimed.push(task);
  }
  return claimed;
}

export async function releaseTaskLock(redis, taskId) {
  await redis.del(lockKey(taskId));
}

export async function markTaskStatus(redis, taskId, status) {
  const task = await getTask(redis, taskId);
  if (!task) return null;
  task.status = status;
  await redis.set(taskKey(task.id), encodeTask(task));
  if (status !== 'planned') {
    await redis.zRem(DUE_ZSET, task.id);
  }
  return task;
}
