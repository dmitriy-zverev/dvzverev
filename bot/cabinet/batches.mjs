import { randomUUID } from 'node:crypto';
import { bumpDataVersion, withTransaction } from './db.mjs';
import {
  OPERATOR_TIMEZONE,
  TIME_PATTERN,
  addDaysYmd,
  formatDateYmd,
  localSlotToUtc,
  zonedParts,
} from './time.mjs';

const MATERIALIZE_DAYS_FORWARD = 14;
const MATERIALIZE_DAYS_BACK = 7;
const BATCH_PERIODS = ['morning', 'evening'];
const EMPTY_BATCH_ANCHOR = { morning: '09:55', evening: '17:55' };

const SLOT_ROWS_SQL = `SELECT s.plan_id, s.project_id, s.destination_id, s.slot_utc, s.edition_id, s.plan_status,
       d.delivery_id
FROM schedule_slots s
JOIN projects p ON p.project_id = s.project_id
LEFT JOIN (
  SELECT edition_id, destination_id, delivery_id,
    ROW_NUMBER() OVER (
      PARTITION BY edition_id, destination_id
      ORDER BY CASE WHEN failure_reason = 'generation_exhausted' THEN 1 ELSE 0 END,
               updated_at DESC, delivery_id ASC
    ) AS delivery_rank
  FROM deliveries
) d ON d.edition_id = s.edition_id AND d.destination_id = s.destination_id AND d.delivery_rank = 1
WHERE p.enabled = 1`;

export function resolveReportConfig(service) {
  const reports = service?.service?.reports || {};
  const eveningStartsAt = reports.eveningStartsAt || '16:00';
  if (!TIME_PATTERN.test(eveningStartsAt)) {
    throw new Error(`Invalid service.reports.eveningStartsAt: ${eveningStartsAt}`);
  }
  const batchDeadlineMinutes = Number(reports.batchDeadlineMinutes);
  const beforeReportLeadMinutes = Number(reports.beforeReportLeadMinutes);
  const mode = reports.mode || 'shadow';
  if (!['shadow', 'test', 'owner', 'off'].includes(mode)) {
    throw new Error(`Invalid service.reports.mode: ${mode}`);
  }
  return {
    timezone: reports.timezone || OPERATOR_TIMEZONE,
    eveningStartsAt,
    batchDeadlineMinutes: Number.isFinite(batchDeadlineMinutes) ? batchDeadlineMinutes : 45,
    beforeReportLeadMinutes: Number.isFinite(beforeReportLeadMinutes)
      ? beforeReportLeadMinutes
      : 5,
    reportEmptyBatches: reports.reportEmptyBatches !== false,
    mode,
    publicSiteUrl: (reports.publicSiteUrl || 'https://dvzverev.ru').replace(/\/$/, ''),
    testChatIdEnv: reports.testChatIdEnv || 'BOT_REPORT_TEST_CHAT_ID',
    alertChatIdEnv: reports.alertChatIdEnv || 'BOT_ALERT_CHAT_ID',
  };
}

export function eveningStartMinutes(eveningStartsAt) {
  const [hour, minute] = eveningStartsAt.split(':').map(Number);
  return hour * 60 + minute;
}

export function batchPeriodForLocalMinutes(localMinutes, eveningStartsAt) {
  return localMinutes >= eveningStartMinutes(eveningStartsAt) ? 'evening' : 'morning';
}

export function slotLocalContext(slotUtc, timeZone) {
  const parts = zonedParts(new Date(slotUtc), timeZone);
  const localDate = formatDateYmd({
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  });
  const localMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  return { localDate, localMinutes };
}

export function batchIdFor(localDate, period) {
  return `${localDate}:${period}`;
}

function addMinutesUtc(isoUtc, minutes) {
  return new Date(Date.parse(isoUtc) + minutes * 60_000).toISOString();
}

function distinctEditionCount(members) {
  const editionIds = new Set();
  let withoutEdition = 0;
  for (const member of members) {
    if (member.edition_id) editionIds.add(member.edition_id);
    else withoutEdition += 1;
  }
  return editionIds.size + withoutEdition;
}

function batchMemberKey(localDate, period) {
  return `${localDate}:${period}`;
}

export function buildBatchMemberIndex(db, service, reportConfig, timeZone) {
  const eveningStartsAt = reportConfig.eveningStartsAt;
  const rows = db.prepare(SLOT_ROWS_SQL).all();
  const index = new Map();
  for (const row of rows) {
    if (!service.projects?.[row.project_id]?.enabled) continue;
    if (row.plan_status === 'cancelled') continue;
    const { localDate, localMinutes } = slotLocalContext(row.slot_utc, timeZone);
    const period = batchPeriodForLocalMinutes(localMinutes, eveningStartsAt);
    const key = batchMemberKey(localDate, period);
    const bucket = index.get(key);
    if (bucket) bucket.push(row);
    else index.set(key, [row]);
  }
  for (const members of index.values()) {
    members.sort(
      (left, right) =>
        left.slot_utc.localeCompare(right.slot_utc) ||
        left.project_id.localeCompare(right.project_id) ||
        left.destination_id.localeCompare(right.destination_id),
    );
  }
  return index;
}

