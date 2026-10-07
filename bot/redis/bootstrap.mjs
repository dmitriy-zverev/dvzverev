import { redisConfigured, getRedis } from './client.mjs';
import {
  currentWeekStartYmd,
  ensureCurrentWeek,
  reconcileDueQueue,
  weekUtcBounds,
} from './schedule.mjs';
import { listRubrics, rubricService } from '../cabinet/rubrics.mjs';
import { createHash } from 'node:crypto';
import { materializeWeek, seedMapFromRows } from './schedule.mjs';
import { getTask, markTaskStatus } from './schedule.mjs';
import { weekIndexKey } from './keys.mjs';
import { getMeta } from '../cabinet/db.mjs';

export { redisConfigured, getRedis };

export async function bootstrapRedisSchedule(
  service,
  { db = null, env = process.env, now = new Date() } = {},
) {
  if (!redisConfigured(env)) return null;
  const redis = await getRedis(env);
  let seedRows = [];
  if (db) {
    service = rubricService(db, service);
    const weekStart = currentWeekStartYmd(now);
    const { startMs, endMs } = weekUtcBounds(weekStart);
    seedRows = db
      .prepare(
        `SELECT s.*,rs.revision AS rubric_revision,rs.rubric_id,r.config_json AS rubric_config FROM schedule_slots s
         LEFT JOIN rubric_slots rs USING(plan_id)
         LEFT JOIN schedule_rubrics r ON r.id=rs.rubric_id
         WHERE s.slot_utc >= ? AND s.slot_utc < ?`,
      )
      .all(new Date(startMs).toISOString(), new Date(endMs).toISOString());
    for (const id of await redis.sMembers(weekIndexKey(weekStart))) {
      const task = await getTask(redis, id);
      if (!task || task.adHoc || !getMeta(db, `rubrics_managed:${task.projectId}`)) continue;
      const slot = seedRows.find((s) => s.plan_id === id);
      if (!slot || slot.plan_status === 'cancelled') await markTaskStatus(redis, id, 'cancelled');
    }
  }
  const result = await ensureCurrentWeek(redis, service, { now, seedRows });
  if (db) {
    const rubrics = listRubrics(db);
    if (
      rubrics.length ||
      db.prepare("SELECT 1 FROM cabinet_meta WHERE key LIKE 'rubrics_managed:%'").get()
    ) {
      const signature = createHash('sha256').update(JSON.stringify(rubrics)).digest('hex');
      const key = 'bot:schedule:rubric-signature';
      if ((await redis.get(key)) !== signature) {
        await materializeWeek(
          redis,
          service,
          currentWeekStartYmd(now),
          now,
          seedMapFromRows(seedRows),
        );
        await redis.set(key, signature);
      }
    }
  }
  await reconcileDueQueue(redis, now);
  return result;
}

export async function runRedisScheduleTick(service, options = {}) {
  if (!redisConfigured(options.env)) return null;
  return bootstrapRedisSchedule(service, options);
}
