import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  collectMetrics,
  importCommerce,
  metricsReport,
  readAnalytics,
  validateCommerceImport,
} from '../../bot/metrics.mjs';
import { initializeCosts, recordGenerationCost, readGenerationCosts } from '../../bot/costs.mjs';
import { generatePost, GenerationFailure } from '../../bot/openrouter.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'poster-metrics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    projectId: 'group-a',
    vkGroupId: '123',
    vkEnabled: true,
    vkToken: 'test-secret',
    telegramEnabled: false,
    chatId: '',
    timezone: 'Europe/Moscow',
    metricsEnabled: true,
    metricsIntervalMinutes: 60,
    metricsPath: join(root, 'analytics.json'),
    costLedgerPath: join(root, 'generation-costs.jsonl'),
    statePath: join(root, 'state.json'),
  };
}
function commerce(config, metrics, overrides = {}) {
  return {
    version: 1,
    projectId: config.projectId,
    groupId: config.vkGroupId,
    currency: 'RUB',
    records: [
      { id: 'day-1', scope: 'group', from: '2026-10-06', to: '2026-10-06', metrics, ...overrides },
    ],
  };
}
const denied = async (url) => ({
  ok: true,
  json: async () =>
    url.endsWith('groups.getById')
      ? { response: { groups: [{ id: 123, members_count: 42 }] } }
      : {
          error: {
            error_code: 27,
            error_msg: 'Never persist arbitrary API messages or request params',
            request_params: [{ value: 'test-secret' }],
          },
        },
});

test('community-only snapshots retain unknown reach and cache unsupported methods', async (t) => {
  const config = await fixture(t);
  await writeFile(
    config.statePath,
    JSON.stringify({
      version: 1,
      chatId: '',
      vkGroupId: '123',
      entries: [
        {
          slot: 'manual:test',
          status: 'sent',
          platform: 'vk',
          postId: 'local-1',
          vkPostId: 9,
          vkGroupId: '123',
          vkText: 'Post',
          createdAt: '2026-10-06T08:00:00Z',
          generation: { cost: 0.001, model: 'test' },
        },
      ],
    }),
  );
  const calls = [];
  const fetchImpl = async (...args) => {
    calls.push(args[0]);
    return denied(...args);
  };
  const first = await collectMetrics(config, { now: new Date('2026-10-06T09:00:00Z'), fetchImpl });
  assert.equal(first.subscribers, 42);
  assert.equal(first.posts[0].reach, null);
  assert.equal(first.posts[0].views, null);
  assert.equal(first.capabilities['stats.get'].errorCode, 27);
  assert.equal(first.capabilities['wall.getById'].status, 'unavailable_with_community_key');
  assert.ok(!JSON.stringify(await readAnalytics(config)).includes('test-secret'));
  assert.equal(
    (await collectMetrics(config, { now: new Date('2026-10-06T09:30:00Z'), fetchImpl })).status,
    'not_due',
  );
  await collectMetrics(config, { now: new Date('2026-10-06T10:01:00Z'), fetchImpl });
  assert.equal(calls.filter((url) => url.endsWith('stats.get')).length, 1);
  assert.equal((await readGenerationCosts(config)).events.length, 1);
});

test('known-zero metrics stay zero while unknown revenue and average check stay null', async (t) => {
  const config = await fixture(t);
  await importCommerce(
    config,
    commerce(config, {
      productLinkClicks: 0,
      orders: 0,
      orderRevenue: 0,
      commissionRevenue: 0,
      otherExpenses: 0,
      generationExpensesRub: 0,
    }),
  );
  const result = await metricsReport(config, { from: '2026-10-06', to: '2026-10-06' });
  assert.equal(result.orders, 0);
  assert.equal(result.profit, 0);
  assert.equal(result.averageOrderValue, null);
  await importCommerce(
    config,
    commerce(config, {
      orders: null,
      orderRevenue: null,
      commissionRevenue: null,
      otherExpenses: 0,
      generationExpensesRub: 0,
    }),
  );
  const unknown = await metricsReport(config, { from: '2026-10-06', to: '2026-10-06' });
  assert.equal(unknown.orders, null);
  assert.equal(unknown.profit, null);
});

test('profit uses commission rather than gross order revenue and repeated import replaces its id', async (t) => {
  const config = await fixture(t);
  const input = commerce(config, {
    orders: 2,
    orderRevenue: 5.35,
    commissionRevenue: 1.5,
    otherExpenses: 0.2,
    generationExpensesRub: 0.3,
  });
  await importCommerce(config, input);
  await importCommerce(config, input);
  const result = await metricsReport(config, { from: '2026-10-06', to: '2026-10-06' });
  assert.equal(result.averageOrderValue, 2.68);
  assert.equal(result.profit, 1);
  assert.equal((await readAnalytics(config)).imports.length, 1);
  const revised = commerce(config, {
    orders: 2,
    orderRevenue: 5.35,
    commissionRevenue: 0.5,
    otherExpenses: 1,
    generationExpensesRub: 0.3,
  });
  await importCommerce(config, revised);
  assert.equal(
    (await metricsReport(config, { from: '2026-10-06', to: '2026-10-06' })).profit,
    -0.8,
  );
});

