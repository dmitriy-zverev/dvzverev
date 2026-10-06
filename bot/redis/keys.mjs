export const META_WEEK = 'schedule:meta:week_start';
export const META_MATERIALIZED = 'schedule:meta:materialized_at';
export const DUE_ZSET = 'schedule:due';

export function taskKey(taskId) {
  return `schedule:t:${taskId}`;
}

export function weekIndexKey(weekStart) {
  return `schedule:w:${weekStart}`;
}

export function occupancyKey(projectId, destinationId, slotUtcMs) {
  return `schedule:occ:${projectId}:${destinationId}:${slotUtcMs}`;
}

export function lockKey(taskId) {
  return `schedule:lock:${taskId}`;
}

export function slotUtcMs(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error('invalid_slot_utc');
  return ms;
}
