/** Limited editorial vocabularies. Reader profiling is forbidden. */

export const CLASSIFIER_VERSION = 'v1';

export const TONES = Object.freeze([
  'calm',
  'warm',
  'heavy',
  'playful',
  'precise',
  'reflective',
  'unknown',
]);

export const INTENSITIES = Object.freeze(['low', 'medium', 'high', 'unknown']);

export const STRUCTURES = Object.freeze([
  'quote_commentary',
  'task',
  'solution',
  'editorial',
  'scenario_tip',
  'reframe',
  'unknown',
]);

export const SERIES_STATUSES = Object.freeze([
  'draft',
  'approved',
  'active',
  'completed',
  'paused',
  'cancelled',
]);

export const WEEKLY_BUDGET_USD = 0.5;

export const PROJECT_RULES = Object.freeze({
  'dark-academia': {
    title: 'Конэсанс',
    required: 'verified_short_quote',
    constraints: [
      'Настоящая короткая цитата из проверенного источника',
      'Чередовать авторов',
      'Избегать одинаковых концовок и постоянного тяжёлого тона',
    ],
  },
  'code-to-think': {
    title: 'Код на подумать',
    required: 'solution_binds_to_sent_task',
    constraints: [
      'Разбор относится к конкретной опубликованной задаче',
      'Сохранить техническую проверку',
      'Не заявлять запуск кода без выполнения',
    ],
  },
  things: {
    title: 'Вещи — кстати',
    required: 'no_product_claims',
    constraints: [
      'Без товарных ссылок и цен',
      'Никаких вымышленных тестов, свойств, гарантий и медицинских рекомендаций',
    ],
  },
});

export function normalizeTone(value) {
  return TONES.includes(value) ? value : 'unknown';
}

export function normalizeIntensity(value) {
  return INTENSITIES.includes(value) ? value : 'unknown';
}

export function normalizeStructure(value) {
  return STRUCTURES.includes(value) ? value : 'unknown';
}
