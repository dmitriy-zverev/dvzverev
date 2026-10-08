import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { OAuthStore } from '../../bot/vk-oauth/store.mjs';
import { VkOAuthClient } from '../../bot/vk-oauth/client.mjs';
import { getWeeklyVkClient } from '../../bot/vk-oauth/legacy.mjs';
import {
  getOAuthBroker,
  getTrialOAuthBroker,
  reportOAuthError,
} from '../../bot/vk-oauth/routes.mjs';
import { openCabinetDb } from '../../bot/cabinet/db.mjs';
import { createSession, ensurePasswordHash } from '../../bot/cabinet/auth.mjs';
import { startCabinetServer } from '../../bot/cabinet/server.mjs';
import { createRefreshTick } from '../../bot/vk-oauth/refresh.mjs';

test('background refresh skips disconnected accounts and backs off failed refreshes', async () => {
  let time = 0,
    calls = 0,
    reports = 0,
    connected = false,
    fail = true;
  const tick = createRefreshTick(
    {
      status: () => ({ connected }),
      accessToken: async () => {
        calls++;
        if (fail) throw new Error('vk_oauth_exchange_rejected');
      },
    },
    async () => {
      reports++;
    },
    () => time,
  );
  await tick();
  assert.equal(calls, 0);
  connected = true;
  await tick();
  await tick();
  assert.equal(calls, 1);
  time = 60000;
  await tick();
  assert.equal(calls, 2);
  time = 120000;
  await tick();
  assert.equal(calls, 2);
  time = 180000;
  fail = false;
  await tick();
  assert.equal(calls, 3);
  await tick();
  assert.equal(calls, 4);
  assert.equal(reports, 2);
});

async function fixture(t, fetcher) {
  const dir = await mkdtemp(join(tmpdir(), 'vk-oauth-test-'));
  const key = randomBytes(32).toString('hex');
  const store = new OAuthStore(join(dir, 'oauth.sqlite'), key);
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const config = {
    clientId: '54806918',
    redirectUri: 'https://www.dvzverev.ru/vk/callback',
    scope: 'wall photos groups video',
    mediaDir: dir,
  };
  const client = new VkOAuthClient(store, config, fetcher);
  store.set('token', {
    accessToken: 'access-a',
    refreshToken: 'refresh-a',
    deviceId: 'device-a',
    userId: 42,
    expiresAt: Date.now() + 3600000,
  });
  return { client, store, dir, key, config };
}
const json = (body) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const tokenResponse = (options) =>
  json({
    access_token: 'access-b',
    refresh_token: 'refresh-b',
    device_id: 'device-b',
    expires_in: 3600,
    state: options.body.get('state'),
    user_id: 42,
  });

test('encrypted token store persists across restart without plaintext secrets', async (t) => {
  const { store, dir, key } = await fixture(t, () => {});
  assert.equal(
    (await readFile(join(dir, 'oauth.sqlite'))).includes(Buffer.from('refresh-a')),
    false,
  );
  const reopened = new OAuthStore(join(dir, 'oauth.sqlite'), key);
  assert.equal(reopened.get('token').refreshToken, 'refresh-a');
  reopened.close();
  const wrong = new OAuthStore(join(dir, 'oauth.sqlite'), randomBytes(32).toString('hex'));
  assert.throws(() => wrong.get('token'));
  wrong.close();
  assert.equal(store.get('token').userId, 42);
});

test('PKCE callback validates session, consumes state once and verifies identity', async (t) => {
  const { client, store } = await fixture(t, async (url, options) =>
    url.includes('/oauth2/') ? tokenResponse(options) : json({ response: [{ id: 42 }] }),
  );
  const auth = new URL(client.begin('session'));
  assert.equal(auth.searchParams.get('code_challenge_method'), 's256');
  assert.equal(auth.searchParams.get('app_id'), auth.searchParams.get('client_id'));
  assert.equal(auth.searchParams.get('sdk_type'), 'vkid');
  assert.equal(auth.searchParams.get('v'), '2.6.1');
  assert.equal(auth.searchParams.get('code_challenge').length, 43);
  const query = new URLSearchParams({
    state: auth.searchParams.get('state'),
    code: 'code',
    device_id: 'device',
  });
  const result = await client.callback(query, 'session');
  assert.equal(result.userId, 42);
  assert.equal(result.refreshAvailable, true);
  assert.equal(store.get('token').refreshToken, 'refresh-b');
  await assert.rejects(client.callback(query, 'session'), /invalid_state/);
  const wrong = new URLSearchParams({
    state: new URL(client.begin('session')).searchParams.get('state'),
    code: 'code',
    device_id: 'device',
  });
  await assert.rejects(client.callback(wrong, 'other'), /invalid_state/);
});

