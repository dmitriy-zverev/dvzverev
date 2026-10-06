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

test('text fallback handles API errors and invalid content, returning the third model', async () => {
  const requests = [];
  const result = await generatePost(config, {
    id: 'fallback',
    fetchImpl: async (_url, init) => {
      const model = JSON.parse(init.body).model;
      requests.push(model);
      if (requests.length === 1)
        return { ok: false, status: 503, json: async () => ({ error: { code: 503 } }) };
      if (requests.length === 2)
        return {
          ok: true,
          json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }),
        };
      return { ok: true, json: async () => ({ ...valid(), model }) };
    },
  });
  assert.deepEqual(requests, models);
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

test('scheduler saves one attempt per model, including model-specific configuration failure', async (t) => {
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
  const options = {
    manual: true,
    notify: async () => {},
    sendVK: async () => {
      sends++;
      return 12;
    },
    generate: async (selected, { id }) => {
      requested.push(selected.openrouterModel);
      ids.push(id);
      assert.equal(selected.openrouterModels.length, 1);
      if (requested.length === 1)
        throw new GenerationFailure('api_rejected', { kind: 'configuration', code: 404 });
      if (requested.length === 2) throw new GenerationFailure('network_or_invalid_response');
      return {
        id,
        kind: 'literary',
        quoteId: 'austen-hope',
        commentary: paragraph + '\n\n' + paragraph,
        generation: { title: 'austen-hope', model: selected.openrouterModel },
      };
    },
  };
  assert.equal((await publish(c, options)).status, 'retry_wait');
  assert.equal((await readState(c)).pauses.openrouter, undefined);
  assert.equal(
    (await publish(c, { ...options, now: new Date(Date.now() + 60000) })).status,
    'retry_wait',
  );
  assert.equal(
    (await publish(c, { ...options, now: new Date(Date.now() + 120000) })).status,
    'sent',
  );
  assert.deepEqual(requested, models);
  assert.equal(new Set(ids).size, 1);
  assert.equal(sends, 1);
});
