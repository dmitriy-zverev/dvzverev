import { redisConfigured, getRedis } from './client.mjs';
import { claimDueTasks, markTaskStatus, releaseTaskLock } from './schedule.mjs';

export async function dueTasksForProject(projectId, now = new Date(), env = process.env) {
  if (!redisConfigured(env)) return [];
  const redis = await getRedis(env);
  return claimDueTasks(redis, now, { projectId, limit: 2 });
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
