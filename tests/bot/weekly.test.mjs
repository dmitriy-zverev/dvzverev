import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openCabinetDb } from '../../bot/cabinet/db.mjs';
import {
  nextWeek,
  weeklySnapshot,
  claimWeeklyJob,
  prepareWeeklyPosts,
} from '../../bot/cabinet/weekly.mjs';
import {
  LegacyVkClient,
  legacyCallbackPage,
  legacyManualLoginPage,
  parseLegacyRedirectUrl,
  getOwnerVkClient,
  getWeeklyVkClient,
  weeklyVkStatus,
} from '../../bot/vk-oauth/legacy.mjs';
import { listWeeklyCommunityTargets } from '../../bot/vk-oauth/community-weekly.mjs';
import { OAuthStore } from '../../bot/vk-oauth/store.mjs';
import { weeklyDelivery } from '../../bot/cabinet/weekly-delivery.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'weekly-test-'));
  const env = { BOT_CABINET_DB_PATH: join(root, 'cabinet.sqlite') };
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = openCabinetDb(env);
  const week = nextWeek(new Date('2026-10-07T10:00:00Z'));
  db.prepare('INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?)').run(
    'things',
    'Вещи',
    1,
    'Europe/Moscow',
    'lifestyle',
    'v1',
    '{}',
    '[]',
    new Date().toISOString(),
  );
  for (const [i, date] of [week.start, week.end].entries())
    db.prepare(
      `INSERT INTO schedule_slots(plan_id,project_id,destination_id,slot_utc,slot_key,publication_kind,expected_media,config_version,created_at,updated_at) VALUES (?,'things','things-vk',?,?,'image','image','v1',?,?)`,
    ).run('p' + i, date + 'T15:00:00.000Z', date + '@18:00[Europe/Moscow]', date, date);
  const dependencies = {
    app: {
      resolveProjectConfig: async () => ({
        contentMode: 'lifestyle',
        vkGroupId: '123',
        openrouterPrompt: 'Base',
        statePath: join(root, 'state.json'),
      }),
    },
    generate: async (config, { id }) => ({
      id,
      kind: 'lifestyle',
      text: config.editorialPlan.topic || 'Свет в доме.',
    }),
    cover: async () => ({ status: 'ready' }),
    upload: async () => 'photo-123_42',
    pause: async () => {},
    report: async () => {},
  };
  return { db, env, week, dependencies };
}

function client(fail) {
  let writes = 0;
  const receipts = new Map();
  return {
    get writes() {
      return writes;
    },
    accessToken: async () => 'test-secret',
    api: async (method, parameters) => {
      if (method === 'wall.post') {
        writes++;
        if (fail && writes === 1) throw fail;
        receipts.set(writes, {
          id: writes,
          owner_id: -123,
          date: parameters.publish_date,
          attachments: [{ type: 'photo', photo: { owner_id: -123, id: 42 } }],
        });
        return { post_id: writes };
      }
      return [receipts.get(Number(parameters.posts.split('_')[1]))];
    },
  };
}

test('weekly short video uses user upload and video receipt without generating a photo', async (t) => {
  const f = await fixture(t);
  f.db.prepare("UPDATE schedule_slots SET publication_kind='video',expected_media='video'").run();
  let generated = 0,
    uploaded = 0,
    writes = 0;
  f.dependencies.cover = async () => {
    throw new Error('Photo generation must not run');
  };
  f.dependencies.video = async (config) => {
    generated++;
    assert.equal(config.videoOutput, true);
    return { status: 'ready', path: '/tmp/mock.mp4' };
  };
  const receipts = new Map();
  const c = {
    status: () => ({ canVideo: true }),
    accessToken: async () => 'test-secret',
    uploadVideo: async (type, id, path) => {
      uploaded++;
      assert.equal(type, 'group');
      assert.equal(id, '123');
      assert.equal(path, '/tmp/mock.mp4');
      return { attachment: 'video-123_77' };
    },
    api: async (method, p) => {
      if (method === 'wall.post') {
        writes++;
        assert.equal(p.attachments, 'video-123_77');
        receipts.set(writes, {
          id: writes,
          owner_id: -123,
          date: p.publish_date,
          attachments: [{ type: 'video', video: { owner_id: -123, id: 77 } }],
        });
        return { post_id: writes };
      }
      return [receipts.get(Number(p.posts.split('_')[1]))];
    },
  };
  const owner = claimWeeklyJob(f.db, f.week.start);
  await prepareWeeklyPosts(f.env, f.week.start, owner, { ...f.dependencies, client: c });
  assert.equal(generated, 2);
  assert.equal(uploaded, 2);
  assert.equal(writes, 2);
  assert.equal(weeklySnapshot(f.db, new Date('2026-10-07T10:00:00Z')).ready, 2);
});

