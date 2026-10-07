import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCabinetDb } from '../../bot/cabinet/db.mjs';
import { materializeBatches, getBatch } from '../../bot/cabinet/batches.mjs';
import { refreshServiceSnapshot } from '../../bot/cabinet/projects.mjs';
import { materializeScheduleSlots } from '../../bot/cabinet/sync.mjs';
import { localSlotToUtc } from '../../bot/cabinet/time.mjs';
import {
  isSafeReportUrl,
  isSafePostUrl,
  renderReport,
  formatReportTelegramHtml,
} from '../../bot/cabinet/reports/render.mjs';
import { readBatchReportSnapshot } from '../../bot/cabinet/reports/snapshot.mjs';
import {
  findReportByKey,
  reportIdempotencyKey,
  insertReport,
  enqueueOutbox,
} from '../../bot/cabinet/reports/store.mjs';
import { TelegramRejection } from '../../bot/core.mjs';
import { runReportWorker } from '../../bot/cabinet/reports/worker.mjs';
import { processNotificationOutbox } from '../../bot/cabinet/reports/outbox.mjs';

const service = {
  service: {
    reports: {
      timezone: 'Europe/Moscow',
      eveningStartsAt: '16:00',
      beforeReportLeadMinutes: 5,
      batchDeadlineMinutes: 45,
      reportEmptyBatches: true,
      mode: 'shadow',
      publicSiteUrl: 'https://dvzverev.ru',
    },
  },
  destinations: {
    'code-to-think-vk': { platform: 'vk', media: { enabled: false } },
    'connaissance-vk': {
      platform: 'vk',
      media: { enabled: true, kind: 'video', times: ['18:00'] },
    },
    'things-vk': { platform: 'vk', media: { enabled: true, kind: 'video', times: ['18:00'] } },
  },
  projects: {
    'code-to-think': {
      enabled: true,
      format: 'programming',
      schedule: {
        timezone: 'Europe/Moscow',
        times: ['12:00', '18:00'],
        weekly: { 3: ['12:00', '18:00'] },
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

function seedDb(dateYmd, now) {
  const env = { BOT_CABINET_DB_PATH: ':memory:' };
  const db = openCabinetDb(env);
  refreshServiceSnapshot(db, service);
  materializeScheduleSlots(db, service, env, now);
  materializeBatches(db, service, now);
  return { db, env, dateYmd };
}

test('isSafeReportUrl rejects suffix-host bypass', () => {
  assert.equal(isSafeReportUrl('https://dvzverev.ru/bot/'), true);
  assert.equal(isSafeReportUrl('https://www.dvzverev.ru/bot/'), true);
  assert.equal(isSafeReportUrl('https://notdvzverev.ru/bot/'), false);
});

test('renderer builds before plan with cabinet link', () => {
  const now = localSlotToUtc('2026-10-07', '08:00', 'Europe/Moscow');
  const { db } = seedDb('2026-10-07', now);
  const snapshot = readBatchReportSnapshot(db, '2026-10-07', 'morning', 'Europe/Moscow');
  const rendered = renderReport({
    reportKind: 'before',
    snapshot,
    reportConfig: service.service.reports,
    now,
  });
  assert.match(rendered.headline, /УТРО/);
  assert.match(rendered.bodyPlain, /Запланировано/);
  assert.match(rendered.bodyPlain, /dvzverev\.ru\/bot\/\?date=2026-10-07&batch=morning/);
  db.close();
});

test('stale before skip still locks batch for after reports', async () => {
  const dateYmd = '2026-10-07';
  const lateStart = localSlotToUtc(dateYmd, '11:00', 'Europe/Moscow');
  const { db, env } = seedDb(dateYmd, lateStart);
  await runReportWorker(db, service, env, lateStart);
  const batch = db
    .prepare('SELECT before_locked_at FROM batches WHERE batch_id = ?')
    .get(`${dateYmd}:morning`);
  assert.ok(batch.before_locked_at);
  const editionId = randomUUID();
  const member = db
    .prepare('SELECT member_id, destination_id FROM batch_members WHERE batch_id = ? LIMIT 1')
    .get(`${dateYmd}:morning`);
  db.prepare('DELETE FROM batch_members WHERE batch_id = ? AND member_id != ?').run(
    `${dateYmd}:morning`,
    member.member_id,
  );
  db.prepare('UPDATE batch_members SET edition_id = ? WHERE member_id = ?').run(
    editionId,
    member.member_id,
  );
  db.prepare(
    `INSERT INTO editions (
      edition_id, project_id, slot_key, format, aggregate_status, created_at, updated_at
    ) VALUES (?, 'things', 'slot', 'lifestyle', 'sent', ?, ?)`,
  ).run(editionId, lateStart.toISOString(), lateStart.toISOString());
  db.prepare(
    `INSERT INTO deliveries (
      delivery_id, edition_id, project_id, destination_id, platform, status,
      attempts, created_at, updated_at
    ) VALUES (?, ?, 'things', ?, 'vk', 'sent', 1, ?, ?)`,
  ).run(
    randomUUID(),
    editionId,
    member.destination_id,
    lateStart.toISOString(),
    lateStart.toISOString(),
  );
  await runReportWorker(db, service, env, lateStart);
  assert.ok(findReportByKey(db, reportIdempotencyKey(dateYmd, 'morning', 'after', 1)));
  db.close();
});

test('worker queues before report once in shadow mode', async () => {
  const dateYmd = '2026-10-07';
  const now = localSlotToUtc(dateYmd, '09:56', 'Europe/Moscow');
  const { db, env } = seedDb(dateYmd, now);
  await runReportWorker(db, service, env, now);
  await processNotificationOutbox(db, service, service.service.reports, env, now);
  const key = reportIdempotencyKey(dateYmd, 'morning', 'before', 1);
  assert.ok(findReportByKey(db, key));
  const batch = getBatch(db, dateYmd, 'morning');
  assert.ok(batch.batch.beforeLockedAt);
  await runReportWorker(db, service, env, now);
  const reports = db
    .prepare('SELECT COUNT(*) AS count FROM reports WHERE idempotency_key = ?')
    .get(key);
  assert.equal(reports.count, 1);
  db.close();
});

test('revision bumps after before lock when member plan changes', () => {
  const dateYmd = '2026-10-07';
  const now = localSlotToUtc(dateYmd, '09:56', 'Europe/Moscow');
  const { db } = seedDb(dateYmd, now);
  db.prepare(
    `UPDATE batches SET before_locked_at = ?, baseline_editions = 3, baseline_deliveries = 3 WHERE batch_id = ?`,
  ).run(now.toISOString(), `${dateYmd}:morning`);
  const planId = randomUUID();
  db.prepare(
    `INSERT INTO schedule_slots (
      plan_id, project_id, destination_id, slot_utc, slot_key, publication_kind,
      expected_media, topic_state, plan_status, config_version, version, created_at, updated_at
    ) VALUES (?, 'things', 'things-vk', ?, '2026-10-07@11:00[Europe/Moscow]', 'text', NULL, 'unknown', 'planned', 'v', 1, ?, ?)`,
  ).run(
    planId,
    localSlotToUtc(dateYmd, '11:00', 'Europe/Moscow').toISOString(),
    now.toISOString(),
    now.toISOString(),
  );
  materializeBatches(db, service, now);
  const batch = getBatch(db, dateYmd, 'morning');
  assert.equal(batch.batch.revision, 2);
  assert.equal(batch.batch.membersAdded, 1);
  db.close();
});

test('deadline and late final follow partial then complete flow', async () => {
  const dateYmd = '2026-10-07';
  const beforeNow = localSlotToUtc(dateYmd, '09:56', 'Europe/Moscow');
  const { db, env } = seedDb(dateYmd, beforeNow);
  await runReportWorker(db, service, env, beforeNow);
  const batchId = `${dateYmd}:morning`;
  const member = db
    .prepare(
      `SELECT member_id, plan_id, edition_id, destination_id FROM batch_members WHERE batch_id = ? LIMIT 1`,
    )
    .get(batchId);
  db.prepare('DELETE FROM batch_members WHERE batch_id = ? AND member_id != ?').run(
    batchId,
    member.member_id,
  );
  db.prepare(
    'UPDATE batches SET expected_deliveries = 1, expected_editions = 1 WHERE batch_id = ?',
  ).run(batchId);
  const editionId = member.edition_id || randomUUID();
  if (!member.edition_id) {
    db.prepare('UPDATE batch_members SET edition_id = ? WHERE member_id = ?').run(
      editionId,
      member.member_id,
    );
    db.prepare('UPDATE schedule_slots SET edition_id = ? WHERE plan_id = ?').run(
      editionId,
      member.plan_id,
    );
    db.prepare(
      `INSERT INTO editions (
        edition_id, project_id, slot_key, format, aggregate_status, created_at, updated_at
      ) VALUES (?, 'things', 'slot', 'lifestyle', 'retry_wait', ?, ?)`,
    ).run(editionId, beforeNow.toISOString(), beforeNow.toISOString());
  }
  db.prepare(
    `INSERT INTO deliveries (
      delivery_id, edition_id, project_id, destination_id, platform, status,
      attempts, created_at, updated_at
    ) VALUES (?, ?, 'things', ?, 'vk', 'retry_wait', 1, ?, ?)`,
  ).run(
    randomUUID(),
    editionId,
    member.destination_id,
    beforeNow.toISOString(),
    beforeNow.toISOString(),
  );
  const deadlineNow = localSlotToUtc(dateYmd, '12:46', 'Europe/Moscow');
  await runReportWorker(db, service, env, deadlineNow);
  const deadlineKey = reportIdempotencyKey(dateYmd, 'morning', 'deadline', 1);
  assert.ok(findReportByKey(db, deadlineKey));
  db.prepare('UPDATE deliveries SET status = ?, updated_at = ? WHERE edition_id = ?').run(
    'sent',
    deadlineNow.toISOString(),
    editionId,
  );
  await runReportWorker(db, service, env, deadlineNow);
  const lateKey = reportIdempotencyKey(dateYmd, 'morning', 'late_final', 1);
  assert.ok(findReportByKey(db, lateKey));
  db.close();
});

test('after report still sends when all deliveries finish after deadline without interim deadline', async () => {
  const dateYmd = '2026-10-07';
  const beforeNow = localSlotToUtc(dateYmd, '09:56', 'Europe/Moscow');
  const { db, env } = seedDb(dateYmd, beforeNow);
  const batchId = `${dateYmd}:morning`;
  await runReportWorker(db, service, env, beforeNow);
  const member = db
    .prepare(
      `SELECT member_id, plan_id, edition_id, destination_id FROM batch_members WHERE batch_id = ? LIMIT 1`,
    )
    .get(batchId);
  db.prepare('DELETE FROM batch_members WHERE batch_id = ? AND member_id != ?').run(
    batchId,
    member.member_id,
  );
  const editionId = member.edition_id || randomUUID();
  db.prepare('UPDATE batch_members SET edition_id = ? WHERE member_id = ?').run(
    editionId,
    member.member_id,
  );
  db.prepare('UPDATE schedule_slots SET edition_id = ? WHERE plan_id = ?').run(
    editionId,
    member.plan_id,
  );
  if (!member.edition_id) {
    db.prepare(
      `INSERT INTO editions (
        edition_id, project_id, slot_key, format, aggregate_status, created_at, updated_at
      ) VALUES (?, 'things', 'slot', 'lifestyle', 'sent', ?, ?)`,
    ).run(editionId, beforeNow.toISOString(), beforeNow.toISOString());
  }
  db.prepare(
    `INSERT INTO deliveries (
      delivery_id, edition_id, project_id, destination_id, platform, status,
      attempts, created_at, updated_at
    ) VALUES (?, ?, 'things', ?, 'vk', 'generating', 1, ?, ?)`,
  ).run(
    randomUUID(),
    editionId,
    member.destination_id,
    beforeNow.toISOString(),
    beforeNow.toISOString(),
  );
  const afterDeadline = localSlotToUtc(dateYmd, '12:50', 'Europe/Moscow');
  db.prepare('UPDATE deliveries SET status = ?, updated_at = ? WHERE edition_id = ?').run(
    'sent',
    afterDeadline.toISOString(),
    editionId,
  );
  await runReportWorker(db, service, env, afterDeadline);
  const afterKey = reportIdempotencyKey(dateYmd, 'morning', 'after', 1);
  assert.ok(findReportByKey(db, afterKey));
  const deadlineKey = reportIdempotencyKey(dateYmd, 'morning', 'deadline', 1);
  assert.equal(findReportByKey(db, deadlineKey), undefined);
  db.close();
});

test('after report includes escaped project blocks, safe VK links and redacted errors', () => {
  const now = localSlotToUtc('2026-10-07', '18:30', 'Europe/Moscow');
  const { db } = seedDb('2026-10-07', now);
  const snapshot = readBatchReportSnapshot(db, '2026-10-07', 'evening', 'Europe/Moscow');
  snapshot.members[0] = {
    ...snapshot.members[0],
    deliveryStatus: 'sent',
    sentAt: now.toISOString(),
    vkUrl: 'https://vk.com/wall-242034586_123',
    projectTitle: 'Код <на> подумать',
  };
  snapshot.members[1] = {
    ...snapshot.members[1],
    deliveryStatus: 'failed',
    failureReason: 'Bad vk1.a.secret_secret https://api.vk.com/private',
  };
  snapshot.progress = { ...snapshot.progress, sent: 1, failed: 1, needsAttention: true };
  const result = renderReport({
    reportKind: 'after',
    snapshot,
    reportConfig: service.service.reports,
    now,
  });
  assert.match(result.bodyHtml, /<b>Код &lt;на&gt; подумать<\/b>/);
  assert.match(result.bodyHtml, /href="https:\/\/vk.com\/wall-242034586_123">Открыть пост →/);
  assert.match(result.bodyPlain, /Причина: Bad \[REDACTED\]/);
  assert.doesNotMatch(result.bodyHtml, /secret_secret|api.vk.com/);
  db.close();
});

test('post URLs reject credentials, foreign hosts and malformed wall IDs', () => {
  assert.equal(isSafePostUrl('https://vk.ru/wall-123_456'), true);
  for (const url of [
    'https://vk.com.evil.org/wall-123_456',
    'https://token@vk.com/wall-123_456',
    'https://vk.com/wall-123_456?access_token=secret',
    'javascript:alert(1)',
    'https://vk.com/wall-123_x',
  ])
    assert.equal(isSafePostUrl(url), false);
});

test('large reports stay within Telegram limit without cutting HTML entities or anchors', () => {
  const now = localSlotToUtc('2026-10-07', '18:30', 'Europe/Moscow');
  const { db } = seedDb('2026-10-07', now);
  const snapshot = readBatchReportSnapshot(db, '2026-10-07', 'evening', 'Europe/Moscow');
  snapshot.members = Array.from({ length: 100 }, (_, i) => ({
    ...snapshot.members[0],
    projectTitle: '<&>'.repeat(100),
    topic: 'Тема '.repeat(100),
    deliveryStatus: 'sent',
    sentAt: now.toISOString(),
    vkUrl: `https://vk.com/wall-123_${i + 1}`,
  }));
  snapshot.progress = { ...snapshot.progress, total: 100, sent: 100 };
  const result = renderReport({
    reportKind: 'after',
    snapshot,
    reportConfig: service.service.reports,
    now,
  });
  const html = formatReportTelegramHtml(result.headline, result.bodyHtml);
  assert.ok(html.length < 4096);
  assert.equal((html.match(/<a /g) || []).length, (html.match(/<\/a>/g) || []).length);
  assert.match(html, /Полный список — в календаре/);
  assert.match(html, /Открыть календарь →<\/a>$/);
  db.close();
});

async function ownerOutbox(t) {
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10);
  const { db } = seedDb(ymd, now);
  const logDir = await mkdtemp(join(tmpdir(), 'report-outbox-'));
  t.after(async () => {
    db.close();
    await rm(logDir, { recursive: true, force: true });
  });
  const env = { TELEGRAM_BOT_TOKEN: randomUUID(), BOT_ALERT_CHAT_ID: '123', BOT_LOG_DIR: logDir };
  const config = { ...service.service.reports, mode: 'owner', alertChatIdEnv: 'BOT_ALERT_CHAT_ID' };
  const id = randomUUID();
  insertReport(
    db,
    {
      reportId: id,
      batchId: `${ymd}:morning`,
      localDate: ymd,
      period: 'morning',
      reportKind: 'before',
      revision: 1,
      idempotencyKey: id,
      headline: 'Test',
      bodyHtml: '<b>Test</b>',
      bodyPlain: 'Test',
      snapshot: {},
    },
    now,
  );
  enqueueOutbox(db, { reportId: id, destination: '123', bodyHtml: '<b>Test</b>' }, now);
  return { db, env, config, now, id, logDir };
}

test('concurrent outbox workers send one report only', async (t) => {
  const c = await ownerOutbox(t);
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const sending = processNotificationOutbox(c.db, service, c.config, c.env, c.now, {
    notify: async () => {
      calls++;
      await gate;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await processNotificationOutbox(c.db, service, c.config, c.env, c.now, {
    notify: async () => {
      calls++;
    },
  });
  release();
  await sending;
  assert.equal(calls, 1);
  assert.equal(
    c.db.prepare('SELECT delivery_status FROM reports WHERE report_id=?').get(c.id).delivery_status,
    'sent',
  );
});

test('temporary Telegram rejection is logged and waits for backoff', async (t) => {
  const c = await ownerOutbox(t);
  await processNotificationOutbox(c.db, service, c.config, c.env, c.now, {
    notify: async () => {
      throw new TelegramRejection(429, 60);
    },
  });
  const row = c.db.prepare('SELECT status,retry_at FROM notification_outbox').get();
  assert.equal(row.status, 'retry_wait');
  assert.ok(Date.parse(row.retry_at) > Date.now());
  assert.match(await readFile(join(c.logDir, 'errors.jsonl'), 'utf8'), /telegram_delivery_failed/);
});

test('unconfirmed Telegram send is not retried automatically', async (t) => {
  const c = await ownerOutbox(t);
  let calls = 0;
  const notify = async () => {
    calls++;
    throw new Error('Network response lost');
  };
  await processNotificationOutbox(c.db, service, c.config, c.env, c.now, { notify });
  await processNotificationOutbox(
    c.db,
    service,
    c.config,
    c.env,
    new Date(c.now.getTime() + 300_000),
    { notify },
  );
  assert.equal(calls, 1);
  assert.equal(c.db.prepare('SELECT status FROM notification_outbox').get().status, 'uncertain');
});

test('initial rollout does not queue historical batches', async () => {
  const now = localSlotToUtc('2026-10-07', '09:56', 'Europe/Moscow');
  const { db, env } = seedDb('2026-10-07', now);
  await runReportWorker(db, service, env, now);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM reports WHERE local_date < '2026-10-07'").get().n,
    0,
  );
  db.close();
});
