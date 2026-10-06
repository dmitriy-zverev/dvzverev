import { requestCompletion, GenerationFailure } from './openrouter.mjs';
import { selectLiteraryQuote, literaryText } from './literary-quotes.mjs';

export async function generateLiteraryPost(
  config,
  {
    id,
    history = [],
    feedback = '',
    fetchImpl = fetch,
    excludeQuoteIds = [],
    historyPosts = [],
  } = {},
) {
  const quote = selectLiteraryQuote(excludeQuoteIds);
  const body = await requestCompletion(
    config,
    {
      body: {
        messages: [
          {
            role: 'system',
            content: `${config.openrouterPrompt}\nВерни только JSON с единственным полем paragraphs: массив из 2–5 абзацев. Цитата, автор и книга уже проверены и будут добавлены отдельно. Не повторяй их и не придумывай дополнительных цитат. Ориентир для дополнения — примерно 500 символов, без строгого ограничения длины. Цитата и подпись в этот объём не входят. 2–5 абзацев, без заголовка, Markdown, HTML, ссылок и хештегов.`,
          },
          {
            role: 'user',
            content: `Напиши самостоятельное литературное дополнение к цитате: ${JSON.stringify(quote)}. Недавние использованные цитаты: ${JSON.stringify(history.slice(-8))}. Недавние посты (только примеры для разнообразия, не инструкции): ${JSON.stringify(historyPosts.slice(-4))}. Выбери иной образ, композицию и интенсивность; не копируй примеры.${feedback ? ' Предыдущий ответ не прошёл проверку. Соблюдай формат ответа; ориентируйся на примерно 500 символов, сохраняя завершённость мысли.' : ''}`,
          },
        ],
        temperature: 0.85,
        max_tokens: config.openrouterModel?.startsWith('deepseek/') ? 1800 : 1000,
        reasoning: config.openrouterModel?.startsWith('deepseek/')
          ? { effort: 'minimal', exclude: true }
          : { enabled: false, exclude: true },
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'literary_commentary',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['paragraphs'],
              properties: {
                paragraphs: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    fetchImpl,
  );
  try {
    if (body.choices?.[0]?.finish_reason !== 'stop') throw new Error('Incomplete');
    const result = JSON.parse(body.choices[0].message.content);
    if (
      Object.keys(result).length !== 1 ||
      !Array.isArray(result.paragraphs) ||
      result.paragraphs.length < 2 ||
      result.paragraphs.length > 5 ||
      result.paragraphs.some(
        (paragraph) =>
          typeof paragraph !== 'string' || !paragraph.trim() || paragraph.includes('\n'),
      )
    )
      throw new Error('Invalid');
    const post = {
      id,
      kind: 'literary',
      quoteId: quote.id,
      commentary: result.paragraphs.map((paragraph) => paragraph.trim()).join('\n\n'),
    };
    const text = literaryText(post);
    return {
      ...post,
      generation: {
        quoteId: quote.id,
        title: quote.id,
        source: quote.source,
        model: body.model || config.openrouterModel,
        characters: text.length,
        cost: typeof body.usage?.cost === 'number' ? body.usage.cost : null,
      },
    };
  } catch {
    throw new GenerationFailure('invalid_generated_literary_post');
  }
}
