import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePost, GenerationFailure } from '../../bot/openrouter.mjs';
import { formatVkPost } from '../../bot/content.mjs';
import { LITERARY_QUOTES, selectLiteraryQuote } from '../../bot/literary-quotes.mjs';

const commentary =
  'Иногда знакомый голос остаётся в комнате дольше самого человека. Ты закрываешь книгу и замечаешь, что тишина уже научилась произносить его имя. '.repeat(
    4,
  );
const config = {
  contentMode: 'literary',
  openrouterKey: 'test',
  openrouterPrompt: 'Dark academia',
  openrouterModel: 'test',
};
const reply = (result) => async () => ({
  ok: true,
  json: async () => ({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }],
    usage: { cost: 0.001 },
  }),
});

test('literary generation keeps the quote and attribution outside model control', async () => {
  const post = await generatePost(config, {
    id: 'literary-1',
    excludeQuoteIds: [LITERARY_QUOTES[0].id],
    fetchImpl: reply({ paragraphs: [commentary.slice(0, 200), commentary.slice(200)] }),
  });
  assert.equal(post.quoteId, 'austen-hope');
  const text = formatVkPost(post);
  assert.match(text, /Джейн Остин — «Доводы рассудка» \(перевод редакции\)/);
  assert.ok(text.startsWith('«' + LITERARY_QUOTES.find((quote) => quote.id === post.quoteId).text));
  assert.equal(post.generation.cost, 0.001);
});

test('literary generation rejects invented attribution and empty paragraphs', async () => {
  for (const result of [
    { paragraphs: [commentary, commentary], author: 'Invented' },
    { paragraphs: ['   ', 'Непустой абзац'] },
  ]) {
    await assert.rejects(
      generatePost(config, { id: 'x', fetchImpl: reply(result) }),
      GenerationFailure,
    );
  }
  assert.throws(() => formatVkPost({ id: 'x', kind: 'literary', quoteId: 'invented', commentary }));
});

test('quote selection alternates traditions and avoids recently used works', () => {
  const history = [];
  for (let index = 0; index < 12; index++) {
    const quote = selectLiteraryQuote(history);
    assert.equal(quote.tradition || 'russian', index % 2 ? 'foreign' : 'russian');
    const recent = history
      .slice(-4)
      .map((id) => LITERARY_QUOTES.find((item) => item.id === id).work);
    assert.ok(!recent.includes(quote.work));
    assert.ok(quote.text.split(/\s+/).length <= 25);
    history.push(quote.id);
  }
});

test('literary length is a prompt guideline and never rejects a complete response', async () => {
  for (const paragraphs of [
    ['Книга закрыта.', 'Разговор ещё продолжается.'],
    [commentary.repeat(3), 'Осталось перевернуть страницу.'],
  ]) {
    let request;
    const post = await generatePost(config, {
      id: 'flexible-length',
      feedback: 'invalid_generated_literary_post',
      fetchImpl: async (_url, options) => {
        request = JSON.parse(options.body);
        return reply({ paragraphs })();
      },
    });
    assert.equal(post.commentary, paragraphs.map((paragraph) => paragraph.trim()).join('\n\n'));
    assert.ok(formatVkPost(post).endsWith(post.commentary));
    assert.match(request.messages[0].content, /примерно 500 символов/);
    assert.doesNotMatch(
      request.messages.map((message) => message.content).join(' '),
      /500–1000|650–800/,
    );
  }
  assert.throws(() =>
    formatVkPost({
      id: 'empty',
      kind: 'literary',
      quoteId: LITERARY_QUOTES[0].id,
      commentary: '   ',
    }),
  );
});
