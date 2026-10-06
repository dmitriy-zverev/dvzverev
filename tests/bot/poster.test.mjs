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
  sendVk,
  formatVkPost,
  VkRejection,
  reportRuntimeFailure,
  clearRuntimeFailure,
  publicationBackoffSeconds,
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

const withVk = (config) => ({
  ...config,
  vkToken: 'vk-secret',
  vkGroupId: '242034586',
  alertChatId: 'owner',
});

test('publishes Telegram before VK and persists its receipt before VK I/O', async (t) => {
  const config = withVk(await setup(t));
  const calls = [];
  const result = await publish(config, {
    manual: true,
    send: async () => {
      calls.push('telegram');
      return 301;
    },
    sendVK: async (_, entry) => {
      calls.push('vk');
      const saved = (await readState(config)).entries[0];
      assert.equal(saved.messageId, 301);
      assert.equal(saved.platform, 'vk');
      assert.equal(saved.status, 'sending');
      assert.match(entry.vkText, /Code <review>/);
      return 10;
    },
  });
  assert.deepEqual(calls, ['telegram', 'vk']);
  assert.equal(result.status, 'sent');
  assert.equal(result.messageId, 301);
  assert.equal(result.vkPostId, 10);
  assert.equal((await publish(config, { manual: true })).status, 'empty');
});

test('VK retry after restart never republishes Telegram and reports each failed attempt only in Telegram', async (t) => {
  const config = withVk(await setup(t));
  let alerts = 0;
  const notify = async (cfg, html) => {
    assert.equal(cfg.chatId, 'owner');
    assert.match(html, /Площадка: vk/);
    alerts++;
  };
  const first = await publish(config, {
    manual: true,
    send: async () => 302,
    sendVK: async () => {
      throw new VkRejection(6);
    },
    notify,
  });
  assert.equal(first.status, 'retry_wait');
  await publish(config, { now: new Date(Date.parse(first.retryAt) - 1000), notify });
  assert.equal(alerts, 1);
  const result = await publish(config, {
    now: new Date(first.retryAt),
    send: async () => assert.fail('Telegram already sent'),
    sendVK: async () => 11,
    notify,
  });
  assert.equal(result.status, 'sent');
  assert.equal(result.messageId, 302);
  assert.equal(result.vkPostId, 11);
});

test('Telegram rejection prevents any VK publication and alerts temporary errors', async (t) => {
  const config = withVk(await setup(t));
  let alerts = 0;
  assert.equal(
    (
      await publish(config, {
        manual: true,
        send: async () => {
          throw new TelegramRejection(429, 60);
        },
        sendVK: async () => assert.fail('VK must wait'),
        notify: async () => {
          alerts++;
        },
      })
    ).status,
    'retry_wait',
  );
  assert.equal(alerts, 1);
});

test('VK permission failure pauses and resumes only VK', async (t) => {
  const config = withVk(await setup(t));
  const first = await publish(config, {
    manual: true,
    send: async () => 303,
    sendVK: async () => {
      throw new VkRejection(27);
    },
    notify: async () => {},
  });
  assert.equal(first.status, 'failed');
  assert.equal((await publish(config)).status, 'paused');
  await resume(config);
  const result = await publish(config, {
    send: async () => assert.fail('No Telegram repeat'),
    sendVK: async () => 12,
  });
  assert.equal(result.status, 'sent');
});

test('uncertain VK delivery requires operator review; retry and mark-sent affect only VK', async (t) => {
  const config = withVk(await setup(t));
  await publish(config, {
    manual: true,
    send: async () => 304,
    sendVK: async () => {
      throw new Error('timeout');
    },
    notify: async () => {},
  });
  assert.equal((await readState(config)).entries[0].status, 'uncertain');
  await resolvePost(config, post.id);
  await publish(config, {
    send: async () => assert.fail('No Telegram repeat'),
    sendVK: async () => {
      throw new Error('timeout');
    },
    notify: async () => {},
  });
  await resolvePost(config, post.id, 13);
  const entry = (await readState(config)).entries[0];
  assert.equal(entry.messageId, 304);
  assert.equal(entry.vkPostId, 13);
  assert.equal(entry.status, 'sent');
});

test('restart between Telegram and VK continues saved content without calling the provider', async (t) => {
  const config = withVk(await setup(t));
  await mkdir(join(config.statePath, '..'), { recursive: true });
  await writeFile(
    config.statePath,
    JSON.stringify({
      version: 1,
      chatId: config.chatId,
      entries: [
        {
          slot: 'old',
          postId: post.id,
          status: 'rejected',
          platform: 'vk',
          messageId: 305,
          vkText: formatVkPost(post),
          html: formatPost(post),
          vkGroupId: config.vkGroupId,
          attempts: 0,
        },
      ],
    }),
  );
  const result = await publish(config, {
    provider: async () => assert.fail('Use saved content'),
    send: async () => assert.fail('No Telegram repeat'),
    sendVK: async () => 14,
  });
  assert.equal(result.status, 'sent');
  assert.equal(result.messageId, 305);
});

