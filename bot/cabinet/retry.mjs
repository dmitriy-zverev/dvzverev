import { randomUUID } from 'node:crypto';
import { loadAppConfig } from '../app-config.mjs';
import { readState, retryUnpublishedSlot } from '../core.mjs';
import { getRedis, redisConfigured } from '../redis/client.mjs';
import {
  getTask,
  markTaskStatus,
  requeuePlanFromScheduleRow,
  SLOT_CATCHUP_MS,
} from '../redis/schedule.mjs';
import { rubricService } from './rubrics.mjs';
import { bumpDataVersion, withTransaction } from './db.mjs';
import { getEdition } from './overview.mjs';
import { loadServiceForCabinet } from './projects.mjs';
import { canRetryPlanSlot, canRetryPublication } from './status.mjs';
import { syncProjectState } from './sync.mjs';

const HTTP_STATUS = {
  locked: 409,
  generation_pending: 409,
  not_recoverable: 409,
  not_found: 404,
  paused: 409,
};

export async function retryPlanNow(db, planId, env = process.env) {
  const plan = db.prepare('SELECT * FROM schedule_slots WHERE plan_id = ?').get(planId);
  if (!plan) return { error: 'not_found', status: 404 };
  if (
    !canRetryPlanSlot({
      slotKey: plan.slot_key,
      status: plan.plan_status,
      editionId: plan.edition_id,
    })
  ) {
    return { error: 'not_retryable', status: 409 };
  }

  const now = new Date();
  const stamp = now.toISOString();

  if (redisConfigured(env)) {
    const redis = await getRedis(env);
    let task = await getTask(redis, planId);
    if (!task) {
      const { document } = await loadServiceForCabinet(env);
      const service = rubricService(db, document);
      const restored = await requeuePlanFromScheduleRow(redis, service, plan, now);
      if (restored.error) {
        return { error: restored.error, status: HTTP_STATUS[restored.error] || 409 };
      }
      task = restored.task;
    } else if (task.editionId) {
      return { error: 'not_retryable', status: 409 };
    } else if (!['missed', 'failed', 'exhausted'].includes(task.status)) {
      return { error: 'not_retryable', status: 409 };
    } else {
      const ageMs = now.getTime() - Date.parse(task.slotUtc);
      if (ageMs < 0 || ageMs >= SLOT_CATCHUP_MS) return { error: 'not_retryable', status: 409 };
      const updated = await markTaskStatus(redis, planId, 'planned');
      if (!updated) return { error: 'not_found', status: 404 };
    }
    withTransaction(db, () => {
      db.prepare(
        `UPDATE schedule_slots SET plan_status = 'planned', updated_at = ?
         WHERE plan_id = ? AND edition_id IS NULL AND plan_status IN ('missed', 'failed', 'exhausted')`,
      ).run(stamp, planId);
      bumpDataVersion(db);
    });
    db.prepare(
      'INSERT INTO audit_log (audit_id, actor, action, plan_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      randomUUID(),
      'owner',
      'retry_missed_plan',
      planId,
      JSON.stringify({ slotKey: plan.slot_key, projectId: plan.project_id }),
      stamp,
    );
    return { status: 'queued', slotKey: plan.slot_key };
  }

  const app = await loadAppConfig(env);
  const config = await app.resolveProjectConfig(plan.project_id);
  const task = {
    id: planId,
    topic: plan.topic,
    brief: plan.brief,
    slotKey: plan.slot_key,
  };
  const result = await retryUnpublishedSlot(config, plan.slot_key, task);
  if (result.status !== 'queued') {
    return { error: result.status, status: HTTP_STATUS[result.status] || 409 };
  }
  const { document } = await loadServiceForCabinet(env);
  await syncProjectState(db, document, plan.project_id, env);
  withTransaction(db, () => {
    db.prepare(
      `UPDATE schedule_slots SET plan_status = 'planned', updated_at = ?
       WHERE plan_id = ? AND edition_id IS NULL AND plan_status IN ('missed', 'failed', 'exhausted')`,
    ).run(stamp, planId);
    bumpDataVersion(db);
  });
  db.prepare(
    'INSERT INTO audit_log (audit_id, actor, action, plan_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    randomUUID(),
    'owner',
    'retry_missed_plan',
    planId,
    JSON.stringify({ slotKey: plan.slot_key, projectId: plan.project_id }),
    stamp,
  );
  return { status: 'queued', slotKey: plan.slot_key };
}

export async function retryEditionNow(db, editionId, env = process.env) {
  const detail = getEdition(db, editionId);
  if (!detail) return { error: 'not_found', status: 404 };
  if (!canRetryPublication(detail)) return { error: 'not_retryable', status: 409 };

  const app = await loadAppConfig(env);
  const config = await app.resolveProjectConfig(detail.edition.projectId);
  const state = await readState(config);
  const slotKey = detail.edition.slotKey;
  const stored = state.entries.find((entry) => entry.slot === slotKey && entry.scheduledTask)
    ?.scheduledTask;
  const task = { ...(stored && typeof stored === 'object' ? stored : {}), slotKey };
  if (!task.topic && detail.edition.topic) task.topic = detail.edition.topic;
  if (!task.brief && detail.edition.brief) task.brief = detail.edition.brief;
  if (detail.plan?.id && !task.id) task.id = detail.plan.id;

  const result = await retryUnpublishedSlot(config, slotKey, task);
  if (result.status !== 'queued') {
    return { error: result.status, status: HTTP_STATUS[result.status] || 409 };
  }

  const { document } = await loadServiceForCabinet(env);
  await syncProjectState(db, document, detail.edition.projectId, env);
  db.prepare(
    'INSERT INTO audit_log (audit_id, actor, action, plan_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    randomUUID(),
    'owner',
    'retry_unpublished_slot',
    detail.plan?.id || null,
    JSON.stringify({
      editionId,
      slotKey,
      projectId: detail.edition.projectId,
    }),
    new Date().toISOString(),
  );
  return { status: 'queued', slotKey };
}
