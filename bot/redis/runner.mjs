import { redisConfigured, getRedis } from './client.mjs';
import { claimDueTasks, getTask, markTaskStatus, releaseTaskLock } from './schedule.mjs';
import { META_WEEK, weekIndexKey } from './keys.mjs';

function matchesRubric(entry, task) {
  return (
    (!task.rubricRevision || (entry.rubricRevision || 1) === task.rubricRevision) &&
    (!task.rubricId ||
      (entry.rubricId ? entry.rubricId === task.rubricId : task.rubricLegacyAllowed))
  );
}

// Delivery state is durable and authoritative; publish() may be finishing a
// different slot, so its return value cannot be used as this task's receipt.
export function taskStatusFromState(task, state) {
  if (task.status === 'cancelled') return 'cancelled';
  const entries = state.entries.filter(
    (entry) =>
      entry.slot === task.slotKey && !entry.generationRecovered && matchesRubric(entry, task),
  );
  const deliveries = entries.filter((entry) => entry.reason !== 'generation_exhausted');
  if (deliveries.some((entry) => entry.status === 'uncertain' || entry.status === 'sending'))
    return 'uncertain';
  const destination = task.platform || 'vk';
  const receipt = deliveries.find(
    (entry) => entry.platform === destination && entry.status === 'sent',
  );
  if (receipt) return 'sent';
  if (
    state.pendingGeneration?.slot === task.slotKey &&
    matchesRubric(state.pendingGeneration, task)
  )
    return 'generating';
  if (deliveries.some((entry) => ['retry_wait', 'rejected'].includes(entry.status)))
    return 'generating';
  if (
    entries.some(
      (entry) =>
        !entry.generationRecovered && ['failed', 'exhausted', 'empty'].includes(entry.status),
    )
  )
    return 'failed';
  return task.status === 'generating' ? 'planned' : task.status;
}

export async function reconcileProjectTasks(redis, projectId, state) {
  const week = await redis.get(META_WEEK);
  if (!week) return;
  for (const id of await redis.sMembers(weekIndexKey(week))) {
    const task = await getTask(redis, id);
    if (!task || task.projectId !== projectId) continue;
    const status = taskStatusFromState(task, state);
    if (status !== task.status) await markTaskStatus(redis, id, status);
  }
}

export async function dueTasksForProject(projectId, now = new Date(), env = process.env) {
  if (!redisConfigured(env)) return [];
  const redis = await getRedis(env);
  return claimDueTasks(redis, now, { projectId, limit: 1 });
}

export async function completeRedisTask(taskId, status, env = process.env) {
  if (!redisConfigured(env)) return;
  const redis = await getRedis(env);
  await markTaskStatus(redis, taskId, status);
  await releaseTaskLock(redis, taskId);
}

export async function abandonRedisTask(taskId, env = process.env) {
  if (!redisConfigured(env)) return;
  const redis = await getRedis(env);
  await releaseTaskLock(redis, taskId);
}
