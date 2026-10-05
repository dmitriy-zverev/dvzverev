import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquireLock } from '../../bot/lock.mjs';
import { fileURLToPath } from 'node:url';
import {
  configFromEnv,
  dueSlot,
  formatPost,
  publish,
  readQueue,
  readState,
  sendTelegram,
  TelegramRejection,
  resume,
  resolvePost,
} from '../../bot/core.mjs';

const post = {
  id: 'article-1',
  title: 'Code <review>',
  summary: 'A & B',
  why: 'Проверить код',
  action: 'Написать тест',
  url: 'https://example.com/article?a=1&b=2',
};

test('CLI preview works without credentials and does not write state', async (t) => {
  const config = await setup(t);
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../../bot/run.mjs', import.meta.url)), '--dry-run'],
    {
      env: {
        ...process.env,
        TELEGRAM_BOT_TOKEN: '',
        TELEGRAM_CHAT_ID: '',
        BOT_QUEUE_PATH: config.queuePath,
        BOT_STATE_PATH: config.statePath,
      },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Что почитать вайбкодерам/);
  await assert.rejects(readFile(config.statePath), { code: 'ENOENT' });
});

async function setup(t, posts = [post]) {
  const dir = await mkdtemp(join(tmpdir(), 'dvzverev-bot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = configFromEnv({
    TELEGRAM_BOT_TOKEN: '123:secret',
    TELEGRAM_CHAT_ID: '@test',
    BOT_QUEUE_PATH: join(dir, 'posts.json'),
    BOT_STATE_PATH: join(dir, 'data/state.json'),
  });
  await writeFile(config.queuePath, JSON.stringify(posts));
  return config;
}

test('formats plain text safely and rejects unsafe URLs and oversized posts', () => {
  const html = formatPost(post);
  assert.match(html, /Code &lt;review&gt;/);
  assert.match(html, /A &amp; B/);
  assert.match(html, /a=1&amp;b=2/);
  assert.throws(() => formatPost({ ...post, url: 'javascript:alert(1)' }));
  assert.throws(() => formatPost({ ...post, url: 'https://user:pass@example.com' }));
  assert.throws(() => formatPost({ ...post, summary: 'x'.repeat(4096) }));
});

test('schedule uses Moscow time, handles date rollover, and skips missed windows', () => {
  const config = configFromEnv({ BOT_TIMES: '00:00,10:00' });
  assert.match(dueSlot(config, new Date('2026-10-04T21:01:00Z')), /^2026-10-05@00:00/);
  assert.match(dueSlot(config, new Date('2026-10-05T07:04:59Z')), /@10:00/);
  assert.equal(dueSlot(config, new Date('2026-10-05T07:05:00Z')), null);
  assert.equal(dueSlot(config, new Date('2026-10-05T06:59:59Z')), null);
  assert.throws(() => configFromEnv({ BOT_TIMES: '25:00' }));
});

test('queue rejects duplicate identifiers before publishing', async (t) => {
  const config = await setup(t, [post, post]);
  await assert.rejects(readQueue(config.queuePath), /Duplicate post ID/);
});

test('persists sending before delivery, preserves message ID, and never repeats a post', async (t) => {
  const config = await setup(t);
  const now = new Date('2026-10-05T07:00:00Z');
  let calls = 0;
  const send = async () => {
    calls++;
    assert.equal((await readState(config)).entries[0].status, 'sending');
    return 42;
  };
  assert.equal((await publish(config, { now, send })).status, 'sent');
  assert.equal((await publish(config, { now, send })).status, 'already_processed');
  assert.equal((await publish(config, { manual: true, send })).status, 'empty');
  assert.equal(calls, 1);
  assert.equal((await readState(config)).entries[0].messageId, 42);
});

test('uncertain delivery blocks retry even at the next scheduled time', async (t) => {
  const config = await setup(t);
  let calls = 0;
  const send = async () => {
    calls++;
    throw new Error('Timeout');
  };
  assert.equal((await publish(config, { manual: true, send })).status, 'uncertain');
  assert.equal((await publish(config, { manual: true, send })).status, 'empty');
  assert.equal(calls, 1);
});