test('VK transport sends plain text and credentials in POST body, sanitizes unknown responses', async () => {
  const config = withVk(configFromEnv());
  const entry = { vkGroupId: config.vkGroupId, vkText: formatVkPost(post), slot: 'slot-1' };
  assert.equal(
    await sendVk(config, entry, async (url, options) => {
      assert.equal(url, 'https://api.vk.com/method/wall.post');
      assert.equal(options.body.get('access_token'), 'vk-secret');
      assert.equal(options.body.get('owner_id'), '-242034586');
      assert.equal(options.body.get('from_group'), '1');
      assert.match(options.body.get('message'), /https:\/\/example.com/);
      return { ok: true, json: async () => ({ response: { post_id: 15 } }) };
    }),
    15,
  );
  await assert.rejects(
    sendVk(config, entry, async () => ({
      ok: true,
      json: async () => ({ error: { error_code: 6, request_params: ['vk-secret'] } }),
    })),
    VkRejection,
  );
  await assert.rejects(
    sendVk(config, entry, async () => {
      throw new Error('vk-secret');
    }),
    (error) => /uncertain/.test(error.message) && !error.message.includes('vk-secret'),
  );
  await assert.rejects(
    sendVk(config, entry, async () => ({ ok: false, json: async () => ({}) })),
    /uncertain/,
  );
});

test('old Telegram-only sent history does not cross-post retrospectively', async (t) => {
  const config = await setup(t);
  await publish(config, { manual: true, send: async () => 306 });
  assert.equal(
    (
      await publish(withVk(config), {
        manual: true,
        sendVK: async () => assert.fail('Do not cross-post history'),
      })
    ).status,
    'empty',
  );
});

test('corrupt delivery history produces one Telegram incident alert until recovery', async (t) => {
  const config = withVk(await setup(t));
  let alerts = 0;
  const notify = async (cfg) => {
    assert.equal(cfg.chatId, 'owner');
    alerts++;
  };
  await reportRuntimeFailure(config, notify);
  await reportRuntimeFailure(config, notify);
  assert.equal(alerts, 1);
  await clearRuntimeFailure(config);
  await reportRuntimeFailure(config, notify);
  assert.equal(alerts, 2);
});

test('crash during VK delivery never resends automatically', async (t) => {
  const config = withVk(await setup(t));
  await mkdir(join(config.statePath, '..'), { recursive: true });
  await writeFile(
    config.statePath,
    JSON.stringify({
      version: 1,
      chatId: config.chatId,
      entries: [
        {
          slot: 'old',
          postId: post.id,
          status: 'sending',
          platform: 'vk',
          messageId: 307,
          vkText: formatVkPost(post),
          html: formatPost(post),
          vkGroupId: config.vkGroupId,
          attempts: 1,
        },
      ],
    }),
  );
  assert.equal(
    (
      await publish(config, {
        manual: true,
        notify: async () => {},
        sendVK: async () => assert.fail('Must review VK first'),
      })
    ).status,
    'empty',
  );
  assert.equal((await readState(config)).entries[0].status, 'uncertain');
});

test('confirming uncertain Telegram receipt allows only the VK stage next', async (t) => {
  const config = withVk(await setup(t));
  await publish(config, {
    manual: true,
    send: async () => {
      throw new Error('timeout');
    },
    notify: async () => {},
  });
  await resolvePost(config, post.id, 308);
  const result = await publish(config, {
    send: async () => assert.fail('Confirmed Telegram'),
    sendVK: async () => 16,
  });
  assert.equal(result.messageId, 308);
  assert.equal(result.vkPostId, 16);
});

test('VK retries exhaust after three attempts without repeating Telegram', async (t) => {
  const config = withVk(await setup(t));
  let result = await publish(config, {
    manual: true,
    send: async () => 309,
    sendVK: async () => {
      throw new VkRejection(29);
    },
    notify: async () => {},
  });
  for (let i = 0; i < 2; i++)
    result = await publish(config, {
      now: new Date(result.retryAt),
      send: async () => assert.fail('No Telegram repeat'),
      sendVK: async () => {
        throw new VkRejection(29);
      },
      notify: async () => {},
    });
  assert.equal(result.status, 'exhausted');
  assert.equal(result.attempts, 3);
  assert.equal(result.messageId, 309);
});