test('expired state and provider state mismatch cannot authorize', async (t) => {
  const { client, store } = await fixture(t, async () =>
    json({ access_token: 'secret', expires_in: 3600, state: 'wrong' }),
  );
  const state = new URL(client.begin('session')).searchParams.get('state');
  const attempt = store.get('state:' + state);
  attempt.expiresAt = 0;
  store.set('state:' + state, attempt);
  await assert.rejects(
    client.callback(new URLSearchParams({ state, code: 'code', device_id: 'device' }), 'session'),
    /invalid_state/,
  );
  await assert.rejects(client.accessToken(true), /response_state_mismatch/);
  assert.equal(store.get('token').accessToken, 'access-a');
});

test('expiry refresh is single-flight and persists rotated refresh token', async (t) => {
  let refreshes = 0;
  const { client, store } = await fixture(t, async (url, options) => {
    refreshes++;
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(options.body.get('refresh_token'), 'refresh-a');
    return tokenResponse(options);
  });
  const token = store.get('token');
  token.expiresAt = Date.now() + 10000;
  store.set('token', token);
  assert.deepEqual(
    await Promise.all([client.accessToken(), client.accessToken(), client.accessToken()]),
    ['access-b', 'access-b', 'access-b'],
  );
  assert.equal(refreshes, 1);
  assert.equal(store.get('token').refreshToken, 'refresh-b');
  assert.equal(store.get('token').deviceId, 'device-b');
});

test('explicit auth failure refreshes once and retries once; permission errors do not refresh', async (t) => {
  let calls = 0,
    refreshes = 0;
  const { client } = await fixture(t, async (url, options) => {
    if (url.includes('/oauth2/')) {
      refreshes++;
      return tokenResponse(options);
    }
    calls++;
    return json({
      error: { error_code: 5, request_params: [{ key: 'access_token', value: 'secret' }] },
    });
  });
  await assert.rejects(client.api('users.get'), /rejected_5/);
  assert.equal(calls, 2);
  assert.equal(refreshes, 1);
  client.fetcher = async () => json({ error: { error_code: 27 } });
  await assert.rejects(client.api('photos.getWallUploadServer'), /rejected_27/);
  assert.equal(refreshes, 1);
});