test('permission rejection pauses all sends until explicit resume', async (t) => {
  const config = await setup(t);
  assert.equal(
    (
      await publish(config, {
        manual: true,
        send: async () => {
          throw new TelegramRejection(403);
        },
      })
    ).status,
    'failed',
  );
  assert.equal(
    (await publish(config, { manual: true, send: async () => assert.fail('Paused') })).status,
    'paused',
  );
  await resume(config);
  assert.equal((await publish(config, { manual: true, send: async () => 43 })).status, 'sent');
});

test('concurrent workers cannot both send', async (t) => {
  const config = await setup(t);
  let release;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const pending = publish(config, {
    manual: true,
    send: async () => {
      entered();
      await new Promise((resolve) => {
        release = resolve;
      });
      return 44;
    },
  });
  await started;
  assert.equal((await publish(config, { manual: true })).status, 'locked');
  release();
  assert.equal((await pending).status, 'sent');
});

test('crash record and corrupt state fail closed', async (t) => {
  const config = await setup(t);
  await mkdir(join(config.statePath, '..'), { recursive: true });
  await writeFile(
    config.statePath,
    JSON.stringify({
      version: 1,
      chatId: config.chatId,
      entries: [{ slot: 'old', status: 'sending', postId: post.id }],
    }),
  );
  assert.equal((await publish(config, { manual: true })).status, 'empty');
  await writeFile(config.statePath, '{');
  await assert.rejects(publish(config, { manual: true }));
  await writeFile(config.statePath, JSON.stringify({ version: 1, chatId: '@other', entries: [] }));
  await assert.rejects(readState(config), /another channel/);
});

test('Telegram request uses HTML, disables previews, and hides credentials in failures', async () => {
  const config = configFromEnv({ TELEGRAM_BOT_TOKEN: '123:secret', TELEGRAM_CHAT_ID: '@test' });
  const messageId = await sendTelegram(config, formatPost(post), async (url, options) => {
    assert.equal(url, 'https://api.telegram.org/bot123:secret/sendMessage');
    const body = JSON.parse(options.body);
    assert.equal(body.chat_id, '@test');
    assert.equal(body.parse_mode, 'HTML');
    assert.equal(body.link_preview_options.is_disabled, true);
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 45 } }) };
  });
  assert.equal(messageId, 45);
  await assert.rejects(
    sendTelegram(config, '', async () => {
      throw new Error('123:secret');
    }),
    (error) => !error.message.includes('secret') && /uncertain/.test(error.message),
  );
  await assert.rejects(
    sendTelegram(config, '', async () => ({
      ok: false,
      json: async () => ({ ok: false, error_code: 429 }),
    })),
    TelegramRejection,
    resume,
    resolvePost,
  );
});

test('empty queue records the slot without sending or creating placeholder content', async (t) => {
  const config = await setup(t, []);
  const result = await publish(config, {
    manual: true,
    send: async () => assert.fail('Must not send'),
  });
  assert.equal(result.status, 'empty');
  assert.equal(JSON.parse(await readFile(config.statePath, 'utf8')).entries[0].status, 'empty');
});

test('rate limits obey retry_after, survive restart, and stop at three attempts', async (t) => {
  const config = await setup(t);
  const now = new Date('2026-10-05T07:00:00Z');
  let calls = 0;
  const send = async () => {
    calls++;
    throw new TelegramRejection(429, 120);
  };
  const first = await publish(config, { now, send });
  assert.equal(first.status, 'retry_wait');
  assert.ok(Date.parse(first.retryAt) >= now.getTime() + 120_000);
  assert.equal(
    (await publish(config, { now: new Date(now.getTime() + 60_000), send })).status,
    'retry_wait',
  );
  assert.equal(calls, 1);
  const second = await publish(config, { now: new Date(first.retryAt), send });
  assert.equal(second.attempts, 2);
  const third = await publish(config, { now: new Date(second.retryAt), send });
  assert.equal(third.status, 'exhausted');
  assert.equal(third.attempts, 3);
  assert.equal((await publish(config, { manual: true, send })).status, 'empty');
  assert.equal(calls, 3);
});