test('VK authorization pause does not block new Telegram posts or duplicate pending IDs', async (t) => {
  const config = withVk(await setup(t, [post, { ...post, id: 'second' }]));
  const telegram = [];
  let vkCalls = 0;
  const send = async (_, html) => {
    telegram.push(html);
    return 400 + telegram.length;
  };
  await publish(config, {
    manual: true,
    send,
    sendVK: async () => {
      vkCalls++;
      throw new VkRejection(27);
    },
    notify: async () => {},
  });
  const second = await publish(config, {
    manual: true,
    send,
    sendVK: async () => assert.fail('VK paused'),
    notify: async () => {},
  });
  assert.equal(second.status, 'pending_vk');
  assert.equal(second.postId, 'second');
  assert.equal(telegram.length, 2);
  assert.equal(vkCalls, 1);
  assert.equal(
    (await publish(config, { manual: true, send, notify: async () => {} })).status,
    'empty',
  );
  assert.equal(telegram.length, 2);
  await resume(config, 'vk');
  const resumed = await publish(config, {
    send: async () => assert.fail('Do not duplicate Telegram'),
    sendVK: async () => 20,
  });
  assert.equal(resumed.postId, post.id);
  assert.equal(resumed.status, 'sent');
  assert.equal((await publish(config, { sendVK: async () => 21 })).postId, 'second');
});

test('VK cooldown permits Telegram and maintains oldest-first VK backlog', async (t) => {
  const config = withVk(await setup(t, [post, { ...post, id: 'second' }]));
  const now = new Date('2026-10-05T07:00:00Z');
  const first = await publish(config, {
    now,
    send: async () => 410,
    sendVK: async () => {
      throw new VkRejection(29);
    },
    notify: async () => {},
  });
  const second = await publish(config, {
    manual: true,
    now: new Date(now.getTime() + 1000),
    send: async () => 411,
    sendVK: async () => assert.fail('Honor VK cooldown'),
    notify: async () => {},
  });
  assert.equal(second.status, 'pending_vk');
  assert.equal(second.postId, 'second');
  const delivered = [];
  for (let i = 0; i < 2; i++)
    await publish(config, {
      now: new Date(first.retryAt),
      send: async () => assert.fail('Already sent Telegram'),
      sendVK: async (_, entry) => {
        delivered.push(entry.postId);
        return 22 + i;
      },
    });
  assert.deepEqual(delivered, [post.id, 'second']);
});

test('scheduled Telegram release proceeds while VK retry is pending', async (t) => {
  const config = withVk(await setup(t, [post, { ...post, id: 'second' }]));
  await publish(config, {
    now: new Date('2026-10-05T07:00:00Z'),
    send: async () => 420,
    sendVK: async () => {
      throw new VkRejection(6);
    },
    notify: async () => {},
  });
  const result = await publish(config, {
    now: new Date('2026-10-06T07:00:00Z'),
    send: async () => 421,
    sendVK: async () => assert.fail('Older VK release must go first'),
    notify: async () => {},
  });
  assert.equal(result.postId, 'second');
  assert.equal(result.status, 'pending_vk');
});

test('Telegram permission failure still permits previously confirmed VK backlog', async (t) => {
  const config = withVk(await setup(t, [post, { ...post, id: 'second' }]));
  const first = await publish(config, {
    manual: true,
    send: async () => 430,
    sendVK: async () => {
      throw new VkRejection(6);
    },
    notify: async () => {},
  });
  await publish(config, {
    manual: true,
    send: async () => {
      throw new TelegramRejection(403);
    },
    sendVK: async () => assert.fail('Second post lacks Telegram confirmation'),
    notify: async () => {},
  });
  const result = await publish(config, {
    now: new Date(first.retryAt),
    send: async () => assert.fail('Telegram paused'),
    sendVK: async () => 24,
    notify: async () => {},
  });
  assert.equal(result.status, 'sent');
  assert.equal(result.postId, post.id);
  assert.ok((await readState(config)).pauses.telegram);
  await resume(config, 'vk');
  assert.ok(
    (await readState(config)).pauses.telegram,
    'Targeted resume must not clear Telegram pause',
  );
});

test('invalid source queue does not block saved VK delivery', async (t) => {
  const config = withVk(await setup(t));
  const first = await publish(config, {
    manual: true,
    send: async () => 440,
    sendVK: async () => {
      throw new VkRejection(6);
    },
    notify: async () => {},
  });
  await writeFile(config.queuePath, '{');
  const result = await publish(config, {
    manual: true,
    now: new Date(first.retryAt),
    send: async () => assert.fail('Invalid queue'),
    sendVK: async () => 25,
    notify: async () => {},
  });
  assert.equal(result.status, 'sent');
  assert.ok((await readState(config)).pauses.queue);
});

