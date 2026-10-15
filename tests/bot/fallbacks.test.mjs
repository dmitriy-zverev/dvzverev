import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePost, GenerationFailure } from '../../bot/openrouter.mjs';
import { publish, readState, configFromEnv } from '../../bot/core.mjs';
const models = ['qwen/qwen3-32b', 'qwen/qwen3.5-flash-02-23', 'deepseek/deepseek-v4.1-flash'];
const paragraph =
  'Вечерний свет остался на подоконнике, хотя человек, который любил смотреть на него, давно уехал. Пальцы по привычке ищут знакомое письмо, оставленное между страницами книги. '.repeat(
    2,
  );
const valid = () => ({
  choices: [
    {
      finish_reason: 'stop',
      message: { content: JSON.stringify({ paragraphs: [paragraph, paragraph] }) },
    },
  ],
});
const config = {
  openrouterKey: 'secret',
  openrouterModel: models[0],
  openrouterModels: models,
  contentMode: 'literary',
  openrouterPrompt: 'Literary editorial',
};

test('text fallback retries each model three times before switching', async () => {
  const requests = [];
  const result = await generatePost({ ...config, maxAttempts: 3 }, {
    id: 'fallback',
    fetchImpl: async (_url, init) => {
      const model = JSON.parse(init.body).model;
      requests.push(model);
      if (model === models[2]) return { ok: true, json: async () => ({ ...valid(), model }) };
      return { ok: false, status: 503, json: async () => ({ error: { code: 503 } }) };
    },
  });
  assert.equal(requests.length, 7);
  assert.equal(requests.filter((model) => model === models[0]).length, 3);
  assert.equal(requests.filter((model) => model === models[1]).length, 3);
  assert.equal(requests.at(-1), models[2]);
  assert.equal(result.generation.model, models[2]);
});

test('shared authentication failure does not spend requests on fallback models', async () => {
  let calls = 0;
  await assert.rejects(
    generatePost(config, {
      id: 'auth',
      fetchImpl: async () => {
        calls++;
        return { ok: false, status: 401, json: async () => ({ error: { code: 401 } }) };
      },
    }),
    (error) => error.code === 401,
  );
  assert.equal(calls, 1);
});

test('scheduler retries each model three times before fallback, then publishes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'text-fallback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const c = {
    ...configFromEnv({ BOT_STATE_PATH: join(dir, 'state.json') }),
    ...config,
    postSource: 'openrouter',
    telegramEnabled: false,
    chatId: '',
    vkEnabled: true,
    vkToken: 'community',
    vkGroupId: '42',
  };
  const requested = [];
  const ids = [];
  let sends = 0;
  const publishOptions = (extra = {}) => ({
    manual: true,
    notify: async () => {},
    ...extra,
  });
  const options = publishOptions({
    sendVK: async () => {
      sends++;
      return 12;
    },
    generate: async (selected, { id }) => {
      requested.push(selected.openrouterModel);
      ids.push(id);
      assert.equal(selected.openrouterModels.length, 1);
      if (selected.openrouterModel === models[0])
        throw new GenerationFailure('api_rejected', { kind: 'configuration', code: 404 });
      if (selected.openrouterModel === models[1])
        throw new GenerationFailure('network_or_invalid_response');
      return {
        id,
        kind: 'literary',
        quoteId: 'austen-hope',
        commentary: paragraph + '\n\n' + paragraph,
        generation: { title: 'austen-hope', model: selected.openrouterModel },
      };
    },
  });
  let status = (await publish(c, options)).status;
  assert.equal(status, 'retry_wait');
  assert.equal((await readState(c)).pauses.openrouter, undefined);
  for (let i = 0; i < 8 && status !== 'sent'; i += 1) {
    const state = await readState(c);
    const when = state.pendingGeneration?.retryAt
      ? new Date(state.pendingGeneration.retryAt)
      : new Date(Date.now() + 60000);
    status = (await publish(c, publishOptions({ ...options, now: when }))).status;
  }
  assert.equal(status, 'sent');
  assert.equal(requested.filter((model) => model === models[0]).length, 3);
  assert.equal(requested.filter((model) => model === models[1]).length, 3);
  assert.equal(requested.at(-1), models[2]);
  assert.equal(new Set(ids).size, 1);
  assert.equal(sends, 1);
});
