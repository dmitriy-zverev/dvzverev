import { maintainMedia } from '../../bot/maintenance.mjs';
import { coverPath } from '../../bot/images.mjs';
import { sendNotification } from '../../bot/notifications.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logError, redact } from '../../bot/logging.mjs';
import { writeAtomic } from '../../bot/storage.mjs';
import {
  configFromEnv,
  publish,
  TelegramRejection,
  reportRuntimeFailure,
} from '../../bot/core.mjs';
import { heartbeat, checkHealth } from '../../bot/health.mjs';
import { validateServiceDocument } from '../../bot/config/validate.mjs';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bot-reliability-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.method(console, 'error', () => {});
  const config = {
    ...configFromEnv({
      TELEGRAM_BOT_TOKEN: '123456:secret_token_abcdefghijklmnopqrstuvwxyz',
      TELEGRAM_CHAT_ID: '@test',
      BOT_ALERT_CHAT_ID: '1',
      BOT_STATE_PATH: join(dir, 'state.json'),
      BOT_QUEUE_PATH: join(dir, 'posts.json'),
    }),
    logDir: dir,
  };
  await writeFile(
    config.queuePath,
    JSON.stringify([
      {
        id: 'post',
        title: 'One',
        summary: 'Thought',
        why: 'Reason',
        action: 'Try',
        url: 'https://example.com/test',
      },
    ]),
  );
  return { dir, config };
}
test('posting failure is flushed into journal before Telegram notification', async (t) => {
  const { dir, config } = await setup(t);
  let notices = 0;
  await publish(config, {
    manual: true,
    send: async () => {
      throw new TelegramRejection(429, 120);
    },
    notify: async () => {
      const lines = (await readFile(join(dir, 'errors.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.equal(lines.at(-1).reason, 'rate_limit');
      assert.equal(lines.at(-1).postId, 'post');
      notices++;
    },
  });
  assert.equal(notices, 1);
});
test('failures are logged with alerts disabled and do not expose credentials or URLs', async (t) => {
  const { dir, config } = await setup(t);
  config.alertChatId = '';
  await publish(config, {
    manual: true,
    send: async () => {
      throw new TelegramRejection(403);
    },
    notify: async () => assert.fail('disabled'),
  });
  const raw = await readFile(join(dir, 'errors.jsonl'), 'utf8');
  assert.match(raw, /token_or_permissions/);
  await logError(
    config,
    { reason: 'network' },
    new Error(`Bearer ${config.token} https://upload.example/private?access_key=secret`),
  );
  const logged = await readFile(join(dir, 'errors.jsonl'), 'utf8');
  assert.ok(!logged.includes(config.token));
  assert.ok(!logged.includes('access_key=secret'));
  assert.match(redact('vk1.a.abcdefghijklmnopqrstuvwxyz123456'), /REDACTED/);
});
test('disk failure uses stderr before alert and suppresses repeated fallback notifications', async (t) => {
  const { dir, config } = await setup(t);
  await writeFile(join(dir, 'not-directory'), 'x');
  config.statePath = join(dir, 'not-directory', 'state.json');
  config.logDir = join(dir, 'not-directory');
  let notices = 0;
  const notify = async () => {
    assert.ok(console.error.mock.calls.length > 0);
    notices++;
  };
  await reportRuntimeFailure(config, notify);
  await reportRuntimeFailure(config, notify);
  assert.equal(notices, 1);
});
test('atomic persistence leaves valid final state and no temporary files', async (t) => {
  const { dir } = await setup(t);
  const path = join(dir, 'atomic.json');
  await writeAtomic(path, { version: 1 });
  await writeAtomic(path, { version: 2 });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 2 });
  assert.ok(!(await readdir(dir)).some((p) => p.endsWith('.tmp')));
});
test('health check detects stale scheduler progress', async (t) => {
  const { dir } = await setup(t);
  const env = { BOT_HEARTBEAT_PATH: join(dir, 'heartbeat.json') };
  await heartbeat(env);
  await checkHealth(env);
  await assert.rejects(checkHealth(env, Date.now() + 601000), /stale/);
});
test('malformed service config produces diagnostics rather than crashing validator', () => {
  const result = validateServiceDocument(
    { version: 1, providers: { bad: null }, destinations: { bad: null }, projects: { bad: null } },
    { configPath: '/tmp/service.json' },
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 3);
});

test('Telegram alert rate limit is shared by independent projects', async (t) => {
  const { dir, config } = await setup(t);
  await assert.rejects(
    sendNotification(
      config,
      async () => {
        throw new TelegramRejection(429, 300);
      },
      'one',
      () => 300,
    ),
    TelegramRejection,
  );
  const other = { ...config, projectId: 'other', statePath: join(dir, 'other-state.json') };
  const result = await sendNotification(
    other,
    async () => assert.fail('must honor same bot cooldown'),
    'two',
    () => 300,
  );
  assert.ok(result.deferredUntil > Date.now() + 299000);
});

test('media retention removes only old sent covers and keeps pending delivery', async (t) => {
  const { config } = await setup(t);
  const old = {
    slot: 'old',
    postId: 'old',
    status: 'sent',
    image: { status: 'ready', text: 'old' },
    sentAt: '2026-08-01T00:00:00Z',
  };
  const pending = {
    slot: 'pending',
    postId: 'pending',
    status: 'retry_wait',
    image: { status: 'ready', text: 'pending' },
    html: 'pending',
    attempts: 0,
    retryAt: '2026-10-07T00:00:00Z',
  };
  await writeAtomic(config.statePath, {
    version: 1,
    chatId: config.chatId,
    entries: [old, pending],
    pauses: {},
    cooldowns: {},
  });
  const a = coverPath(config, 'old');
  const b = coverPath(config, 'pending');
  await mkdir(join(a, '..'), { recursive: true });
  await writeFile(a, 'cover');
  await writeFile(b, 'cover');
  await maintainMedia(config, Date.parse('2026-10-06T10:00:00Z'));
  await assert.rejects(readFile(a), { code: 'ENOENT' });
  assert.equal(await readFile(b, 'utf8'), 'cover');
});