test('partial VK configuration pauses only VK; correction resumes saved delivery', async (t) => {
  const base = await setup(t);
  const config = {
    ...base,
    ...configFromEnv({
      TELEGRAM_BOT_TOKEN: base.token,
      TELEGRAM_CHAT_ID: base.chatId,
      BOT_QUEUE_PATH: base.queuePath,
      BOT_STATE_PATH: base.statePath,
      VK_ACCESS_TOKEN: 'vk-secret',
    }),
    alertChatId: 'owner',
  };
  const first = await publish(config, {
    manual: true,
    send: async () => 450,
    sendVK: async () => assert.fail('VK invalid'),
    notify: async () => {},
  });
  assert.equal(first.status, 'pending_vk');
  assert.equal((await readState(config)).pauses.telegram, undefined);
  const corrected = { ...config, vkGroupId: '242034586', vkConfigError: false };
  await resume(corrected, 'vk');
  assert.equal(
    (
      await publish(corrected, {
        send: async () => assert.fail('Already Telegram'),
        sendVK: async () => 26,
      })
    ).status,
    'sent',
  );
});

test('VK destination mismatch is rejected without redirecting history or blocking Telegram', async (t) => {
  const config = withVk(await setup(t, [post, { ...post, id: 'second' }]));
  const first = await publish(config, {
    manual: true,
    send: async () => 460,
    sendVK: async () => {
      throw new VkRejection(6);
    },
    notify: async () => {},
  });
  const changed = { ...config, vkGroupId: '999' };
  const second = await publish(changed, {
    manual: true,
    send: async () => 461,
    sendVK: async () => assert.fail('Old VK stage first'),
    notify: async () => {},
  });
  assert.equal(second.status, 'pending_vk');
  const failed = await publish(changed, { now: new Date(first.retryAt), notify: async () => {} });
  assert.equal(failed.errorCode, 27);
  assert.equal((await readState(changed)).pauses.telegram, undefined);
});

test('an operator can resolve a failed second Telegram attempt despite old rejected history', async (t) => {
  const config = await setup(t);
  const send = async () => {
    throw new Error('timeout');
  };
  await publish(config, { manual: true, send });
  await resolvePost(config, post.id);
  await publish(config, { manual: true, send });
  await resolvePost(config, post.id, 470);
  assert.equal((await readState(config)).entries.at(-1).messageId, 470);
});

test('notification rate limit retries safely without resending posts or blocking VK', async (t) => {
  const config = withVk(await setup(t, [post, { ...post, id: 'second' }]));
  let calls = 0;
  const notify = async () => {
    calls++;
    if (calls === 1) throw new TelegramRejection(429, 60);
  };
  await publish(config, {
    manual: true,
    send: async () => 480,
    sendVK: async () => {
      throw new VkRejection(100);
    },
    notify,
  });
  const second = await publish(config, {
    manual: true,
    send: async () => 481,
    sendVK: async () => 27,
    notify,
  });
  assert.equal(second.status, 'sent');
  assert.equal(calls, 1);
  const state = await readState(config);
  state.entries[0].alertRetryAt = '2000-01-01T00:00:00Z';
  await writeFile(config.statePath, JSON.stringify(state));
  const later = Date.now() + 180000;
  t.mock.method(Date, 'now', () => later);
  await publish(config, { notify });
  assert.equal(calls, 2);
  assert.equal((await readState(config)).entries[0].alertStatus, 'sent');
});

test('legacy global VK pause migrates without blocking Telegram', async (t) => {
  const config = withVk(await setup(t));
  await mkdir(join(config.statePath, '..'), { recursive: true });
  await writeFile(
    config.statePath,
    JSON.stringify({
      version: 1,
      chatId: config.chatId,
      entries: [],
      paused: { platform: 'vk', reason: 'token_or_permissions', alertStatus: 'sent' },
    }),
  );
  const result = await publish(config, {
    manual: true,
    send: async () => 490,
    sendVK: async () => assert.fail('VK paused'),
  });
  assert.equal(result.status, 'pending_vk');
  const state = await readState(config);
  assert.ok(state.pauses.vk);
  assert.equal(state.pauses.telegram, undefined);
});

