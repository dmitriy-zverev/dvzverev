import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { generatePost, GenerationFailure, DEFAULT_MODEL } from '../../bot/openrouter.mjs';
import {
  formatPost,
  formatVkPost,
  configFromEnv,
  publish,
  readState,
  resume,
  VkRejection,
} from '../../bot/core.mjs';

function content() {
  const result = {
    title: 'Одна задача за раз',
    summary: 'Проверяй изменения небольшими порциями.',
    why: 'Так проще найти ошибку.',
    action: 'Добавь тест.',
  };
  const length = [...formatVkPost({ id: 'a', kind: 'tip', ...result })].length;
  result.summary += 'x'.repeat(500 - length);
  return result;
}
const response = (result = content()) => ({
  ok: true,
  json: async () => ({
    model: DEFAULT_MODEL,
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }],
    usage: { cost: 0.0003 },
  }),
});

test('OpenRouter request uses bounded structured output and verifies 500 visible characters', async () => {
  const post = await generatePost(
    { openrouterKey: 'private-key' },
    {
      id: 'post',
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
        assert.equal(options.headers.Authorization, 'Bearer private-key');
        const body = JSON.parse(options.body);
        assert.equal(body.model, DEFAULT_MODEL);
        assert.equal(body.max_tokens, 700);
        assert.equal(body.response_format.json_schema.strict, true);
        assert.equal(body.provider.require_parameters, true);
        assert.ok(options.signal);
        return response();
      },
    },
  );
  assert.equal(post.generation.characters, 500);
  assert.equal(post.generation.cost, 0.0003);
  assert.equal(post.kind, 'tip');
  assert.equal(post.url, undefined);
  assert.ok(!formatPost(post).includes('Читать оригинал'));
  assert.ok(!formatVkPost(post).includes('https://'));
});

test('rejects invalid JSON, missing fields, overlong posts, refusal and truncated output', async () => {
  const invalid = [
    response({ ...content(), summary: 'x'.repeat(1000) }),
    response({ ...content(), action: '' }),
    {
      ok: true,
      json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }),
    },
    {
      ok: true,
      json: async () => ({
        choices: [{ finish_reason: 'stop', message: { content: 'not-json' } }],
      }),
    },
    {
      ok: true,
      json: async () => ({ choices: [{ finish_reason: 'stop', message: { refusal: 'No' } }] }),
    },
  ];
  for (const res of invalid)
    await assert.rejects(
      generatePost({ openrouterKey: 'key' }, { id: 'a', fetchImpl: async () => res }),
      (error) => error instanceof GenerationFailure && error.reason === 'invalid_generated_post',
    );
});

test('OpenRouter API failures hide secrets and classify billing versus temporary errors', async () => {
  await assert.rejects(
    generatePost(
      { openrouterKey: 'private-key' },
      {
        id: 'a',
        fetchImpl: async () => {
          throw new Error('private-key');
        },
      },
    ),
    (error) =>
      error.reason === 'network_or_invalid_response' && !error.message.includes('private-key'),
  );
  await assert.rejects(
    generatePost(
      { openrouterKey: 'key' },
      {
        id: 'a',
        fetchImpl: async () => ({
          ok: false,
          status: 402,
          json: async () => ({ error: { code: 402, message: 'private-key' } }),
        }),
      },
    ),
    (error) =>
      error.kind === 'configuration' &&
      error.code === 402 &&
      !error.message.includes('private-key'),
  );
  await assert.rejects(
    generatePost(
      { openrouterKey: 'key' },
      {
        id: 'a',
        fetchImpl: async () => ({
          ok: false,
          status: 429,
          headers: { get: () => '120' },
          json: async () => ({ error: { code: 429 } }),
        }),
      },
    ),
    (error) => error.kind === 'temporary' && error.retryAfter === 120,
  );
});

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dvzverev-openrouter-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return configFromEnv({
    BOT_POST_SOURCE: 'openrouter',
    OPENROUTER_API_KEY: 'key',
    TELEGRAM_BOT_TOKEN: '123:key',
    TELEGRAM_CHAT_ID: '@test',
    BOT_ALERT_CHAT_ID: 'owner',
    VK_ACCESS_TOKEN: 'key',
    VK_GROUP_ID: '242034586',
    BOT_STATE_PATH: join(dir, 'data/state.json'),
    BOT_QUEUE_PATH: join(dir, 'unused.json'),
  });
}
const generate = async (_, { id }) => ({
  id,
  kind: 'tip',
  ...content(),
  generation: { model: DEFAULT_MODEL, characters: 500, cost: 0.0003, title: 'Одна задача за раз' },
});

