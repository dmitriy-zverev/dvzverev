import { redisConfigured, getRedis } from './client.mjs';
import { currentWeekStartYmd, ensureCurrentWeek, weekUtcBounds } from './schedule.mjs';

export { redisConfigured, getRedis };

export async function bootstrapRedisSchedule(service, { db = null, env = process.env, now = new Date() } = {}) {
  if (!redisConfigured(env)) return null;
  const redis = await getRedis(env);
  let seedRows = [];
  if (db) {
    const weekStart = currentWeekStartYmd(now);
    const { startMs, endMs } = weekUtcBounds(weekStart);
    seedRows = db
      .prepare(
        `SELECT plan_id, project_id, destination_id, slot_utc, slot_key, topic, brief, version,
                plan_status, edition_id
         FROM schedule_slots
         WHERE slot_utc >= ? AND slot_utc < ?`,
      )
      .all(new Date(startMs).toISOString(), new Date(endMs).toISOString());
  }
  return ensureCurrentWeek(redis, service, { now, seedRows });
}

export async function runRedisScheduleTick(service, options = {}) {
  if (!redisConfigured(options.env)) return null;
  return bootstrapRedisSchedule(service, options);
}