test('next week is Monday through Sunday in Moscow even around UTC midnight', () => {
  assert.equal(nextWeek(new Date('2026-10-11T22:00:00Z')).start, '2026-10-19');
  assert.equal(nextWeek(new Date('2026-10-11T20:00:00Z')).start, '2026-10-12');
});

test('prepare only missing image posts; preserve editor brief and VK receipts across reruns', async (t) => {
  const f = await fixture(t);
  const c = client();
  f.db
    .prepare("UPDATE schedule_slots SET topic='Тёплый свет',brief='Без списков' WHERE plan_id='p0'")
    .run();
  let briefs = [];
  f.dependencies.generate = async (config, { id }) => {
    briefs.push(config);
    return { id, kind: 'lifestyle', text: 'Тёплый свет.' };
  };
  const owner = claimWeeklyJob(f.db, f.week.start);
  assert.equal(claimWeeklyJob(f.db, f.week.start), null);
  await prepareWeeklyPosts(f.env, f.week.start, owner, { ...f.dependencies, client: c });
  assert.equal(c.writes, 2);
  assert.deepEqual(briefs[0].editorialPlan, { topic: 'Тёплый свет', brief: 'Без списков' });
  assert.match(briefs[0].openrouterPrompt, /Без списков/);
  assert.equal(weeklySnapshot(f.db, new Date('2026-10-07T10:00:00Z')).complete, true);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM editions').get().n, 2);
  const second = claimWeeklyJob(f.db, f.week.start);
  await prepareWeeklyPosts(f.env, f.week.start, second, { ...f.dependencies, client: c });
  assert.equal(c.writes, 2);
  f.db.close();
});

test('explicit write rejection allows retry; successful slots and saved content are not regenerated', async (t) => {
  const f = await fixture(t);
  const rejection = Object.assign(new Error('vk_api_rejected_6'), { vkCode: 6 });
  const c = client(rejection);
  let generations = 0;
  f.dependencies.generate = async (config, { id }) => {
    generations++;
    return { id, kind: 'lifestyle', text: 'Дом.' };
  };
  await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
    ...f.dependencies,
    client: c,
  });
  assert.equal(weeklySnapshot(f.db, new Date('2026-10-07T10:00:00Z')).ready, 1);
  await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
    ...f.dependencies,
    client: c,
  });
  assert.equal(c.writes, 3);
  assert.equal(generations, 2);
  f.db.close();
});

test('slot stops after three attempts and is not selected again', async (t) => {
  const f = await fixture(t);
  f.db.prepare("DELETE FROM schedule_slots WHERE plan_id='p1'").run();
  let writes = 0;
  let reports = 0;
  const c = {
    accessToken: async () => 'test-secret',
    api: async (method) => {
      if (method === 'wall.post') {
        writes++;
        throw Object.assign(new Error('vk_api_rejected_6'), { vkCode: 6 });
      }
      return [];
    },
  };
  const deps = {
    ...f.dependencies,
    client: c,
    report: async () => {
      reports++;
    },
  };
  for (let i = 0; i < 4; i++) {
    await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), deps);
  }
  const row = f.db.prepare("SELECT status, attempts FROM vk_weekly_posts WHERE plan_id='p0'").get();
  assert.equal(row.status, 'exhausted');
  assert.equal(row.attempts, 3);
  assert.equal(writes, 3);
  assert.equal(reports, 3);
  assert.equal(weeklySnapshot(f.db, new Date('2026-10-07T10:00:00Z')).exhausted, 1);
  f.db.close();
});