test('generated content persists before Telegram; VK retry never generates or publishes Telegram again', async (t) => {
  const config = await setup(t);
  let calls = 0;
  const first = await publish(config, {
    manual: true,
    generate: async (...args) => {
      calls++;
      return generate(...args);
    },
    send: async () => {
      const state = await readState(config);
      assert.equal(state.pendingGeneration, undefined);
      assert.ok(state.entries[0].html);
      return 501;
    },
    sendVK: async () => {
      throw new VkRejection(6);
    },
    notify: async () => {},
  });
  await publish(config, {
    now: new Date(first.retryAt),
    generate: async () => assert.fail('No regeneration'),
    send: async () => assert.fail('No Telegram repeat'),
    sendVK: async () => 30,
  });
  assert.equal(calls, 1);
  assert.equal((await readState(config)).entries[0].vkPostId, 30);
});

test('generation retry persists, respects delay and regenerates safely after restart', async (t) => {
  const config = await setup(t);
  let calls = 0;
  const first = await publish(config, {
    manual: true,
    generate: async () => {
      calls++;
      throw new GenerationFailure('network_or_invalid_response', { retryAfter: 120 });
    },
    notify: async () => {},
  });
  assert.equal(first.status, 'retry_wait');
  assert.equal(first.platform, 'openrouter');
  await publish(config, {
    now: new Date(Date.parse(first.retryAt) - 1000),
    generate: async () => assert.fail('Too early'),
  });
  const result = await publish(config, {
    now: new Date(first.retryAt),
    generate: async (...args) => {
      calls++;
      return generate(...args);
    },
    send: async () => 502,
    sendVK: async () => 31,
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 'sent');
});

test('invalid generation exhausts after three calls without publishing; next slot can generate', async (t) => {
  const config = await setup(t);
  let calls = 0;
  const fail = async () => {
    calls++;
    throw new GenerationFailure('invalid_generated_post');
  };
  let result = await publish(config, {
    now: new Date('2026-10-05T07:00:00Z'),
    generate: fail,
    notify: async () => {},
  });
  for (let i = 0; i < 2; i++)
    result = await publish(config, {
      now: new Date(result.retryAt),
      generate: fail,
      notify: async () => {},
    });
  assert.equal(result.status, 'exhausted');
  assert.equal(calls, 3);
  const next = await publish(config, {
    now: new Date('2026-10-06T07:00:00Z'),
    generate,
    send: async () => 503,
    sendVK: async () => 32,
  });
  assert.equal(next.status, 'sent');
});

test('OpenRouter billing pause does not block saved VK backlog and targeted resume restores generation', async (t) => {
  const config = await setup(t);
  const first = await publish(config, {
    manual: true,
    generate,
    send: async () => 504,
    sendVK: async () => {
      throw new VkRejection(6);
    },
    notify: async () => {},
  });
  await publish(config, {
    manual: true,
    generate: async () => {
      throw new GenerationFailure('api_rejected', { code: 402, kind: 'configuration' });
    },
    notify: async () => {},
  });
  const resumed = await publish(config, {
    now: new Date(first.retryAt),
    generate: async () => assert.fail('OpenRouter paused'),
    sendVK: async () => 33,
  });
  assert.equal(resumed.status, 'sent');
  assert.ok((await readState(config)).pauses.openrouter);
  await resume(config, 'openrouter');
  assert.equal(
    (
      await publish(config, {
        now: new Date(Math.max(Date.now(), Date.parse(first.retryAt))),
        generate,
        send: async () => 505,
        sendVK: async () => 34,
      })
    ).status,
    'sent',
  );
});

test('generation crash respects persisted attempt limit', async (t) => {
  const config = await setup(t);
  await mkdir(dirname(config.statePath), { recursive: true });
  await writeFile(
    config.statePath,
    JSON.stringify({
      version: 1,
      chatId: config.chatId,
      entries: [],
      pendingGeneration: {
        id: 'crashed',
        slot: 'old',
        status: 'generating',
        attempts: 3,
        errors: [],
      },
    }),
  );
  const result = await publish(config, {
    generate: async () => assert.fail('Do not exceed cost bound'),
    notify: async () => {},
  });
  assert.equal(result.status, 'exhausted');
});

test('a crash after saving generated content continues Telegram without another LLM request', async (t) => {
  const config = await setup(t);
  await mkdir(dirname(config.statePath), { recursive: true });
  const post = await generate(config, { id: 'saved' });
  await writeFile(
    config.statePath,
    JSON.stringify({
      version: 1,
      chatId: config.chatId,
      entries: [
        {
          postId: post.id,
          slot: 'old',
          status: 'retry_wait',
          platform: 'telegram',
          attempts: 0,
          retryAt: '2000-01-01T00:00:00Z',
          html: formatPost(post),
          vkText: formatVkPost(post),
          vkGroupId: config.vkGroupId,
          generation: post.generation,
        },
      ],
    }),
  );
  const result = await publish(config, {
    generate: async () => assert.fail('Content already saved'),
    send: async () => 506,
    sendVK: async () => 35,
  });
  assert.equal(result.status, 'sent');
  assert.equal(JSON.parse(await readFile(config.statePath, 'utf8')).entries[0].messageId, 506);
});
