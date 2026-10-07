import { zonedParts } from './time.mjs';

export const TERMINAL_DELIVERY_STATUSES = new Set([
  'sent',
  'failed',
  'exhausted',
  'cancelled',
  'missed',
  'uncertain',
]);

export function isTerminalDeliveryStatus(status) {
  return TERMINAL_DELIVERY_STATUSES.has(status);
}

export const DELIVERY_STATUSES = new Set([
  'planned',
  'generating',
  'ready',
  'sending',
  'retry_wait',
  'sent',
  'failed',
  'exhausted',
  'uncertain',
  'missed',
  'cancelled',
]);

export const OPERATOR_STATUS = {
  planned: { label: 'Запланирован', icon: '○' },
  generating: { label: 'Готовится', icon: '…' },
  ready: { label: 'Готов к отправке', icon: '◔' },
  sending: { label: 'Отправляется', icon: '↑' },
  retry_wait: { label: 'Задержан', icon: '⏳' },
  sent: { label: 'Опубликован', icon: '✓' },
  failed: { label: 'Не опубликован', icon: '✕' },
  exhausted: { label: 'Не опубликован', icon: '✕' },
  uncertain: { label: 'Исход неизвестен', icon: '?' },
  missed: { label: 'Пропущен', icon: '—' },
  cancelled: { label: 'Отменён', icon: '—' },
  partially_sent: { label: 'Частично опубликован', icon: '◑' },
};

const SUCCESS = new Set(['sent']);
const FAILURE = new Set(['failed', 'exhausted', 'uncertain', 'missed', 'cancelled']);
const IN_FLIGHT = new Set(['generating', 'ready', 'sending', 'retry_wait']);

export function aggregateEditionStatus(deliveryStatuses) {
  const statuses = [...new Set(deliveryStatuses)];
  if (!statuses.length) return 'planned';
  if (statuses.every((status) => SUCCESS.has(status))) return 'sent';
  if (
    statuses.some((status) => SUCCESS.has(status)) &&
    statuses.some((status) => FAILURE.has(status))
  )
    return 'partially_sent';
  if (statuses.some((status) => status === 'uncertain')) return 'uncertain';
  if (statuses.some((status) => status === 'retry_wait')) return 'retry_wait';
  if (statuses.some((status) => IN_FLIGHT.has(status))) {
    if (statuses.includes('generating')) return 'generating';
    if (statuses.includes('sending')) return 'sending';
    if (statuses.includes('ready')) return 'ready';
    return 'generating';
  }
  if (statuses.every((status) => status === 'planned')) return 'planned';
  if (statuses.every((status) => status === 'missed')) return 'missed';
  if (statuses.every((status) => FAILURE.has(status))) {
    if (statuses.includes('exhausted')) return 'exhausted';
    return 'failed';
  }
  return statuses[0];
}

export function summaryBucket(status) {
  if (status === 'planned') return 'planned';
  if (['generating', 'ready'].includes(status)) return 'readying';
  if (status === 'sent') return 'sent';
  if (status === 'partially_sent') return 'sent';
  if (status === 'retry_wait') return 'delayed';
  if (['failed', 'exhausted'].includes(status)) return 'failed';
  if (status === 'uncertain') return 'uncertain';
  if (['missed', 'cancelled'].includes(status)) return 'missed';
  if (status === 'sending') return 'readying';
  return 'planned';
}

export function mapEntryStatus(entry) {
  if (entry.status === 'empty') return 'failed';
  if (entry.status === 'rejected') return 'retry_wait';
  return entry.status;
}

export function publicationKind(config, slotKeyValue, destination) {
  const time = slotKeyValue.match(/@(\d{2}:\d{2})\[/)?.[1];
  const mediaTimes = destination?.media?.times || config.mediaTimes;
  const mediaEnabled = destination?.media?.enabled === true;
  if (mediaEnabled && mediaTimes?.includes(time)) {
    const kind = destination.media.kind || config.coverMode || 'image';
    if (destination.media.uploadMode === 'photo') return { kind: 'image', media: 'image' };
    if (kind === 'video') return { kind: 'video', media: 'video' };
    return { kind: 'gif', media: 'gif' };
  }
  return { kind: 'text', media: null };
}

export function projectTitle(projectId, project) {
  if (projectId === 'dark-academia') return 'Конэсанс';
  if (projectId === 'code-to-think') return 'Код на подумать';
  if (projectId === 'things') return 'Вещи — кстати';
  return project?.title || projectId;
}

export function destinationTitle(destinationId) {
  if (destinationId === 'connaissance-vk') return 'VK Конэсанс';
  if (destinationId === 'code-to-think-vk') return 'VK Код на подумать';
  if (destinationId === 'things-vk') return 'VK Вещи — кстати';
  return destinationId;
}

export function matchesStatusFilter(cardStatus, filter) {
  if (!filter) return true;
  if (filter === 'retry_wait') return cardStatus === 'retry_wait';
  if (filter === 'sent') return cardStatus === 'sent' || cardStatus === 'partially_sent';
  if (filter === 'failed') return ['failed', 'exhausted'].includes(cardStatus);
  return cardStatus === filter;
}

const SLOT_DATE = /^(\d{4}-\d{2}-\d{2})@\d{2}:\d{2}\[([^\]]+)\]$/;

export function canRetryPublication(detail, now = new Date()) {
  const slot = SLOT_DATE.exec(detail?.edition?.slotKey || '');
  if (!slot) return false;
  if (!['failed', 'exhausted'].includes(detail.edition.status)) return false;
  if (
    (detail.deliveries || []).some((row) => ['sent', 'uncertain', 'sending'].includes(row.status))
  )
    return false;
  const today = zonedParts(now, slot[2]);
  return slot[1] === `${today.year}-${today.month}-${today.day}`;
}

export function classifyReleaseSource(slotKey, postId) {
  if (typeof slotKey === 'string' && slotKey.startsWith('manual:')) {
    if (typeof postId === 'string' && /^test/i.test(postId)) {
      return { source: 'test', label: 'Тестовая публикация' };
    }
    return { source: 'manual', label: 'Вне плана' };
  }
  return { source: 'unplanned', label: 'Без слота расписания' };
}