test('three consecutive slot failures abort the rest of the weekly job', async (t) => {
  const f = await fixture(t);
  for (let i = 2; i < 5; i++) {
    const date = f.week.start;
    f.db
      .prepare(
        `INSERT INTO schedule_slots(plan_id,project_id,destination_id,slot_utc,slot_key,publication_kind,expected_media,config_version,created_at,updated_at) VALUES (?,'things','things-vk',?,?,'image','image','v1',?,?)`,
      )
      .run(
        'p' + i,
        date + 'T1' + i + ':00:00.000Z',
        date + '@1' + i + ':00[Europe/Moscow]',
        date,
        date,
      );
  }
  let tokens = 0;
  let reports = 0;
  const c = {
    accessToken: async () => {
      tokens++;
      throw new Error('boom_not_vk_code');
    },
    api: async () => {
      throw new Error('should_not_reach_api');
    },
  };
  await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
    ...f.dependencies,
    client: c,
    report: async () => {
      reports++;
    },
  });
  assert.equal(tokens, 3);
  assert.equal(reports, 3);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM vk_weekly_posts WHERE status='failed'").get().n,
    3,
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM vk_weekly_posts WHERE status IS NULL OR status='pending'")
      .get().n,
    0,
  );
  // Remaining slots never touched in this run.
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vk_weekly_posts').get().n, 3);
  f.db.close();
});

test('unknown write outcome blocks that slot on every retry', async (t) => {
  const f = await fixture(t);
  const c = client(new Error('vk_api_transport_failure_no_retry'));
  await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
    ...f.dependencies,
    client: c,
  });
  const status = weeklySnapshot(f.db, new Date('2026-10-07T10:00:00Z'));
  assert.equal(status.uncertain, 1);
  assert.equal(status.missing, 0);
  await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
    ...f.dependencies,
    client: c,
  });
  assert.equal(c.writes, 2);
  f.db.close();
});

test('lost process lease turns posting into uncertain and never assumes success', async (t) => {
  const f = await fixture(t);
  f.db
    .prepare(
      "INSERT INTO vk_weekly_posts(plan_id,week_start,status,updated_at) VALUES ('p0',?,'posting',?)",
    )
    .run(f.week.start, new Date().toISOString());
  claimWeeklyJob(f.db, f.week.start);
  assert.equal(
    f.db.prepare("SELECT status FROM vk_weekly_posts WHERE plan_id='p0'").get().status,
    'uncertain',
  );
  f.db.close();
});

test('regular worker checks postponed receipt and marks sent only after real publication', async (t) => {
  const f = await fixture(t);
  const c = client();
  await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
    ...f.dependencies,
    client: c,
  });
  const slot = f.db.prepare("SELECT * FROM schedule_slots WHERE plan_id='p0'").get();
  const config = {
    projectId: 'things',
    destinationIds: ['things-vk'],
    vkToken: 'fake-community-key',
  };
  let type = 'postponed';
  let calls = 0;
  const fetcher = async (url, options) => {
    calls++;
    assert.match(url, /wall.getById$/);
    assert.equal(options.body.get('access_token'), 'fake-community-key');
    return {
      ok: true,
      json: async () => ({
        response: [
          { id: 1, owner_id: -123, date: Date.parse(slot.slot_utc) / 1000, post_type: type },
        ],
      }),
    };
  };
  const now = new Date(Date.parse(slot.slot_utc) + 1000);
  const delayed = await weeklyDelivery(config, slot.slot_key, now, fetcher, f.env);
  assert.equal(delayed.status, 'vk_scheduled');
  assert.equal(
    f.db.prepare("SELECT status FROM vk_weekly_posts WHERE plan_id='p0'").get().status,
    'scheduled',
  );
  type = 'post';
  const sent = await weeklyDelivery(config, slot.slot_key, now, fetcher, f.env);
  assert.equal(sent.status, 'sent');
  assert.equal(sent.entry.image.vk.attachment, 'photo-123_42');
  await weeklyDelivery(config, slot.slot_key, now, fetcher, f.env);
  assert.equal(calls, 2);
  assert.equal(c.writes, 2);
  f.db.close();
});