test('imports cannot cross group boundaries, overlap periods or mix post totals into group revenue', async (t) => {
  const config = await fixture(t);
  const input = commerce(config, { orders: 2, orderRevenue: 100 });
  assert.throws(() => validateCommerceImport({ ...input, groupId: '999' }, config));
  assert.throws(() => validateCommerceImport(commerce(config, { orders: 0.5 }), config));
  assert.throws(() =>
    validateCommerceImport(commerce(config, { orders: 0, orderRevenue: 5 }), config),
  );
  await importCommerce(config, input);
  await assert.rejects(
    importCommerce(config, commerce(config, { orders: 3 }, { id: 'overlap' })),
    /Overlapping/,
  );
  await importCommerce(
    config,
    commerce(
      config,
      { orders: 100, orderRevenue: 10000 },
      { id: 'post', scope: 'post', postId: 9 },
    ),
  );
  assert.equal((await metricsReport(config, { from: '2026-10-06', to: '2026-10-06' })).orders, 2);
  assert.equal(
    (await metricsReport(config, { from: '2026-10-06', to: '2026-10-07' })).orders,
    null,
  );
});

test('provider costs are deduplicated by job id and unknown costs prevent fabricated profit', async (t) => {
  const config = await fixture(t);
  await initializeCosts(config, new Date('2026-10-05T09:00:00Z'));
  await recordGenerationCost(config, {
    id: 'video-job',
    kind: 'video',
    usd: null,
    occurredAt: '2026-10-06T09:00:00Z',
  });
  await recordGenerationCost(config, {
    id: 'video-job',
    kind: 'video',
    usd: 0.2,
    occurredAt: '2026-10-06T09:00:00Z',
  });
  await recordGenerationCost(config, {
    id: 'text-1',
    usd: 0.01,
    occurredAt: '2026-10-06T09:00:00Z',
  });
  assert.equal((await readGenerationCosts(config)).events.length, 2);
  await importCommerce(
    config,
    commerce(config, {
      orders: 1,
      orderRevenue: 1000,
      commissionRevenue: 100,
      otherExpenses: 10,
      usdToRub: 100,
    }),
  );
  const result = await metricsReport(config, { from: '2026-10-06', to: '2026-10-06' });
  assert.equal(result.generationExpenses.totalUsd, 0.21);
  assert.equal(result.profit, 69);
  await recordGenerationCost(config, {
    id: 'lost-response',
    usd: null,
    occurredAt: '2026-10-06T09:00:00Z',
  });
  const incomplete = await metricsReport(config, { from: '2026-10-06', to: '2026-10-06' });
  assert.equal(incomplete.generationExpenses.knownProviderUsd, 0.21);
  assert.equal(incomplete.profit, null);
});

test('paid invalid generations still enter the cost ledger with their post id', async (t) => {
  const config = await fixture(t);
  const options = {
    id: 'invalid-post',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        id: 'response-1',
        model: 'test',
        usage: { cost: 0.012 },
        choices: [{ finish_reason: 'stop', message: { content: 'not json' } }],
      }),
    }),
  };
  await assert.rejects(
    generatePost(
      {
        ...config,
        contentMode: 'literary',
        openrouterKey: 'test',
        openrouterModel: 'test',
        openrouterPrompt: 'test',
      },
      options,
    ),
    GenerationFailure,
  );
  const events = (await readGenerationCosts(config)).events;
  assert.equal(events.length, 1);
  assert.equal(events[0].usd, 0.012);
  assert.equal(events[0].postId, 'invalid-post');
});

test('a network failure leaves billing unknown and does not store the secret', async (t) => {
  const config = await fixture(t);
  await assert.rejects(
    generatePost(
      { ...config, contentMode: 'literary', openrouterKey: 'test', openrouterModel: 'test' },
      {
        id: 'lost',
        fetchImpl: async () => {
          throw new Error('test-secret');
        },
      },
    ),
    GenerationFailure,
  );
  const costs = await readGenerationCosts(config);
  assert.equal(costs.events[0].usd, null);
  assert.equal(costs.events[0].outcome, 'network_unknown');
  assert.ok(!JSON.stringify(costs).includes('test-secret'));
});

test('analytics network failure records unknown values without changing publication state', async (t) => {
  const config = await fixture(t);
  const original = JSON.stringify({
    version: 1,
    chatId: '',
    vkGroupId: '123',
    entries: [],
    pauses: {},
    cooldowns: {},
  });
  await writeFile(config.statePath, original);
  await assert.rejects(
    collectMetrics(config, {
      now: new Date('2026-10-06T09:00:00Z'),
      fetchImpl: async () => {
        throw new Error('offline');
      },
    }),
  );
  const data = await readAnalytics(config);
  assert.equal(data.snapshots[0].subscribers, null);
  assert.equal(data.capabilities['groups.getById'].status, 'error');
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(config.statePath, 'utf8'), original);
});

test('analytics alerts explicitly say posting continues and use a separate incident file', async (t) => {
  const config = await fixture(t);
  const messages = [];
  const { reportRuntimeFailure } = await import('../../bot/core.mjs');
  await reportRuntimeFailure(
    { ...config, statePath: config.metricsPath, alertChatId: '1913596973' },
    async (_config, text) => messages.push(text),
    {
      reason: 'metrics_collection_failed',
      platform: 'vk',
      status: 'failed',
      postingContinues: true,
    },
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Публикации продолжаются/);
  assert.match(messages[0], /club123/);
});

test('even forced analytics honors a VK publication cooldown without API requests', async (t) => {
  const config = await fixture(t);
  const until = new Date(Date.now() + 3600000).toISOString();
  await writeFile(
    config.statePath,
    JSON.stringify({
      version: 1,
      chatId: '',
      vkGroupId: '123',
      entries: [],
      pauses: {},
      cooldowns: { vk: until },
    }),
  );
  const result = await collectMetrics(config, {
    force: true,
    fetchImpl: async () => assert.fail('cooldown applies to analytics'),
  });
  assert.equal(result.status, 'service_cooldown');
  assert.equal(result.retryAt, until);
});
