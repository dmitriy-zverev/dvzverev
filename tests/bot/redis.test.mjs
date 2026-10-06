import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  clearWeek,
  createAdHocTask,
  currentWeekStartYmd,
  ensureCurrentWeek,
  markTaskStatus,
  materializeWeek,
  updateTaskEditorial,
} from '../../bot/redis/schedule.mjs';
import { encodeTask, decodeTask } from '../../bot/redis/codec.mjs';
import { taskKey } from '../../bot/redis/keys.mjs';
import service from '../../bot/service.json' with { type: 'json' };

function createMockRedis() {
  const strings = new Map();
  const zsets = new Map();
  const sets = new Map();

  return {
    async get(key) {
      return strings.has(key) ? strings.get(key) : null;
    },
    async set(key, value, options = {}) {
      if (options.NX && strings.has(key)) return null;
      strings.set(key, value);
      return 'OK';
    },
    async del(...keys) {
      for (const key of keys) {
        strings.delete(key);
        zsets.delete(key);
        sets.delete(key);
      }
      return keys.length;
    },
    async sMembers(key) {
      return [...(sets.get(key) || new Set())];
    },
    async sAdd(key, member) {
      const bucket = sets.get(key) || new Set();
      bucket.add(member);
      sets.set(key, bucket);
      return 1;
    },
    async sRem(key, member) {
      const bucket = sets.get(key);
      if (!bucket) return 0;
      return bucket.delete(member) ? 1 : 0;
    },
    async zAdd(key, { score, value }) {
      const bucket = zsets.get(key) || [];
      bucket.push({ score: Number(score), value });
      zsets.set(key, bucket);
      return 1;
    },
    async zRem(key, value) {
      const bucket = zsets.get(key) || [];
      const next = bucket.filter((item) => item.value !== value);
      zsets.set(key, next);
      return bucket.length - next.length;
    },
    async zCard(key) {
      return (zsets.get(key) || []).length;
    },
    async zRangeByScore(key, min, max, { LIMIT }) {
      const bucket = (zsets.get(key) || [])
        .filter((item) => item.score >= min && item.score <= max)
        .sort((a, b) => a.score - b.score);
      return bucket.slice(LIMIT.offset, LIMIT.offset + LIMIT.count).map((item) => item.value);
    },
    multi() {
      const ops = [];
      const chain = {
        set(k, v) {
          ops.push(() => strings.set(k, v));
          return chain;
        },
        zAdd(k, entry) {
          ops.push(() => {
            const bucket = zsets.get(k) || [];
            bucket.push({ score: Number(entry.score), value: entry.value });
            zsets.set(k, bucket);
          });
          return chain;
        },
        del(...keys) {
          ops.push(() => {
            for (const key of keys) {
              strings.delete(key);
              zsets.delete(key);
              sets.delete(key);
            }
          });
          return chain;
        },
        sAdd(k, member) {
          ops.push(() => {
            const bucket = sets.get(k) || new Set();
            bucket.add(member);
            sets.set(k, bucket);
          });
          return chain;
        },
        sRem(k, member) {
          ops.push(() => {
            const bucket = sets.get(k);
            if (bucket) bucket.delete(member);
          });
          return chain;
        },
        async exec() {
          for (const op of ops) await op();
          return [];
        },
      };
      return chain;
    },
  };
}

describe('redis schedule', () => {
  test('codec roundtrip', () => {
    const task = decodeTask(
      encodeTask({
        id: 'id-1',
        projectId: 'things',
        destinationId: 'things-vk',
        slotUtc: '2026-10-06T15:00:00.000Z',
        slotKey: '2026-10-06@18:00[Europe/Moscow]',
        topic: 't',
        brief: 'b',
        version: 2,
        status: 'planned',
        publicationKind: 'video',
        expectedMedia: 'video',
        adHoc: false,
        weekStart: '2026-10-06',
      }),
    );
    assert.equal(task.brief, 'b');
  });

  test('materialize week fills due zset', async () => {
    const redis = createMockRedis();
    const weekStart = currentWeekStartYmd(new Date('2026-10-08T12:00:00Z'));
    const { inserted } = await materializeWeek(redis, service, weekStart, new Date('2026-10-08T12:00:00Z'));
    assert.ok(inserted > 0);
    assert.equal(await redis.zCard('schedule:due'), inserted);
    await clearWeek(redis, weekStart);
  });

  test('update editorial bumps version', async () => {
    const redis = createMockRedis();
    const task = {
      id: '11111111-1111-1111-1111-111111111111',
      projectId: 'things',
      destinationId: 'things-vk',
      slotUtc: '2026-10-08T15:00:00.000Z',
      slotKey: '2026-10-08@18:00[Europe/Moscow]',
      topic: null,
      brief: null,
      version: 1,
      status: 'planned',
      publicationKind: 'text',
      expectedMedia: null,
      adHoc: false,
      weekStart: '2026-10-06',
    };
    await redis.set(taskKey(task.id), encodeTask(task));
    const updated = await updateTaskEditorial(redis, task.id, {
      topic: 'Новая тема',
      brief: 'Бриф',
      expectedVersion: 1,
    });
    assert.equal(updated.plan.version, 2);
  });

  test('ad-hoc conflict returns suggested slot +1h', async () => {
    const redis = createMockRedis();
    const weekStart = currentWeekStartYmd(new Date('2026-10-08T12:00:00Z'));
    await materializeWeek(redis, service, weekStart, new Date('2026-10-08T12:00:00Z'));
    const ids = await redis.zRangeByScore('schedule:due', 0, Number.MAX_SAFE_INTEGER, {
      LIMIT: { offset: 0, count: 1 },
    });
    const existing = decodeTask(await redis.get(taskKey(ids[0])));
    const conflict = await createAdHocTask(redis, service, {
      projectId: existing.projectId,
      destinationId: existing.destinationId,
      slotUtc: existing.slotUtc,
      topic: 'x',
    });
    assert.equal(conflict.error, 'slot_conflict');
    assert.ok(conflict.suggestedSlotUtc);
    assert.notEqual(conflict.suggestedSlotUtc, existing.slotUtc);
  });

  test('ensureCurrentWeek does not rematerialize when due zset empty', async () => {
    const redis = createMockRedis();
    const weekStart = currentWeekStartYmd(new Date('2026-10-08T12:00:00Z'));
    await materializeWeek(redis, service, weekStart, new Date('2026-10-08T12:00:00Z'));
    const ids = await redis.zRangeByScore('schedule:due', 0, Number.MAX_SAFE_INTEGER, {
      LIMIT: { offset: 0, count: 1 },
    });
    const task = decodeTask(await redis.get(taskKey(ids[0])));
    await markTaskStatus(redis, task.id, 'generating');
    const beforeCount = (await redis.sMembers(`schedule:w:${weekStart}`)).length;
    const { inserted } = await ensureCurrentWeek(redis, service, { now: new Date('2026-10-09T12:00:00Z') });
    assert.equal(inserted, 0);
    assert.equal((await redis.sMembers(`schedule:w:${weekStart}`)).length, beforeCount);
  });
});
