import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatPost, formatVkPost } from '../../bot/content.mjs';
import {
  parseFeed,
  canonicalUrl,
  dateSupported,
  generateDigest,
  readSource,
} from '../../bot/digest.mjs';

const now = new Date('2026-10-05T15:00:00Z');
const post = {
  id: 'digest',
  kind: 'digest',
  title: 'Новое в агентах',
  intro: 'Практика, инструменты и исследования.',
  items: Array.from({ length: 5 }, (_, i) => ({
    title: `Материал <${i}>`,
    teaser: 'Новый способ проверить изменения & отследить ошибки.',
    date: '2026-10-03',
    url: `https://${i < 3 ? 'github.blog' : 'anthropic.com'}/article-${i}/`,
  })),
};

test('digest renders 5–10 real links safely for Telegram and VK', () => {
  assert.match(formatPost(post), /&lt;0&gt;/);
  assert.match(formatPost(post), /href="https:\/\/github.blog\/article-0\/"/);
  assert.match(formatVkPost(post), /https:\/\/github.blog\/article-0\//);
  assert.ok(formatPost(post).startsWith('<b>Новое в агентах</b>\n\n'));
  assert.ok(
    formatPost(post).includes(
      '</b>\n\nНовый способ проверить изменения &amp; отследить ошибки.\n\n→ <a',
    ),
  );
  assert.match(formatPost(post), />Читать источник<\/a>/);
  assert.match(formatVkPost(post), /\n\n→ Читать источник: https:\/\/github.blog\/article-0\//);
  const marked = {
    ...post,
    items: post.items.map((item) => ({
      ...item,
      title: `Препринт: ${item.title}`,
      teaser: `Препринт: ${item.teaser}`,
    })),
  };
  assert.doesNotMatch(formatPost(marked), /Препринт:/i);
  assert.doesNotMatch(formatVkPost(marked), /Препринт:/i);
  assert.doesNotMatch(formatPost(post), /2026-10-03|Практика, инструменты|Что почитать|↗/);
  assert.throws(() => formatPost({ ...post, items: post.items.slice(0, 4) }));
  assert.throws(() => formatPost({ ...post, items: [...post.items.slice(0, 4), post.items[0]] }));
  assert.throws(() => formatPost({ ...post, title: 'x'.repeat(3900) }));
});

test('feed dates exclude stale and future entries and canonicalization excludes unsafe endpoints', () => {
  const xml =
    '<rss><item><title>Coding agent release</title><link>https://github.blog/agents/?utm_source=rss</link><pubDate>Sat, 03 Oct 2026 12:00:00 GMT</pubDate><description>' +
    'Specific agent workflow changes. '.repeat(10) +
    '</description></item><item><title>Old coding agents</title><link>https://github.blog/old/</link><pubDate>2025-01-01</pubDate></item></rss>';
  const sources = parseFeed(xml, now);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, 'https://github.blog/agents/');
  assert.deepEqual(sources[0].dates, ['2026-10-03']);
  assert.throws(() => canonicalUrl('https://127.0.0.1/admin'));
  assert.throws(() => canonicalUrl('https://github.blog.attacker.example/post'));
  assert.throws(() => canonicalUrl('https://user:pass@github.blog/post'));
  assert.throws(() => canonicalUrl('http://github.blog/post'));
});

test('dates must be present in publisher metadata or source text', () => {
  assert.equal(dateSupported({ dates: ['2026-10-03'], text: '' }, '2026-10-02'), false);
  assert.equal(dateSupported({ dates: [], text: 'Published Oct 3, 2026' }, '2026-10-03'), true);
  assert.equal(dateSupported({ dates: [], text: 'No publication date' }, '2026-10-03'), false);
});

test('redirect validation never fetches an arbitrary destination', async () => {
  let calls = 0;
  const result = await readSource({ url: 'https://github.blog/article' }, async () => {
    calls++;
    return { status: 302, headers: { get: () => 'http://127.0.0.1/admin' } };
  });
  assert.equal(result, null);
  assert.equal(calls, 1);
});

test('cached sources constrain digest URLs and recency without a second search', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'digest-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'digest-cache'));
  const sources = post.items.map((item) => ({
    url: item.url,
    title: item.title,
    dates: [item.date],
    text: 'Concrete original technical details.',
  }));
  await writeFile(
    join(dir, 'digest-cache/id.json'),
    JSON.stringify({ at: now.toISOString(), sources, cost: 0.001 }),
  );
  const items = post.items.map((item, source) => ({
    source,
    title: item.title,
    teaser: item.teaser,
    date: item.date,
  }));
  let returned = { title: post.title, insufficient: false, items };
  const fetchImpl = async (_, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.plugins, undefined);
    return {
      ok: true,
      json: async () => ({
        model: 'model',
        usage: { cost: 0.002 },
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(returned) } }],
      }),
    };
  };
  const config = {
    statePath: join(dir, 'state.json'),
    openrouterKey: 'key',
    openrouterModel: 'model',
  };
  const generated = await generateDigest(config, {
    id: 'id',
    now,
    fetchImpl,
    sourceFetch: () => assert.fail('Cache already loaded'),
  });
  assert.equal(generated.items.length, 5);
  assert.equal(generated.generation.cost, 0.003);
  returned = { ...returned, items: items.map((item, i) => (i ? item : { ...item, source: 999 })) };
  await assert.rejects(
    generateDigest(config, { id: 'id', now, fetchImpl }),
    (error) => error.reason === 'invalid_generated_digest',
  );
  returned = {
    ...returned,
    items: items.map((item, i) => (i ? item : { ...item, date: '2026-10-06' })),
  };
  await assert.rejects(
    generateDigest(config, { id: 'id', now, fetchImpl }),
    (error) => error.reason === 'invalid_generated_digest',
  );
});