test('a new local PNG uploads through wall photo API using group id', async (t) => {
  const seen = [];
  const { client, dir } = await fixture(t, async (url, options) => {
    seen.push([String(url), options.body]);
    if (String(url).includes('getWallUploadServer'))
      return json({ response: { upload_url: 'https://pu.vk.com/upload' } });
    if (String(url).includes('saveWallPhoto'))
      return json({ response: [{ owner_id: -123, id: 987 }] });
    return json({ server: 1, photo: 'photo-json', hash: 'hash' });
  });
  await writeFile(join(dir, 'new.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const photo = await client.uploadPhoto('group', 123, 'new.png');
  assert.equal(photo.attachment, 'photo-123_987');
  assert.equal(seen[0][1].get('group_id'), '123');
  assert.equal(seen[2][1].get('group_id'), '123');
  assert.equal(seen[1][1].get('photo').name, 'new.png');
});

test('upload rejects foreign hosts, traversal and symlink escape; user target must be self', async (t) => {
  const { client, dir } = await fixture(t, () => {
    throw new Error('must not fetch');
  });
  await writeFile(join(dir, 'image.png'), 'test');
  await assert.rejects(
    client.upload('https://evil.test/u', 'image.png', 'photo', ['.png']),
    /untrusted_upload_url/,
  );
  await assert.rejects(
    client.upload('https://pu.vk.com/u', '../image.png', 'photo', ['.png']),
    /invalid_media_filename/,
  );
  await symlink('/etc/hosts', join(dir, 'escape.png'));
  await assert.rejects(
    client.upload('https://pu.vk.com/u', 'escape.png', 'photo', ['.png']),
    /invalid_media_file/,
  );
  assert.throws(() => client.target('user', 43), /must_be_self/);
  assert.throws(() => client.target('group', -1), /invalid_target/);
});

test('post GUID survives restart and verification failure never loses published ID', async (t) => {
  let posts = 0;
  const { client, store, config } = await fixture(t, async (url) => {
    if (String(url).includes('wall.post')) {
      posts++;
      return json({ response: { post_id: 9 } });
    }
    throw new Error('network unavailable');
  });
  const result = await client.publishPost(
    'group',
    123,
    'Test',
    'photo-123_987',
    'stable-identifier-1',
  );
  assert.equal(result.postId, 9);
  assert.equal(result.verificationError, 'vk_post_created_verification_failed');
  const restarted = new VkOAuthClient(store, config, () => {
    throw new Error('no retry');
  });
  assert.deepEqual(
    await restarted.publishPost('group', 123, 'Test', 'photo-123_987', 'stable-identifier-1'),
    result,
  );
  assert.equal(posts, 1);
  await assert.rejects(
    client.publishPost('group', 124, 'Test', 'photo-123_987', 'stable-identifier-1'),
    /guid_conflict/,
  );
});

test('ambiguous wall.post failure cannot be retried with the same GUID', async (t) => {
  let calls = 0;
  const { client } = await fixture(t, async () => {
    calls++;
    throw new Error('timeout');
  });
  await assert.rejects(
    client.publishPost('group', 123, 'Test', '', 'stable-identifier-2'),
    /transport_failure/,
  );
  await assert.rejects(
    client.publishPost('group', 123, 'Test', '', 'stable-identifier-2'),
    /manual_check/,
  );
  assert.equal(calls, 1);
});

test('HTTP OAuth routes require cabinet session; POST requires Origin; callback never returns secrets', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'vk-oauth-http-'));
  const env = {
    ...process.env,
    BOT_CABINET_DB_PATH: join(dir, 'cabinet.sqlite'),
    BOT_CABINET_PASSWORD: 'test-password',
    BOT_CABINET_HOST: '127.0.0.1',
    BOT_CABINET_PORT: '0',
    BOT_LOG_DIR: dir,
    VK_OAUTH_ENABLED: 'true',
    VK_OAUTH_CLIENT_ID: '123',
    VK_OAUTH_TRIAL_CLIENT_ID: '456',
    VK_WEEKLY_OAUTH_ENABLED: 'true',
    VK_WEEKLY_CLIENT_ID: '789',
    VK_OAUTH_REDIRECT_URI: 'https://example.test/vk/callback',
    VK_OAUTH_STORE_PATH: join(dir, 'oauth.sqlite'),
    VK_OAUTH_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  };
  const db = openCabinetDb(env);
  ensurePasswordHash(db, env);
  const session = createSession(db, env);
  db.close();
  const client = getOAuthBroker(env);
  const trialClient = getTrialOAuthBroker(env);
  const weekly = getWeeklyVkClient(env);
  let weeklyPermissions = 270356;
  weekly.fetcher = async (url, options) => {
    if (url.includes('/oauth2/')) {
      assert.equal(options.body.get('client_id'), '789');
      return tokenResponse(options);
    }
    return json({
      response: url.includes('account.getAppPermissions') ? weeklyPermissions : [{ id: 42 }],
    });
  };
  client.fetcher = async (url, options) =>
    url.includes('/oauth2/') ? tokenResponse(options) : json({ response: [{ id: 42 }] });
  const trialExchanges = [];
  trialClient.fetcher = async (url, options) => {
    if (url.includes('/oauth2/')) {
      trialExchanges.push(options.body.get('client_id'));
      return tokenResponse(options);
    }
    return json({ response: [{ id: 42 }] });
  };
  const server = startCabinetServer(env);
  await new Promise((r) => server.once('listening', r));
  const root = `http://127.0.0.1:${server.address().port}`;
  env.BOT_CABINET_ALLOWED_ORIGINS = root;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    client.store.close();
    trialClient.store.close();
    weekly.store.close();
    await rm(dir, { recursive: true, force: true });
  });
  assert.equal((await fetch(root + '/vk/login', { redirect: 'manual' })).status, 401);
  const headers = { cookie: `cabinet_session=${session.token}` };
  const login = await fetch(root + '/vk/login', { redirect: 'manual', headers });
  assert.equal(login.status, 303);
  const state = new URL(login.headers.get('location')).searchParams.get('state');
  const callback = await fetch(`${root}/vk/callback?state=${state}&code=code&device_id=device`, {
    headers,
  });
  assert.equal(callback.status, 200);
  const body = await callback.json();
  assert.equal(body.connected, true);
  assert.equal(body.userId, 42);
  assert.equal(JSON.stringify(body).includes('access-b'), false);
  assert.equal(JSON.stringify(body).includes('refresh-b'), false);
  assert.equal(
    (await fetch(root + '/bot/api/v1/vk/refresh', { method: 'POST', headers })).status,
    403,
  );
  assert.equal((await fetch(root + '/bot/api/v1/vk/status', { headers })).status, 200);
  const primaryToken = client.store.get('token');
  assert.equal((await fetch(root + '/vk/trial/login', { redirect: 'manual' })).status, 401);
  const trialLogin = await fetch(root + '/vk/trial/login', { redirect: 'manual', headers });
  assert.equal(trialLogin.status, 303);
  const trialUrl = new URL(trialLogin.headers.get('location'));
  assert.equal(trialUrl.searchParams.get('client_id'), '456');
  assert.equal(trialUrl.searchParams.get('scope'), 'wall photos groups');
  const trialCallback = await fetch(
    `${root}/vk/callback?state=${trialUrl.searchParams.get('state')}&code=code&device_id=device`,
    { headers },
  );
  assert.equal(trialCallback.status, 200);
  const trialBody = await trialCallback.json();
  assert.equal(trialBody.trial, true);
  assert.equal(trialBody.clientId, '456');
  assert.equal(trialBody.refreshAvailable, true);
  assert.equal(JSON.stringify(trialBody).includes('refresh-b'), false);
  assert.deepEqual(client.store.get('token'), primaryToken);
  assert.equal(trialClient.status().connected, true);
  assert.deepEqual(trialExchanges, ['456']);
  assert.equal((await fetch(root + '/vk/trial/refresh', { method: 'POST', headers })).status, 403);
  const trialRefresh = await fetch(root + '/vk/trial/refresh', {
    method: 'POST',
    headers: { ...headers, origin: root },
    body: '{}',
  });
  assert.equal(trialRefresh.status, 200);
  assert.deepEqual(trialExchanges, ['456', '456']);
  assert.deepEqual(client.store.get('token'), primaryToken);
  assert.equal((await fetch(root + '/vk/trial/posts', { method: 'POST', headers })).status, 400);
  const savedTrialToken = trialClient.store.get('token');
  trialClient.fetcher = async (url, options) => {
    if (!url.includes('/oauth2/')) return json({ response: [{ id: 42 }] });
    const token = await tokenResponse(options).json();
    delete token.refresh_token;
    return json(token);
  };
  const noRefreshLogin = await fetch(root + '/vk/trial/login', { redirect: 'manual', headers });
  const noRefreshState = new URL(noRefreshLogin.headers.get('location')).searchParams.get('state');
  const rejectedCallback = await fetch(
    `${root}/vk/callback?state=${noRefreshState}&code=code&device_id=device`,
    { headers },
  );
  assert.equal(rejectedCallback.status, 400);
  assert.equal((await rejectedCallback.json()).error, 'vk_oauth_refresh_token_missing');
  assert.deepEqual(trialClient.store.get('token'), savedTrialToken);
  assert.deepEqual(client.store.get('token'), primaryToken);
  const weeklyLogin = await fetch(root + '/bot/api/v1/vk/legacy/login', {
    redirect: 'manual',
    headers,
  });
  assert.equal(weeklyLogin.status, 303);
  const weeklyUrl = new URL(weeklyLogin.headers.get('location'));
  assert.equal(weeklyUrl.hostname, 'id.vk.ru');
  assert.equal(weeklyUrl.searchParams.get('client_id'), '789');
  assert.equal(weeklyUrl.searchParams.get('app_id'), '789');
  assert.equal(weeklyUrl.searchParams.get('sdk_type'), 'vkid');
  assert.equal(weeklyUrl.searchParams.get('response_type'), 'code');
  const weeklyCallback = await fetch(
    `${root}/vk/callback?state=${weeklyUrl.searchParams.get('state')}&code=code&device_id=device`,
    { redirect: 'manual', headers },
  );
  assert.equal(weeklyCallback.status, 303);
  assert.equal(weeklyCallback.headers.get('location'), '/bot/?vk=connected');
  assert.equal(weekly.status().canPrepare, true);
  assert.equal(weekly.status().canVideo, true);
  assert.equal(weekly.status().refreshAvailable, true);
  const weeklyToken = weekly.store.get('token');
  await weekly.accessToken(true);
  assert.equal(weekly.store.get('token').permissions, 270356);
  weeklyPermissions = 4;
  const insufficientLogin = await fetch(root + '/vk/legacy/login', { redirect: 'manual', headers });
  const insufficientState = new URL(insufficientLogin.headers.get('location')).searchParams.get(
    'state',
  );
  const rejectedWeekly = await fetch(
    `${root}/vk/callback?state=${insufficientState}&code=secret-code&device_id=device`,
    { headers },
  );
  assert.equal(rejectedWeekly.status, 400);
  const errorPage = await rejectedWeekly.text();
  assert.match(errorPage, /VK не выдал приложению права/);
  assert.match(errorPage, /приложения 789 в кабинете VK ID/);
  assert.equal(errorPage.includes('54809516'), false);
  assert.equal(errorPage.includes('secret-code'), false);
  assert.equal(errorPage.includes('access-b'), false);
  assert.equal(weekly.store.get('token').accessToken, weeklyToken.accessToken);
  await assert.rejects(weekly.accessToken(true), /wall_photos_groups_required/);
  assert.deepEqual(client.store.get('token'), primaryToken);
  assert.deepEqual(trialClient.store.get('token'), savedTrialToken);
  assert.equal(
    (
      await fetch(root + '/vk/legacy/complete', {
        method: 'POST',
        headers: { ...headers, origin: root },
        body: '{}',
      })
    ).status,
    400,
  );
});

