import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePost, GenerationFailure } from '../../bot/openrouter.mjs';
import { formatPost, formatVkPost } from '../../bot/content.mjs';

const cfg = { contentMode: 'lifestyle', openrouterKey: 'test', openrouterModel: 'test-model',
  openrouterPrompt: 'Редакция Вещи Кстати.' };
const content = { theme: 'Провода на столе', paragraphs: [
  'Кабель снова оказался под столом, хотя ещё минуту назад лежал рядом.',
  'Для таких мелочей можно выделить небольшой лоток. Меньше поисков — спокойнее утро.',
] };
const response = (value, finish = 'stop') => ({ ok: true, json: async () => ({
  model: 'test-model', choices: [{ finish_reason: finish, message: { content: JSON.stringify(value) } }],
}) });
const reviewed = (value, init) => JSON.parse(init.body).response_format.json_schema.name === 'lifestyle_review'
  ? response({ approved: true, reason: '' }) : response(value);

test('lifestyle uses community prompt and formats only editorial text without tip headings', async () => {
  const post = await generatePost(cfg, { id: 'things', history: ['old'], fetchImpl: async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.response_format.json_schema.name === 'lifestyle_review')
      return response({ approved: true, reason: '' });
    assert.match(request.messages[0].content, /карточек товаров.*нет/);
    assert.match(request.messages[1].content, /маленькая проблема/);
    return response(content);
  } });
  assert.equal(post.kind, 'lifestyle');
  assert.equal(formatVkPost(post), content.paragraphs.join('\n\n'));
  assert.equal(formatPost(post), formatVkPost(post));
  assert.equal(post.generation.title, content.theme);
  assert.ok(!formatVkPost(post).includes('Вайбкодинг'));
});

test('lifestyle rejects invented prices, medical claims, links, markup and exact repeats', async () => {
  for (const text of ['Цена 999 руб.', 'Гипоаллергенный материал.', 'https://shop.test/item',
    '#покупки', '**Купите**', 'Мы испытали этот товар.']) {
    await assert.rejects(generatePost(cfg, { id: 'bad', fetchImpl: async () =>
      response({ ...content, paragraphs: [content.paragraphs[0], text] }) }), GenerationFailure);
  }
  await assert.rejects(generatePost(cfg, { id: 'repeat', historyPosts: [content.paragraphs.join('\n\n')],
    fetchImpl: async () => response(content) }), GenerationFailure);
  await assert.rejects(generatePost(cfg, { id: 'cut', fetchImpl: async () => response(content, 'length') }), GenerationFailure);
});

test('lifestyle keeps fallback chain when the primary model returns unsafe content', async () => {
  const models = [];
  const post = await generatePost({ ...cfg, openrouterModels: ['primary', 'backup'] }, {
    id: 'fallback', fetchImpl: async (_url, init) => {
      const model = JSON.parse(init.body).model; models.push(model);
      return reviewed(model === 'primary' ? { ...content, paragraphs: ['Цена 99 руб.', 'Купите.'] } : content, init);
    },
  });
  assert.deepEqual(models, ['primary', 'backup', 'backup']);
  assert.equal(post.kind, 'lifestyle');
});

test('lifestyle blocks a structurally valid post rejected by the editorial reviewer', async () => {
  await assert.rejects(generatePost(cfg, { id: 'review', fetchImpl: async (_url, init) =>
    JSON.parse(init.body).response_format.json_schema.name === 'lifestyle_review'
      ? response({ approved: false, reason: 'Непрактичная рекомендация' }) : response(content),
  }), error => error.reason === 'lifestyle_editorial_review_failed');
});