test('an explicit temporary API rejection retries, malformed HTTP 500 stays uncertain', async (t) => {
  const config = await setup(t);
  const first = await publish(config, {
    manual: true,
    send: async () => {
      throw new TelegramRejection(503);
    },
  });
  assert.equal(first.status, 'retry_wait');
  assert.equal(
    (await publish(config, { now: new Date(first.retryAt), send: async () => 99 })).status,
    'sent',
  );
  await assert.rejects(
    sendTelegram(config, '', async () => ({ ok: false, json: async () => ({}) })),
    /uncertain/,
  );
});

test('bad content is quarantined, allowing a valid post at the next slot', async (t) => {
  const config = await setup(t, [
    { ...post, summary: '' },
    { ...post, id: 'good' },
  ]);
  assert.equal(
    (await publish(config, { manual: true, send: async () => assert.fail('Bad post') })).status,
    'failed',
  );
  assert.equal((await publish(config, { manual: true, send: async () => 100 })).postId, 'good');
});

test('broken queue pauses without exiting, then resumes after correction', async (t) => {
  const config = await setup(t);
  await writeFile(config.queuePath, '{');
  assert.equal((await publish(config, { manual: true })).reason, 'invalid_queue');
  await writeFile(config.queuePath, JSON.stringify([post]));
  assert.equal((await publish(config, { manual: true })).status, 'paused');
  await resume(config);
  assert.equal((await publish(config, { manual: true, send: async () => 101 })).status, 'sent');
});

test('owner gets one permission alert, even after repeated scheduler checks', async (t) => {
  const config = { ...(await setup(t)), alertChatId: 'owner' };
  let alerts = 0;
  const notify = async (alertConfig, html) => {
    alerts++;
    assert.equal(alertConfig.chatId, 'owner');
    assert.match(html, /token_or_permissions/);
    assert.ok(!html.includes(config.token));
    return 123;
  };
  await publish(config, {
    manual: true,
    send: async () => {
      throw new TelegramRejection(401);
    },
    notify,
  });
  await publish(config, { manual: true, notify });
  await publish(config, { manual: true, notify });
  assert.equal(alerts, 1);
});

test('notification failure never resends the post or spams the owner', async (t) => {
  const config = { ...(await setup(t)), alertChatId: 'owner' };
  let alerts = 0;
  const notify = async () => {
    alerts++;
    throw new Error('offline');
  };
  await publish(config, {
    manual: true,
    send: async () => {
      throw new Error('offline');
    },
    notify,
  });
  await publish(config, { manual: true, notify });
  assert.equal(alerts, 1);
  assert.equal((await readState(config)).entries[0].alertStatus, 'failed');
});

test('kernel lock is recovered automatically after a sender is killed', async (t) => {
  const config = await setup(t);
  await mkdir(join(config.statePath, '..'), { recursive: true });
  const lockPath = `${config.statePath}.lock`;
  const moduleUrl = new URL('../../bot/lock.mjs', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {acquireLock} from ${JSON.stringify(moduleUrl)}; await acquireLock(${JSON.stringify(lockPath)}); console.log('READY'); setInterval(()=>{},1000);`,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('error', reject);
  });
  assert.equal(await acquireLock(lockPath), null);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  let release;
  for (let attempt = 0; attempt < 20 && !release; attempt++) {
    release = await acquireLock(lockPath);
    if (!release) await sleep(10);
  }
  assert.ok(release, 'Crash must release the kernel lock');
  await release();
});

test('operator can mark uncertain delivery sent without any resend', async (t) => {
  const config = await setup(t);
  await publish(config, {
    manual: true,
    send: async () => {
      throw new Error('timeout');
    },
  });
  assert.equal((await resolvePost(config, post.id, 200)).status, 'marked_sent');
  assert.equal(
    (await publish(config, { manual: true, send: async () => assert.fail('No resend') })).status,
    'empty',
  );
  await assert.rejects(resolvePost(config, post.id), /already sent/);
});

test('operator can release a corrected post after the channel was checked', async (t) => {
  const config = await setup(t);
  await publish(config, {
    manual: true,
    send: async () => {
      throw new Error('timeout');
    },
  });
  await resolvePost(config, post.id);
  assert.equal((await publish(config, { manual: true, send: async () => 201 })).status, 'sent');
});
