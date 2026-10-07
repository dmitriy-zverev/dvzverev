import test from 'node:test';
import assert from 'node:assert/strict';
import { dueSlot } from '../../bot/core.mjs';
import { generatePost, GenerationFailure } from '../../bot/openrouter.mjs';
import { formatVkPost } from '../../bot/content.mjs';
import { programmingPlan } from '../../bot/programming.mjs';

const config = {
  contentMode: 'programming',
  openrouterKey: 'test',
  openrouterModel: 'test',
  openrouterPrompt: 'Код на подумать',
  timezone: 'Europe/Moscow',
  vkGroupId: '242034586',
  times: ['12:00', '18:00'],
  weekly: {
    1: ['12:00', '18:00'],
    2: ['12:00'],
    3: ['12:00', '18:00'],
    4: ['12:00'],
    5: ['12:00', '18:00'],
    6: ['12:00'],
    7: ['12:00', '18:00'],
  },
};
const task = {
  text: 'Два запроса одновременно создают платёж. Как избежать дубля?',
  title: 'Повторный платёж',
  technology: 'Backend',
  difficulty: 'junior+',
  correct_answer: 'Ключ идемпотентности',
  explanation: 'Операция получает стабильный ключ.',
  possible_alternative_answers: 'Уникальный бизнес-ключ.',
  solution_text:
    'Два запроса создают один платёж. Уникальный ключ и транзакция предотвращают дубль.',
  checked: true,
};
const reply = (result) => async () => ({
  ok: true,
  json: async () => ({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }],
    usage: { cost: 0.001 },
  }),
});

test('programming schedule has eleven weekly slots and skips Tuesday evening', () => {
  assert.equal(Object.values(config.weekly).flat().length, 11);
  assert.equal(dueSlot(config, new Date('2026-10-06T15:00:00Z')), null);
  assert.match(dueSlot(config, new Date('2026-10-06T09:01:00Z')), /@12:00/);
  assert.match(dueSlot(config, new Date('2026-10-07T15:00:00Z')), /@18:00/);
});

test('programming task keeps answers private and rejects unchecked tasks', async () => {
  const post = await generatePost(config, {
    id: 'task-1',
    slot: '2026-10-06@12:00[Europe/Moscow]',
    fetchImpl: reply(task),
  });
  assert.equal(formatVkPost(post), task.text);
  assert.ok(!formatVkPost(post).includes(task.correct_answer));
  assert.equal(post.generation.editorial.correctAnswer, task.correct_answer);
  for (const invalid of [
    { ...task, checked: false },
    { ...task, correct_answer: '' },
    { ...task, text: 'Источник https://invented.invalid' },
  ]) {
    await assert.rejects(
      generatePost(config, {
        id: 'invalid',
        slot: '2026-10-06@12:00[Europe/Moscow]',
        fetchImpl: reply(invalid),
      }),
      GenerationFailure,
    );
  }
});

test('solution uses a previously published task and links its VK post without a new model call', async () => {
  const previous = await generatePost(config, {
    id: 'task-1',
    slot: '2026-10-06@12:00[Europe/Moscow]',
    fetchImpl: reply(task),
  });
  const entry = {
    postId: previous.id,
    slot: '2026-10-06@12:00[Europe/Moscow]',
    vkPostId: 99,
    generation: previous.generation,
  };
  const editorialHistory = [entry];
  const post = await generatePost(config, {
    id: 'solution-1',
    slot: '2026-10-09@18:00[Europe/Moscow]',
    editorialHistory,
    fetchImpl: async () => {
      throw new Error('No extra generation');
    },
  });
  assert.match(formatVkPost(post), /wall-242034586_99/);
  assert.ok(formatVkPost(post).includes(task.solution_text));
  assert.equal(post.generation.editorial.solutionFor, 'task-1');
  const plan = programmingPlan(config, {
    slot: '2026-10-11@18:00[Europe/Moscow]',
    editorialHistory: [...editorialHistory, { generation: post.generation }],
  });
  assert.equal(plan.type, 'task');
  assert.equal(
    programmingPlan(config, { slot: '2026-10-07@18:00[Europe/Moscow]' }).type,
    'editorial',
  );
});

test('manual editorial instructions bypass a stored solution and reach the model', async () => {
  let calls = 0;
  const post = await generatePost(
    { ...config, editorialPlan: { topic: 'Транзакции SQL', brief: 'Объясни гонку запросов' } },
    {
      id: 'manual-editorial',
      slot: '2026-10-09@18:00[Europe/Moscow]',
      editorialHistory: [
        {
          postId: 'old-task',
          vkPostId: 10,
          slot: '2026-10-08@12:00[Europe/Moscow]',
          generation: {
            editorial: {
              type: 'task',
              solutionText: 'Stored answer must not replace the assignment',
            },
          },
        },
      ],
      fetchImpl: async (_url, request) => {
        calls++;
        const body = JSON.parse(request.body);
        if (calls === 1) assert.match(body.messages[0].content, /Транзакции SQL/);
        return reply({
          ...task,
          correct_answer: '',
          explanation: '',
          possible_alternative_answers: '',
          solution_text: '',
        })();
      },
    },
  );
  assert.ok(calls > 0);
  assert.notEqual(post.generation.model, 'stored-solution');
});

test('a second model pass reviews task and solution, and review errors prevent publication', async () => {
  let calls = 0;
  const reviewed = {
    ...task,
    solution_text:
      'Стабильный ключ, уникальное ограничение и атомарное создание защищают от гонки.',
  };
  const models = [];
  const post = await generatePost(
    { ...config, reviewModel: 'test-reviewer' },
    {
      id: 'reviewed',
      slot: '2026-10-06@12:00[Europe/Moscow]',
      fetchImpl: async (_url, options) => {
        models.push(JSON.parse(options.body).model);
        return reply(++calls === 1 ? task : reviewed)();
      },
    },
  );
  assert.equal(calls, 2);
  assert.deepEqual(models, ['test', 'test-reviewer']);
  assert.equal(post.generation.editorial.solutionText, reviewed.solution_text);
  assert.equal(post.generation.editorial.checkedBy, 'model-review');
  assert.equal(post.generation.cost, 0.002);
  calls = 0;
  await assert.rejects(
    generatePost(config, {
      id: 'failed-review',
      slot: '2026-10-06@12:00[Europe/Moscow]',
      fetchImpl: async () => reply(++calls === 1 ? task : { ...task, checked: false })(),
    }),
    GenerationFailure,
  );
});

test('review accepts arrays of alternative answers but rejects arbitrary objects', async () => {
  const post = await generatePost(config, {
    id: 'array-alternatives',
    slot: '2026-10-06@12:00[Europe/Moscow]',
    fetchImpl: reply({
      ...task,
      possible_alternative_answers: ['Уникальный ключ.', 'Атомарная запись.'],
    }),
  });
  assert.equal(post.generation.editorial.alternatives, 'Уникальный ключ.\nАтомарная запись.');
  await assert.rejects(
    generatePost(config, {
      id: 'object-alternatives',
      slot: '2026-10-06@12:00[Europe/Moscow]',
      fetchImpl: reply({ ...task, possible_alternative_answers: { invented: true } }),
    }),
    GenerationFailure,
  );
});