test('successful write with missing photo remains uncertain and never posts again', async (t) => {
  const f = await fixture(t);
  const c = client();
  const api = c.api;
  c.api = async (method, p) => (method === 'wall.getById' ? [] : api(method, p));
  await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
    ...f.dependencies,
    client: c,
  });
  assert.equal(weeklySnapshot(f.db, new Date('2026-10-07T10:00:00Z')).uncertain, 2);
  await prepareWeeklyPosts(f.env, f.week.start, claimWeeklyJob(f.db, f.week.start), {
    ...f.dependencies,
    client: c,
  });
  assert.equal(c.writes, 2);
  f.db.close();
});

test('login verifies real user and permissions, consumes state once and never refreshes another app', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'legacy-test-'));
  const store = new OAuthStore(join(root, 'oauth.sqlite'), randomBytes(32).toString('hex'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  let now = 100000;
  const fetcher = async (url) => ({
    ok: true,
    json: async () => ({ response: url.includes('users.get') ? [{ id: 42 }] : 270340 }),
  });
  const legacy = new LegacyVkClient(
    store,
    {
      clientId: '54809516',
      redirectUri: 'https://oauth.vk.ru/blank.html',
      allowedUserId: '42',
    },
    fetcher,
    () => now,
  );
  const url = new URL(legacy.begin('session'));
  assert.equal(url.searchParams.get('response_type'), 'token');
  const body = {
    state: url.searchParams.get('state'),
    access_token: 'vk1.a.' + 'a'.repeat(30),
    expires_in: '86400',
  };
  const returnedUrl = 'https://oauth.vk.ru/blank.html#' + new URLSearchParams(body);
  assert.deepEqual(parseLegacyRedirectUrl(returnedUrl), body);
  await legacy.complete(parseLegacyRedirectUrl(returnedUrl), 'session');
  assert.equal(legacy.status().canPrepare, true);
  assert.equal(legacy.status().refreshAvailable, false);
  await assert.rejects(legacy.complete(body, 'session'), /invalid_state/);
  now += 86400001;
  assert.equal(legacy.status().canPrepare, false);
  await assert.rejects(legacy.accessToken(), /login_required/);
  const page = legacyCallbackPage();
  assert.match(page.html, /history.replaceState/);
  assert.match(page.html, /\/bot\/\?vk=connected/);
  const manual = legacyManualLoginPage(url.href);
  assert.match(manual.html, /id="vk-return" type="password"/);
  assert.match(manual.html, /credentials:'same-origin'/);
  assert.equal(manual.html.includes(body.access_token), false);
  assert.throws(
    () => parseLegacyRedirectUrl(returnedUrl.replace('oauth.vk.ru', 'evil.test')),
    /invalid_redirect/,
  );
  assert.throws(
    () => parseLegacyRedirectUrl(returnedUrl.replace('https:', 'http:')),
    /invalid_redirect/,
  );
  assert.throws(
    () => parseLegacyRedirectUrl('https://oauth.vk.ru/blank.html#error=access_denied'),
    /consent_required/,
  );
  const wrong = new URL(legacy.begin('session'));
  await assert.rejects(
    legacy.complete({ ...body, state: wrong.searchParams.get('state') }, 'other-session'),
    /invalid_state/,
  );
  legacy.config.redirectUri = 'https://oauth.vk.com/blank.html';
  const comLogin = new URL(legacy.begin('session'));
  assert.equal(comLogin.origin, 'https://oauth.vk.com');
  assert.equal(comLogin.searchParams.get('redirect_uri'), 'https://oauth.vk.com/blank.html');
});

