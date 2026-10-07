import { logError } from './logging.mjs';
import { formatVkPost } from './content.mjs';
import { recordGenerationCost } from './costs.mjs';

export const DEFAULT_MODEL = 'google/gemini-3.1-flash-lite';
export const DEFAULT_PROMPT =
  'Напиши мне пост про вайбкодинг на 500 символов в нужном нам формате.';

export class GenerationFailure extends Error {
  constructor(reason, { code = null, kind = 'temporary', retryAfter = 0 } = {}) {
    super(`OpenRouter generation failed: ${reason}`);
    this.reason = reason;
    this.code = code;
    this.kind = kind;
    this.retryAfter = retryAfter;
  }
}

const fields = ['title', 'summary', 'why', 'action'];
const schema = {
  type: 'object',
  additionalProperties: false,
  required: fields,
  properties: Object.fromEntries(fields.map((field) => [field, { type: 'string' }])),
};

async function requestOneCompletion(config, options = {}, fetchImpl = fetch) {
  if (!config.openrouterKey)
    throw new GenerationFailure('missing_api_key', { kind: 'configuration' });
  let body;
  let response;
  const requestBody = { ...options.body };
  const plan = config.editorialPlan;
  if (
    options.kind !== 'review' &&
    (plan?.topic?.trim() || plan?.brief?.trim()) &&
    requestBody.messages
  ) {
    const instruction = `\nПРИОРИТЕТНОЕ ЗАДАНИЕ РЕДАКТОРА ДЛЯ ЭТОГО ВЫПУСКА: ${JSON.stringify({ topic: plan.topic || '', brief: plan.brief || '' })}\nТема и бриф заданы владельцем в кабинете и обязательны к исполнению. Они имеют приоритет над автоматическим выбором темы, рубрики, технологии, ротацией и пожеланиями разнообразия. Не заменяй указанную тему собственной. Примеры и история не должны переопределять это задание. Обязательный формат ответа, достоверность фактов и проверенные цитаты сохраняются. Не выводи служебное задание в публичный текст.`;
    const system = requestBody.messages.findIndex((message) => message.role === 'system');
    requestBody.messages = requestBody.messages.map((message, index) =>
      index === system ? { ...message, content: `${message.content}${instruction}` } : message,
    );
    if (system === -1) requestBody.messages.unshift({ role: 'system', content: instruction });
  }
  try {
    response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeout || 30_000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openrouterKey}`,
      },
      body: JSON.stringify({ model: config.openrouterModel || DEFAULT_MODEL, ...requestBody }),
    });
    body = await response.json();
  } catch {
    // Generation has no publishing side effects; a bounded retry is safe here.
    await recordGenerationCost(config, {
      usd: null,
      outcome: 'network_unknown',
      postId: options.costPostId || config.generationPostId,
    });
    throw new GenerationFailure('network_or_invalid_response');
  }
  await recordGenerationCost(config, {
    id: body?.id,
    model: body?.model,
    usd: body?.usage?.cost,
    outcome: response.ok && !body?.error ? 'completed' : 'rejected',
    postId: options.costPostId || config.generationPostId,
  });
  if (!response.ok || body.error) {
    const code = Number(body.error?.code || response.status);
    const retryAfter = Number(response.headers?.get('retry-after'));
    throw new GenerationFailure('api_rejected', {
      code,
      kind: [400, 401, 402, 403, 404, 422].includes(code) ? 'configuration' : 'temporary',
      retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 86400) : 0,
    });
  }
  return body;
}

export function sharedProviderFailure(error) {
  return error.reason === 'missing_api_key' || [401, 402, 403].includes(error.code);
}
export async function requestCompletion(config, options = {}, fetchImpl = fetch) {
  const models = config.openrouterModels?.length
    ? config.openrouterModels
    : [config.openrouterModel || DEFAULT_MODEL];
  let failure;
  for (const [index, model] of models.entries()) {
    try {
      return await requestOneCompletion(
        { ...config, openrouterModel: model },
        { ...options, body: { ...options.body, model } },
        fetchImpl,
      );
    } catch (error) {
      if (!(error instanceof GenerationFailure) || sharedProviderFailure(error)) throw error;
      failure = error;
      if (index < models.length - 1) {
        error.logId ||= await logError(
          config,
          {
            platform: 'openrouter',
            reason: error.reason,
            errorCode: error.code,
            model,
            status: 'fallback',
            postId: options.costPostId || config.generationPostId || options.id,
          },
          error,
        );
        if (config.onGenerationFailure) await config.onGenerationFailure(error, model);
      }
    }
  }
  throw failure;
}
export async function generatePost(config, options = {}) {
  const models = config.openrouterModels?.length
    ? config.openrouterModels
    : [config.openrouterModel || DEFAULT_MODEL];
  let failure;
  for (const [index, model] of models.entries()) {
    try {
      return await generateOnePost(
        {
          ...config,
          openrouterModel: model,
          openrouterModels: [model],
          generationPostId: options.id,
        },
        { ...options, feedback: failure?.reason || options.feedback },
      );
    } catch (error) {
      if (!(error instanceof GenerationFailure) || sharedProviderFailure(error)) throw error;
      failure = error;
      if (index < models.length - 1) {
        error.logId ||= await logError(
          config,
          {
            platform: 'openrouter',
            reason: error.reason,
            errorCode: error.code,
            model,
            status: 'fallback',
            postId: options.costPostId || config.generationPostId || options.id,
          },
          error,
        );
        if (config.onGenerationFailure) await config.onGenerationFailure(error, model);
      }
    }
  }
  throw failure;
}

async function generateOnePost(
  config,
  {
    id,
    history = [],
    feedback = '',
    fetchImpl = fetch,
    excludeUrls = [],
    excludeQuoteIds = [],
    historyPosts = [],
    editorialHistory = [],
    slot = null,
    now = new Date(),
  } = {},
) {
  if (config.contentMode === 'lifestyle') {
    const { generateLifestylePost } = await import('./lifestyle.mjs');
    return generateLifestylePost(config, { id, history, historyPosts, feedback, fetchImpl, now });
  }
  if (config.contentMode === 'programming') {
    const { generateProgrammingPost } = await import('./programming.mjs');
    return generateProgrammingPost(config, {
      id,
      historyPosts,
      editorialHistory,
      slot,
      now,
      feedback,
      fetchImpl,
    });
  }
  if (config.contentMode === 'literary') {
    const { generateLiteraryPost } = await import('./literary.mjs');
    return generateLiteraryPost(config, {
      id,
      history,
      feedback,
      fetchImpl,
      excludeQuoteIds,
      historyPosts,
    });
  }
  if (config.contentMode === 'digest') {
    const { generateDigest } = await import('./digest.mjs');
    return generateDigest(config, { id, history, feedback, fetchImpl, excludeUrls });
  }
  const body = await requestCompletion(
    config,
    {
      body: {
        model: config.openrouterModel || DEFAULT_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'Ты пишешь полезные короткие посты на русском для вайбкодеров. Верни только JSON: title (краткий заголовок), summary (одна практичная мысль), why (польза), action (конкретное действие). Без HTML, Markdown, ссылок, хештегов, рекламы, выдуманных исследований, цитат и новостей. Не пиши про статью или «оригинал»: это самостоятельный совет. Итоговый пост имеет вид: «💡 Вайбкодинг», пустая строка, title, пустая строка, summary, пустая строка, «Зачем это: » + why, пустая строка, «Что попробовать: » + action. Стремись к 500 символам всего итогового текста, включая заголовки, пробелы и переносы; допустимо 450–550. Выбери один узкий практический аспект вайбкодинга. Текст должен заканчиваться целым предложением.',
          },
          {
            role: 'user',
            content: `${config.openrouterPrompt || DEFAULT_PROMPT}${history.length ? `\nНе повторяй эти недавние темы: ${JSON.stringify(history.slice(-10))}` : ''}${feedback ? '\nПредыдущий ответ не прошёл проверку формата или длины. Исправь формат и уложись в 450–550 символов.' : ''}`,
          },
        ],
        temperature: 0.7,
        max_tokens: 700,
        reasoning: { effort: 'minimal', exclude: true },
        provider: { require_parameters: true, max_price: { prompt: 0.3, completion: 2 } },
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'vibecoding_post', strict: true, schema },
        },
      },
    },
    fetchImpl,
  );
  let result;
  try {
    if (body.choices?.[0]?.finish_reason !== 'stop') throw new Error('Incomplete response');
    result = JSON.parse(body.choices[0].message.content);
    if (
      !result ||
      fields.some((field) => typeof result[field] !== 'string' || !result[field].trim()) ||
      Object.keys(result).some((field) => !fields.includes(field))
    )
      throw new Error('Invalid fields');
    for (const field of fields) result[field] = result[field].trim();
    const post = { id, kind: 'tip', ...result };
    const length = [...formatVkPost(post)].length;
    if (length < 450 || length > 550) throw new Error('Invalid length');
    return {
      ...post,
      generation: {
        model: body.model || config.openrouterModel || DEFAULT_MODEL,
        characters: length,
        cost: typeof body.usage?.cost === 'number' ? body.usage.cost : null,
        title: result.title,
      },
    };
  } catch {
    throw new GenerationFailure('invalid_generated_post');
  }
}