test('VK-only project sends no Telegram post and reloads its receipt', async (t) => {
  const config = {
    ...(await setup(t)),
    telegramEnabled: false,
    chatId: '',
    vkEnabled: true,
    vkToken: 'community-secret',
    vkGroupId: '194579254',
  };
  let telegramCalls = 0;
  const result = await publish(config, {
    manual: true,
    send: async () => {
      telegramCalls++;
    },
    sendVK: async (_config, entry) => {
      assert.match(entry.vkText, /Code/);
      return 42;
    },
  });
  assert.equal(result.status, 'sent');
  assert.equal(result.platform, 'vk');
  assert.equal(telegramCalls, 0);
  const state = await readState(config);
  assert.equal(state.entries[0].vkPostId, 42);
  assert.equal(state.pauses.telegram, undefined);
  const restart = await publish(config, {
    manual: true,
    sendVK: async () => {
      throw new Error('Duplicate');
    },
  });
  assert.equal(restart.status, 'empty');
});

test('VK-only temporary failure retries the saved post without generating another', async (t) => {
  const config = {
    ...(await setup(t)),
    telegramEnabled: false,
    chatId: '',
    vkEnabled: true,
    vkToken: 'community-secret',
    vkGroupId: '194579254',
    alertChatId: '1913596973',
  };
  let notices = 0;
  const failed = await publish(config, {
    manual: true,
    notify: async () => {
      notices++;
    },
    sendVK: async () => {
      throw new VkRejection(6);
    },
  });
  assert.equal(failed.status, 'retry_wait');
  assert.equal(notices, 1);
  const sent = await publish(config, {
    manual: true,
    now: new Date(failed.retryAt),
    provider: async () => {
      throw new Error('Do not generate');
    },
    sendVK: async () => 45,
    notify: async () => {},
  });
  assert.equal(sent.status, 'sent');
  assert.equal((await readState(config)).entries.length, 1);
});

test('GIF document attachments survive state reload', async (t) => {
  const config = await setup(t);
  await publish(config, { manual: true, send: async () => 9 });
  const state = await readState(config);
  state.entries[0].image = {
    status: 'ready',
    text: 'Cover',
    vk: { status: 'ready', attachment: 'doc-242034586_123456' },
  };
  await writeFile(config.statePath, JSON.stringify(state));
  assert.equal((await readState(config)).entries[0].image.vk.attachment, 'doc-242034586_123456');
});

test('publication backoff grows, adds positive jitter, caps and honors server minimum', () => {
  assert.equal(
    publicationBackoffSeconds(new TelegramRejection(503), 1, () => 0),
    60,
  );
  assert.equal(
    publicationBackoffSeconds(new TelegramRejection(503), 2, () => 0.5),
    135,
  );
  assert.equal(
    publicationBackoffSeconds(new TelegramRejection(429), 1, () => 0),
    120,
  );
  assert.equal(
    publicationBackoffSeconds(new VkRejection(6), 2, () => 0),
    240,
  );
  assert.equal(
    publicationBackoffSeconds(new VkRejection(9), 1, () => 0),
    900,
  );
  assert.equal(
    publicationBackoffSeconds(new VkRejection(29), 1, () => 0),
    3600,
  );
  assert.equal(
    publicationBackoffSeconds(new VkRejection(29), 21, () => 0.99),
    21600,
  );
  assert.equal(
    publicationBackoffSeconds(new TelegramRejection(429, 86400), 21, () => 0),
    86400,
  );
});

test('exhausted publication retains cooldown and failure streak across later posts', async (t) => {
  const config = await setup(t, [post, { ...post, id: 'second' }]);
  let now = new Date('2026-10-06T07:00:00Z');
  let calls = 0;
  const send = async () => {
    calls++;
    throw new TelegramRejection(429);
  };
  for (let i = 0; i < 3; i++) {
    const result = await publish(config, { manual: true, now, send, notify: async () => {} });
    assert.equal(result.status, i === 2 ? 'exhausted' : 'retry_wait');
    const state = await readState(config);
    assert.equal(state.deliveryFailureStreaks.telegram, i + 1);
    now = new Date(state.cooldowns.telegram);
  }
  await publish(config, {
    manual: true,
    now: new Date(now.getTime() - 1),
    send,
    notify: async () => {},
  });
  assert.equal(calls, 3);
  const next = await publish(config, { manual: true, now, send, notify: async () => {} });
  assert.equal(next.postId, 'second');
  assert.ok(Date.parse(next.retryAt) >= now.getTime() + 960000);
  assert.equal((await readState(config)).deliveryFailureStreaks.telegram, 4);
  await publish(config, {
    now: new Date(next.retryAt),
    send: async () => 99,
    notify: async () => {},
  });
  assert.equal((await readState(config)).deliveryFailureStreaks.telegram, 0);
});
