import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCabinetDb } from '../../bot/cabinet/db.mjs';
import {
  batchIdFor,
  batchPeriodForLocalMinutes,
  getBatch,
  materializeBatches,
  resolveReportConfig,
} from '../../bot/cabinet/batches.mjs';
import { SCHEMA_VERSION } from '../../bot/cabinet/schema.mjs';
import { getMeta } from '../../bot/cabinet/db.mjs';
import { refreshServiceSnapshot } from '../../bot/cabinet/projects.mjs';
import { materializeScheduleSlots } from '../../bot/cabinet/sync.mjs';
import { localSlotToUtc } from '../../bot/cabinet/time.mjs';

const service = {
  service: {
    reports: {
      timezone: 'Europe/Moscow',
      eveningStartsAt: '16:00',
      beforeReportLeadMinutes: 5,
      batchDeadlineMinutes: 45,
    },
  },
  destinations: {
    'code-to-think-vk': { platform: 'vk', media: { enabled: false } },
    'connaissance-vk': { platform: 'vk', media: { enabled: true, kind: 'video', times: ['18:00'] } },
    'things-vk': { platform: 'vk', media: { enabled: true, kind: 'video', times: ['18:00'] } },
  },
  projects: {
    'code-to-think': {
      enabled: true,
      format: 'programming',
      schedule: {
        timezone: 'Europe/Moscow',
        times: ['12:00', '18:00'],
        weekly: {
          1: ['12:00', '18:00'],
          2: ['12:00'],
          3: ['12:00', '18:00'],
          4: ['12:00'],
          5: ['12:00', '18:00'],
          6: ['12:00'],
          7: ['12:00', '18:00'],
        },
        missedSlots: 'skip',
      },
      delivery: { destinations: ['code-to-think-vk'] },
    },
    'dark-academia': {
      enabled: true,
      format: 'literary',
      schedule: {
        timezone: 'Europe/Moscow',
        times: ['10:00', '18:00'],
        missedSlots: 'skip',
      },
      delivery: { destinations: ['connaissance-vk'] },
    },
    things: {
      enabled: true,
      format: 'lifestyle',
      schedule: {
        timezone: 'Europe/Moscow',
        times: ['10:00', '18:00'],
        missedSlots: 'skip',
      },
      delivery: { destinations: ['things-vk'] },
    },
  },
};

function openTestDb() {
  const env = { BOT_CABINET_DB_PATH: ':memory:' };
  const db = openCabinetDb(env);
  refreshServiceSnapshot(db, service);
  return { db, env };
}

test('batch period boundary follows service config', () => {
  const config = resolveReportConfig(service);
  assert.equal(batchPeriodForLocalMinutes(9 * 60 + 55, config.eveningStartsAt), 'morning');
  assert.equal(batchPeriodForLocalMinutes(16 * 60, config.eveningStartsAt), 'evening');
});

test('materialize batches groups weekly morning slots and keeps code at 12:00 in morning', () => {
  const { db, env } = openTestDb();
  const dateYmd = '2026-10-07';
  const now = localSlotToUtc(dateYmd, '08:00', 'Europe/Moscow');
  materializeScheduleSlots(db, service, env, now);
  materializeBatches(db, service, now);

  const morning = getBatch(db, dateYmd, 'morning');
  assert.ok(morning);
  assert.equal(morning.batch.expectedDeliveries, 3);
  assert.equal(morning.members.length, 3);
  assert.equal(
    morning.batch.beforeAtUtc,
    localSlotToUtc(dateYmd, '09:55', 'Europe/Moscow').toISOString(),
  );
  assert.equal(
    morning.batch.deadlineAtUtc,
    new Date(localSlotToUtc(dateYmd, '12:00', 'Europe/Moscow').getTime() + 45 * 60_000).toISOString(),
  );
  assert.ok(morning.members.some((member) => member.projectId === 'code-to-think'));

  const evening = getBatch(db, dateYmd, 'evening');
  assert.equal(evening.batch.expectedDeliveries, 3);
  assert.ok(evening.members.some((member) => member.projectId === 'code-to-think'));
  db.close();
});

test('tuesday evening batch has no code slot when weekly skips 18:00', () => {
  const { db, env } = openTestDb();
  const dateYmd = '2026-10-06';
  const now = localSlotToUtc(dateYmd, '08:00', 'Europe/Moscow');
  materializeScheduleSlots(db, service, env, now);
  materializeBatches(db, service, now);

  const morning = getBatch(db, dateYmd, 'morning');
  assert.equal(morning.batch.expectedDeliveries, 3);
  assert.ok(morning.members.some((member) => member.projectId === 'code-to-think'));

  const evening = getBatch(db, dateYmd, 'evening');
  assert.equal(evening.batch.expectedDeliveries, 2);
  assert.ok(!evening.members.some((member) => member.projectId === 'code-to-think'));
  db.close();
});

test('batch ids are stable per local date and period', () => {
  assert.equal(batchIdFor('2026-10-07', 'morning'), '2026-10-07:morning');
});

test('materialize batches is idempotent for data_version', () => {
  const { db, env } = openTestDb();
  const now = localSlotToUtc('2026-10-07', '08:00', 'Europe/Moscow');
  materializeScheduleSlots(db, service, env, now);
  materializeBatches(db, service, now);
  const afterFirst = Number(getMeta(db, 'data_version', '0'));
  materializeBatches(db, service, now);
  assert.equal(Number(getMeta(db, 'data_version', '0')), afterFirst);
  db.close();
});

test('invalid eveningStartsAt fails fast', () => {
  assert.throws(
    () =>
      resolveReportConfig({
        service: { reports: { eveningStartsAt: '25:99' } },
      }),
    /eveningStartsAt/,
  );
});

test('cabinet schema migration upgrades legacy metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cabinet-migrate-'));
  const dbPath = join(dir, 'cabinet.sqlite');
  const env = { BOT_CABINET_DB_PATH: dbPath };
  try {
    const db = openCabinetDb(env);
    db.prepare('UPDATE cabinet_meta SET value = ? WHERE key = ?').run('2', 'schema_version');
    db.close();

    const upgraded = openCabinetDb(env);
    assert.equal(getMeta(upgraded, 'schema_version'), String(SCHEMA_VERSION));
    assert.ok(
      upgraded
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reports'")
        .get(),
    );
    upgraded.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
