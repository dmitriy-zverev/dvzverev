import { DELIVERY_SNAPSHOT } from '../delivery-snapshot.mjs';
import { getBatch } from '../batches.mjs';
import {
  destinationTitle,
  isTerminalDeliveryStatus,
  projectTitle,
  summaryBucket,
} from '../status.mjs';
import { getMeta } from '../db.mjs';
import { operatorLabel } from '../time.mjs';

const MEMBER_ROWS_SQL = `${DELIVERY_SNAPSHOT}
SELECT m.member_id, m.plan_id, m.project_id, m.destination_id, m.slot_utc, m.edition_id,
       s.plan_status, s.publication_kind, s.expected_media, s.topic, s.brief, s.topic_state,
       e.aggregate_status, e.topic AS edition_topic, e.cost_usd,
       d.status AS delivery_status, d.retry_at, d.failure_reason, d.sent_at, d.external_id,
       d.platform, d.vk_group_id
FROM batch_members m
JOIN schedule_slots s ON s.plan_id = m.plan_id
LEFT JOIN editions e ON e.edition_id = m.edition_id
LEFT JOIN current_deliveries d ON d.edition_id = m.edition_id AND d.destination_id = m.destination_id
WHERE m.batch_id = ? AND m.removed_at IS NULL
ORDER BY m.slot_utc ASC, m.project_id ASC`;

export function readBatchReportSnapshot(db, localDate, period, timeZone) {
  const wrapped = getBatch(db, localDate, period);
  if (!wrapped) return null;
  const batch = wrapped.batch;
  const rows = db.prepare(MEMBER_ROWS_SQL).all(batch.id);
  const members = rows.map((row) => mapMemberRow(row, timeZone));
  const deliverySummary = emptySummary();
  const materialSummary = emptySummary();
  const editionIds = new Set();
  for (const member of members) {
    editionIds.add(member.editionId || member.planId);
    deliverySummary[summaryBucket(member.deliveryStatus)] += 1;
    deliverySummary.materials += 1;
    materialSummary[summaryBucket(member.materialStatus)] += 1;
    materialSummary.materials += 1;
  }
  const progress = summarizeProgress(members);
  return {
    batch,
    members,
    deliverySummary,
    materialSummary,
    progress,
    asOf: getMeta(db, 'as_of'),
    dataVersion: Number(getMeta(db, 'data_version', '0')),
  };
}

function mapMemberRow(row, timeZone) {
  const slotDate = new Date(row.slot_utc);
  const time = row.slot_utc && slotDate.toISOString() === row.slot_utc
    ? formatLocalTime(slotDate, timeZone)
    : '00:00';
  const topic = row.topic || row.edition_topic;
  const deliveryStatus = row.delivery_status || planDeliveryStatus(row.plan_status);
  const materialStatus = row.aggregate_status || row.plan_status || 'planned';
  return {
    memberId: row.member_id,
    planId: row.plan_id,
    projectId: row.project_id,
    projectTitle: projectTitle(row.project_id, null),
    destinationId: row.destination_id,
    destinationTitle: destinationTitle(row.destination_id),
    slotUtc: row.slot_utc,
    slotLabel: operatorLabel(slotDate, timeZone),
    time,
    publicationKind: row.publication_kind,
    expectedMedia: row.expected_media,
    topic,
    topicLabel: topic || 'тема ещё не выбрана',
    editionId: row.edition_id,
    deliveryStatus,
    materialStatus,
    retryAt: row.retry_at,
    failureReason: row.failure_reason,
    sentAt: row.sent_at,
    costUsd: row.cost_usd,
    vkUrl: vkPostUrl(row),
    terminal: isTerminalDeliveryStatus(deliveryStatus),
  };
}

function planDeliveryStatus(planStatus) {
  if (planStatus === 'missed') return 'missed';
  if (planStatus === 'cancelled') return 'cancelled';
  return 'planned';
}

function formatLocalTime(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.hour}:${parts.minute}`;
}

function vkPostUrl(row) {
  if (row.platform !== 'vk' || row.delivery_status !== 'sent' || !row.external_id) return null;
  if (!/^[1-9]\d*$/.test(String(row.vk_group_id)) || !/^[1-9]\d*$/.test(String(row.external_id))) return null;
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

export function summarizeProgress(members) {
  const total = members.length;
  let sent = 0;
  let pending = 0;
  let uncertain = 0;
  let failed = 0;
  let delayed = 0;
  for (const member of members) {
    if (member.deliveryStatus === 'sent') sent += 1;
    else if (member.deliveryStatus === 'uncertain') uncertain += 1;
    else if (['failed', 'exhausted', 'missed', 'cancelled'].includes(member.deliveryStatus)) {
      failed += 1;
    } else if (member.deliveryStatus === 'retry_wait') delayed += 1;
    else if (!member.terminal) pending += 1;
  }
  const allTerminal = total > 0 && members.every((member) => member.terminal);
  const needsAttention =
    uncertain > 0 || failed > 0 || delayed > 0 || (allTerminal && sent < total);
  return { total, sent, pending, uncertain, failed, delayed, allTerminal, needsAttention };
}

export function batchIdFromRow(batch) {
  return batch.id || `${batch.local_date}:${batch.period}`;
}