export function materializeBatches(db, service, now = new Date()) {
  const reportConfig = resolveReportConfig(service);
  const timeZone = reportConfig.timezone;
  const todayParts = zonedParts(now, timeZone);
  const todayYmd = formatDateYmd({
    year: Number(todayParts.year),
    month: Number(todayParts.month),
    day: Number(todayParts.day),
  });

  return withTransaction(db, () => {
    const memberIndex = buildBatchMemberIndex(db, service, reportConfig, timeZone);
    let changed = false;
    for (let offset = -MATERIALIZE_DAYS_BACK; offset < MATERIALIZE_DAYS_FORWARD; offset += 1) {
      const localDate = addDaysYmd(todayYmd, offset, timeZone);
      for (const period of BATCH_PERIODS) {
        const members = memberIndex.get(batchMemberKey(localDate, period)) || [];
        if (
          upsertBatchForDay(db, {
            localDate,
            period,
            reportConfig,
            timeZone,
            members,
            now,
          })
        ) {
          changed = true;
        }
      }
    }
    if (changed) bumpDataVersion(db);
    return changed;
  });
}

function upsertBatchForDay(db, { localDate, period, reportConfig, timeZone, members, now }) {
  const batchId = batchIdFor(localDate, period);
  const existing = db
    .prepare(
      `SELECT batch_id, first_slot_utc, last_slot_utc, before_at_utc, deadline_at_utc,
              expected_editions, expected_deliveries
       FROM batches WHERE batch_id = ?`,
    )
    .get(batchId);
  const slotUtcs = members.map((member) => member.slot_utc);
  const firstSlotUtc = slotUtcs[0] || null;
  const lastSlotUtc = slotUtcs[slotUtcs.length - 1] || null;
  const anchorTime = EMPTY_BATCH_ANCHOR[period];
  const beforeAtUtc = firstSlotUtc
    ? addMinutesUtc(firstSlotUtc, -reportConfig.beforeReportLeadMinutes)
    : localSlotToUtc(localDate, anchorTime, timeZone).toISOString();
  const deadlineAtUtc = lastSlotUtc
    ? addMinutesUtc(lastSlotUtc, reportConfig.batchDeadlineMinutes)
    : null;
  const expectedDeliveries = members.length;
  const expectedEditions = distinctEditionCount(members);
  const timestamp = now.toISOString();
  let changed = false;

  if (!existing) {
    if (!reportConfig.reportEmptyBatches && members.length === 0) return false;
    db.prepare(
      `INSERT INTO batches (
        batch_id, local_date, period, timezone, revision, first_slot_utc, last_slot_utc,
        before_at_utc, deadline_at_utc, expected_editions, expected_deliveries, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    ).run(
      batchId,
      localDate,
      period,
      timeZone,
      firstSlotUtc,
      lastSlotUtc,
      beforeAtUtc,
      deadlineAtUtc,
      expectedEditions,
      expectedDeliveries,
      timestamp,
      timestamp,
    );
    changed = true;
  } else if (
    existing.first_slot_utc !== firstSlotUtc ||
    existing.last_slot_utc !== lastSlotUtc ||
    existing.before_at_utc !== beforeAtUtc ||
    existing.deadline_at_utc !== deadlineAtUtc ||
    existing.expected_editions !== expectedEditions ||
    existing.expected_deliveries !== expectedDeliveries
  ) {
    db.prepare(
      `UPDATE batches SET
        first_slot_utc = ?, last_slot_utc = ?, before_at_utc = ?, deadline_at_utc = ?,
        expected_editions = ?, expected_deliveries = ?, updated_at = ?
       WHERE batch_id = ?`,
    ).run(
      firstSlotUtc,
      lastSlotUtc,
      beforeAtUtc,
      deadlineAtUtc,
      expectedEditions,
      expectedDeliveries,
      timestamp,
      batchId,
    );
    changed = true;
  }

  const memberDelta = syncBatchMembers(db, batchId, members, timestamp);
  if (memberDelta.changed) changed = true;
  if (maybeBumpBatchRevision(db, batchId, memberDelta, timestamp)) changed = true;
  return changed;
}

function maybeBumpBatchRevision(db, batchId, memberDelta, timestamp) {
  if (!memberDelta.added && !memberDelta.removed && !memberDelta.slotChanges) return false;
  const batch = db.prepare('SELECT before_locked_at FROM batches WHERE batch_id = ?').get(batchId);
  if (!batch?.before_locked_at) return false;
  db.prepare(
    `UPDATE batches SET
      revision = revision + 1,
      members_added = members_added + ?,
      members_removed = members_removed + ?,
      updated_at = ?
     WHERE batch_id = ?`,
  ).run(memberDelta.added, memberDelta.removed, timestamp, batchId);
  return true;
}

function syncBatchMembers(db, batchId, members, timestamp) {
  const existingRows = db
    .prepare(
      `SELECT member_id, plan_id, project_id, destination_id, slot_utc, edition_id, delivery_id, removed_at
       FROM batch_members WHERE batch_id = ?`,
    )
    .all(batchId);
  const incomingPlanIds = new Set(members.map((member) => member.plan_id));
  let changed = false;
  let added = 0;
  let removed = 0;
  let slotChanges = 0;

  for (const member of members) {
    const current = existingRows.find((row) => row.plan_id === member.plan_id);
    if (current) {
      if (current.slot_utc !== member.slot_utc) slotChanges += 1;
      const needsUpdate =
        current.project_id !== member.project_id ||
        current.destination_id !== member.destination_id ||
        current.slot_utc !== member.slot_utc ||
        current.edition_id !== member.edition_id ||
        current.delivery_id !== member.delivery_id ||
        current.removed_at !== null;
      if (needsUpdate) {
        db.prepare(
          `UPDATE batch_members SET
            project_id = ?, destination_id = ?, slot_utc = ?, edition_id = ?, delivery_id = ?,
            removed_at = NULL, updated_at = ?
           WHERE member_id = ?`,
        ).run(
          member.project_id,
          member.destination_id,
          member.slot_utc,
          member.edition_id,
          member.delivery_id,
          timestamp,
          current.member_id,
        );
        changed = true;
      }
      continue;
    }
    db.prepare(
      `INSERT INTO batch_members (
        member_id, batch_id, plan_id, project_id, destination_id, slot_utc, edition_id,
        delivery_id, added_revision, removed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
    ).run(
      randomUUID(),
      batchId,
      member.plan_id,
      member.project_id,
      member.destination_id,
      member.slot_utc,
      member.edition_id,
      member.delivery_id,
      timestamp,
      timestamp,
    );
    changed = true;
    added += 1;
  }

  for (const row of existingRows) {
    if (incomingPlanIds.has(row.plan_id)) continue;
    if (row.edition_id) {
      const result = db
        .prepare(
          'UPDATE batch_members SET removed_at = ?, updated_at = ? WHERE member_id = ? AND removed_at IS NULL',
        )
        .run(timestamp, timestamp, row.member_id);
      if (result.changes > 0) {
        changed = true;
        removed += 1;
      }
      continue;
    }
    const result = db.prepare('DELETE FROM batch_members WHERE member_id = ?').run(row.member_id);
    if (result.changes > 0) {
      changed = true;
      removed += 1;
    }
  }
  return { changed, added, removed, slotChanges };
}

export function getBatch(db, localDate, period) {
  const batchId = batchIdFor(localDate, period);
  const batch = db.prepare('SELECT * FROM batches WHERE batch_id = ?').get(batchId);
  if (!batch) return null;
  const members = db
    .prepare(
      `SELECT m.*, p.title AS project_title
       FROM batch_members m
       JOIN projects p ON p.project_id = m.project_id
       WHERE m.batch_id = ? AND m.removed_at IS NULL
       ORDER BY m.slot_utc ASC, m.project_id ASC`,
    )
    .all(batchId);
  return { batch: mapBatch(batch), members: members.map(mapMember) };
}

function mapBatch(row) {
  return {
    id: row.batch_id,
    localDate: row.local_date,
    period: row.period,
    timezone: row.timezone,
    revision: row.revision,
    beforeLockedAt: row.before_locked_at,
    baselineEditions: row.baseline_editions,
    baselineDeliveries: row.baseline_deliveries,
    membersAdded: row.members_added,
    membersRemoved: row.members_removed,
    lifecycle: row.lifecycle,
    firstSlotUtc: row.first_slot_utc,
    lastSlotUtc: row.last_slot_utc,
    beforeAtUtc: row.before_at_utc,
    deadlineAtUtc: row.deadline_at_utc,
    expectedEditions: row.expected_editions,
    expectedDeliveries: row.expected_deliveries,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

function mapMember(row) {
  return {
    id: row.member_id,
    planId: row.plan_id,
    projectId: row.project_id,
    projectTitle: row.project_title,
    destinationId: row.destination_id,
    slotUtc: row.slot_utc,
    editionId: row.edition_id,
    deliveryId: row.delivery_id,
    addedRevision: row.added_revision,
  };
}
