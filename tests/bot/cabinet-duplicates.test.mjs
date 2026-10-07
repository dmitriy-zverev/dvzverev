import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCabinetDb } from '../../bot/cabinet/db.mjs';
import { refreshServiceSnapshot } from '../../bot/cabinet/projects.mjs';
import { materializeScheduleSlots, syncProjectState } from '../../bot/cabinet/sync.mjs';
import { buildOverview } from '../../bot/cabinet/overview.mjs';

test('calendar and counters show one recovered delivery, retaining failures and independent destinations', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cabinet-duplicates-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = {
    BOT_CABINET_DB_PATH: join(dir, 'cabinet.sqlite'),
    BOT_CONFIG_PATH: join(dir, 'service.json'),
  };
  const service = {
    providers: {},
    destinations: { 'group-vk': { platform: 'vk' }, 'other-vk': { platform: 'vk' } },
    projects: {
      example: {
        enabled: true,
        format: 'literary',
        schedule: { timezone: 'Europe/Moscow', times: ['10:00'] },
        delivery: { destinations: ['group-vk'] },
        statePath: 'state/example.json',
      },
    },
  };
  await mkdir(join(dir, 'state'));
  const db = openCabinetDb(env);
  t.after(() => db.close());
  refreshServiceSnapshot(db, service);
  materializeScheduleSlots(db, service, env, new Date('2026-10-07T08:00:00Z'));
  const scheduled = '2026-10-07@10:00[Europe/Moscow]';
  const manual = 'manual:duplicate-regression';
  const failed = '2026-10-06@10:00[Europe/Moscow]';
  const entries = [scheduled, manual].flatMap((slot) => [
    {
      slot,
      platform: 'telegram',
      status: 'exhausted',
      reason: 'generation_exhausted',
      createdAt: '2026-10-07T07:00:00Z',
    },
    {
      slot,
      platform: 'vk',
      status: 'sent',
      postId: slot,
      vkPostId: 42,
      vkGroupId: '123',
      vkText: 'Recovered post',
      sentAt: '2026-10-07T07:05:00Z',
      createdAt: '2026-10-07T07:00:00Z',
    },
  ]);
  entries.push({
    slot: failed,
    platform: 'telegram',
    status: 'exhausted',
    reason: 'generation_exhausted',
    createdAt: '2026-10-06T07:00:00Z',
  });
  await writeFile(join(dir, 'state/example.json'), JSON.stringify({ entries }));
  await syncProjectState(db, service, 'example', env, new Date('2026-10-07T08:00:00Z'));
  const overview = await buildOverview(db, { week: '2026-10-07' }, env);
  assert.equal(
    overview.cards.filter((card) => card.date === '2026-10-07' && !card.adHoc).length,
    1,
  );
  assert.equal(overview.cards.filter((card) => card.adHoc).length, 1);
  assert.equal(overview.summary.sent, 2);
  assert.equal(overview.deliverySummary.sent, 2);
  assert.equal(overview.deliverySummary.failed, 1);
  assert.equal(overview.deliverySummary.materials, 3);
  assert.equal(
    overview.cards.find((card) => card.date === '2026-10-07' && !card.adHoc).vkUrl,
    'https://vk.com/wall-123_42',
  );
  assert.equal(db.prepare('SELECT count(*) n FROM deliveries').get().n, 5);
  const sent = db.prepare("SELECT * FROM deliveries WHERE status = 'sent' LIMIT 1").get();
  db.prepare(
    `INSERT INTO deliveries (delivery_id,edition_id,project_id,destination_id,platform,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    'independent',
    sent.edition_id,
    'example',
    'other-vk',
    'vk',
    'sent',
    sent.created_at,
    sent.updated_at,
  );
  const distinct = await buildOverview(db, { week: '2026-10-07' }, env);
  assert.equal(distinct.deliverySummary.sent, 3);
});