test('VK authentication diagnostics retain only known reasons, method and numeric subcode', async (t) => {
  const { client, dir } = await fixture(t, async () => json({ error: { error_code: 5 } }));
  for (const [description, reason] of [
    ['User authorization failed: access_token was given to another ip address.', '_ip_mismatch'],
    ['User authorization failed: access_token has expired.', '_expired'],
    ['User authorization failed: access revoked.', '_revoked'],
    ['User authorization failed: invalid access_token (4).', '_invalid_token'],
    ['secret-provider-detail', ''],
  ]) {
    client.fetcher = async () =>
      json({
        error: {
          error_code: 5,
          error_subcode: 1130,
          error_msg: description,
          request_params: [{ key: 'access_token', value: 'secret-token' }],
        },
      });
    let rejected;
    await assert.rejects(client.rawApi('users.get', {}, 'secret-token'), (error) => {
      rejected = error;
      assert.equal(error.message, 'vk_api_rejected_5' + reason);
      assert.equal(error.vkCode, 5);
      assert.equal(error.vkSubcode, 1130);
      assert.equal(error.vkMethod, 'users.get');
      assert.equal(JSON.stringify(error).includes('secret'), false);
      assert.equal(error.stack.includes('secret'), false);
      return true;
    });
    await reportOAuthError({ BOT_LOG_DIR: dir }, rejected);
    const record = JSON.parse(
      (await readFile(join(dir, 'errors.jsonl'), 'utf8')).trim().split('\n').at(-1),
    );
    assert.equal(record.vkMethod, 'users.get');
    assert.equal(record.vkSubcode, 1130);
    assert.equal(record.message, 'vk_api_rejected_5' + reason);
    assert.equal(JSON.stringify(record).includes('secret'), false);
  }
});
