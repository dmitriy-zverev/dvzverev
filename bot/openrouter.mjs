import { formatVkPost } from './content.mjs';

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

export async function requestCompletion(config, options = {}, fetchImpl = fetch) {
  if (!config.openrouterKey)
    throw new GenerationFailure('missing_api_key', { kind: 'configuration' });
  let body;
  let response;
  try {
    response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeout || 30_000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openrouterKey}`,
      },
      body: JSON.stringify({ model: config.openrouterModel || DEFAULT_MODEL, ...options.body }),
    });
    body = await response.json();
  } catch {
    // Generation has no publishing side effects; a bounded retry is safe here.
    throw new GenerationFailure('network_or_invalid_response');
  }
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

export async function generatePost(
  config,
  { id, history = [], feedback = '', fetchImpl = fetch, excludeUrls = [] } = {},
) {
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