test('weekly preparation defaults to community tokens when user oauth is disabled', () => {
  const env = {
    VK_LEGACY_OAUTH_ENABLED: 'false',
    VK_WEEKLY_OAUTH_ENABLED: 'false',
    BOT_CONFIG_PATH: join(process.cwd(), 'bot/service.json'),
    VK_DARK_ACADEMIA_ACCESS_TOKEN: 'vk1.a.community-dark',
    VK_DARK_ACADEMIA_GROUP_ID: '194579254',
    VK_THINGS_ACCESS_TOKEN: 'vk1.a.community-things',
    VK_THINGS_GROUP_ID: '242058626',
  };
  const targets = listWeeklyCommunityTargets(env);
  assert.equal(targets.length, 2);
  const client = getWeeklyVkClient(env);
  assert.equal(client.mode, 'community');
  assert.equal(client.status().canPrepare, true);
  client.bindGroup('194579254');
  assert.equal(client.accessToken(), 'vk1.a.community-dark');
});

test('owner oauth can be enabled while weekly posts stay on community', () => {
  const env = {
    VK_LEGACY_OAUTH_ENABLED: 'false',
    VK_WEEKLY_OAUTH_ENABLED: 'true',
    VK_WEEKLY_CLIENT_ID: '54809454',
    VK_OAUTH_REDIRECT_URI: 'https://www.dvzverev.ru/vk/callback/',
    VK_OAUTH_ENCRYPTION_KEY: 'a'.repeat(64),
    VK_OAUTH_STORE_PATH: join(tmpdir(), `vk-owner-${Date.now()}.sqlite`),
    BOT_CONFIG_PATH: join(process.cwd(), 'bot/service.json'),
    VK_DARK_ACADEMIA_ACCESS_TOKEN: 'vk1.a.community-dark',
    VK_DARK_ACADEMIA_GROUP_ID: '194579254',
    VK_THINGS_ACCESS_TOKEN: 'vk1.a.community-things',
    VK_THINGS_GROUP_ID: '242058626',
  };
  assert.equal(getWeeklyVkClient(env).mode, 'community');
  const owner = getOwnerVkClient(env);
  assert.equal(owner.mode || owner.status().mode, 'owner');
  const status = weeklyVkStatus(env);
  assert.equal(status.mode, 'community');
  assert.equal(status.canPrepare, true);
  assert.equal(status.ownerOAuth.available, true);
  assert.equal(status.ownerOAuth.connected, false);
  owner.store.close();
});

test('rejected manual token is never stored and its attempt cannot be replayed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vk-rejected-'));
  const store = new OAuthStore(join(root, 'oauth.sqlite'), randomBytes(32).toString('hex'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const client = new LegacyVkClient(
    store,
    {
      clientId: '54809516',
      redirectUri: 'https://oauth.vk.ru/blank.html',
      allowedUserId: '42',
    },
    async () => ({
      ok: true,
      json: async () => ({
        error: {
          error_code: 5,
          error_msg: 'User authorization failed: access_token was given to another ip address.',
        },
      }),
    }),
  );
  const body = {
    state: new URL(client.begin('session')).searchParams.get('state'),
    access_token: 'vk1.a.' + 'a'.repeat(30),
    expires_in: '86400',
  };
  await assert.rejects(client.complete(body, 'session'), /vk_api_rejected_5_ip_mismatch/);
  assert.equal(store.get('token'), null);
  assert.equal(client.status().connected, false);
  await assert.rejects(client.complete(body, 'session'), /invalid_state/);
});
