import { randomUUID } from 'node:crypto';
import { loadAppConfig } from '../app-config.mjs';
import { readState, retryUnpublishedSlot } from '../core.mjs';
import { getEdition } from './overview.mjs';
import { loadServiceForCabinet } from './projects.mjs';
import { canRetryPublication } from './status.mjs';
import { syncProjectState } from './sync.mjs';

const HTTP_STATUS = {
  locked: 409,
  generation_pending: 409,
  not_recoverable: 409,
  not_found: 404,
  paused: 409,
};

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
