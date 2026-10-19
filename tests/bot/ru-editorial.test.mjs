import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyRussianEditorial } from '../../bot/config/runtime.mjs';
import service from '../../bot/service.json' with { type: 'json' };

const MODEL = 'deepseek/deepseek-v4.1-flash-1017';

test('main text providers start on deepseek and do not repeat it as fallback', () => {
  for (const id of ['budget-editor', 'lifestyle-editor']) {
    const provider = service.providers[id];
    assert.equal(provider.model, MODEL);
    assert.deepEqual(provider.fallbackModels, ['openai/gpt-6-luna', 'z-ai/glm-5.3-flash']);
  }
});

test('russian editorial policy attaches once and keeps the project voice first', async () => {
  const policy = await readFile(new URL('../../bot/prompts/ru-editorial.md', import.meta.url), 'utf8');
  const voice = 'Ты — редактор «Конэсанс». Пиши литературно.';
  const combined = applyRussianEditorial(voice, policy);
  assert.match(combined, /^Ты — редактор «Конэсанс»/);
  assert.match(combined, /РЕДАКЦИОННАЯ НОРМА РУССКОГО ТЕКСТА/);
  assert.match(combined, /КОПИРАЙТЕР/);
  assert.match(combined, /РЕДАКТОР/);
  assert.equal(applyRussianEditorial(combined, policy), combined);
  assert.equal(applyRussianEditorial(voice, ''), voice);
});
