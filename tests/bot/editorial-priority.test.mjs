import test from 'node:test';
import assert from 'node:assert/strict';
import { requestCompletion } from '../../bot/openrouter.mjs';

test('editor instructions are present with explicit priority in actual completion requests for each format', async () => {
  for (const contentMode of ['programming', 'literary', 'lifestyle', 'digest']) {
    const messages = [
      { role: 'system', content: 'Community format and automatic rotation.' },
      { role: 'user', content: 'Pick a different subject from history.' },
    ];
    let sent;
    await requestCompletion(
      {
        contentMode,
        openrouterKey: 'test',
        openrouterModels: ['test/model'],
        editorialPlan: { topic: 'Транзакции SQL', brief: 'Разбери race condition, без Python' },
      },
      { body: { messages } },
      async (_url, request) => {
        sent = JSON.parse(request.body);
        return { ok: true, json: async () => ({ choices: [] }) };
      },
    );
    assert.match(sent.messages[0].content, /ПРИОРИТЕТНОЕ ЗАДАНИЕ РЕДАКТОРА/);
    assert.match(sent.messages[0].content, /Транзакции SQL/);
    assert.match(sent.messages[0].content, /без Python/);
    assert.match(sent.messages[0].content, /имеют приоритет над автоматическим выбором/);
    assert.equal(messages[0].content, 'Community format and automatic rotation.');
  }
});

test('a safety review retains its independent instructions', async () => {
  let sent;
  await requestCompletion(
    { openrouterKey: 'test', editorialPlan: { topic: 'Manual subject' } },
    {
      kind: 'review',
      body: { messages: [{ role: 'system', content: 'Reject unsafe or incorrect facts.' }] },
    },
    async (_url, request) => {
      sent = JSON.parse(request.body);
      return { ok: true, json: async () => ({}) };
    },
  );
  assert.equal(sent.messages[0].content, 'Reject unsafe or incorrect facts.');
});
