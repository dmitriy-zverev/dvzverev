/**
 * Adapter for VK cabinet export: `{groupId}_posts_content_{from}_{to}.xls`
 * after conversion to UTF-8 CSV/JSON (see bot/vk-posts-xls-to-json.py).
 *
 * Per-post KPIs exist; post_id / wall_url do NOT. Never invent post ids.
 * audience/common exports are group-level — rejected here.
 */

export const VK_POSTS_CONTENT_SOURCE = 'vk_posts_content_xls';

export const VK_POSTS_CONTENT_HEADERS = [
  'Раздел',
  'Подраздел',
  'Дата',
  'Время',
  'Описание',
  'Охват',
  'Просмотры',
  'Лайки',
  'Комментарии',
  'Поделились',
  'Закладки',
];

const FILENAME_RE =
  /^(\d+)_posts_(audience|common|content)_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})(?:\.(?:xls|xlsx|csv|json))?$/i;

/**
 * @param {string} filename
 * @returns {{ groupId: string, kind: string, periodFrom: string, periodTo: string } | null}
 */
export function parseVkPostsExportFilename(filename) {
  const base = String(filename || '')
    .split(/[/\\]/)
    .pop()
    .trim();
  const match = base.match(FILENAME_RE);
  if (!match) return null;
  return {
    groupId: match[1],
    kind: match[2].toLowerCase(),
    periodFrom: match[3],
    periodTo: match[4],
  };
}

/**
 * @param {string[]} headers
 */
export function isVkPostsContentHeaders(headers) {
  if (!Array.isArray(headers) || headers.length < VK_POSTS_CONTENT_HEADERS.length) return false;
  const normalized = headers.map((h) => String(h ?? '').trim());
  return VK_POSTS_CONTENT_HEADERS.every((expected, i) => normalized[i] === expected);
}

/**
 * @param {string[]} headers
 */
export function detectVkPostsNativeKind(headers) {
  if (!Array.isArray(headers) || headers.length === 0) return null;
  const h = headers.map((x) => String(x ?? '').trim());
  if (isVkPostsContentHeaders(h)) return 'content';
  if (h[0] === 'Раздел' && h[1] === 'Подраздел' && h.includes('Критерий')) return 'audience';
  if (h[0] === 'Раздел' && h[1] === 'Подраздел' && h.includes('Вид данных')) return 'common';
  return null;
}

/**
 * Convert Moscow wall clock DD.MM.YYYY + HH:MM to ISO UTC.
 * @param {string} dateText
 * @param {string} [timeText]
 */
export function moscowDateTimeToIso(dateText, timeText = '00:00') {
  const date = String(dateText ?? '').trim();
  const time = String(timeText ?? '00:00').trim() || '00:00';
  const dm = date.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!dm) return null;
  const tm = time.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!tm) return null;
  const isoLocal = `${dm[3]}-${dm[2]}-${dm[1]}T${tm[1].padStart(2, '0')}:${tm[2]}:${(tm[3] || '00').padStart(2, '0')}+03:00`;
  const ms = Date.parse(isoLocal);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Period bounds from filename calendar dates (Moscow day start/end → UTC ISO).
 * @param {string} fromYmd YYYY-MM-DD
 * @param {string} toYmd YYYY-MM-DD
 */
export function periodBoundsFromFilenameDates(fromYmd, toYmd) {
  const from = moscowDateTimeToIso(ymdToDmy(fromYmd), '00:00');
  const to = moscowDateTimeToIso(ymdToDmy(toYmd), '23:59:59');
  if (!from || !to) return null;
  return { periodFrom: from, periodTo: to, observedAt: to };
}

function ymdToDmy(ymd) {
  const m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  return `${m[3]}.${m[2]}.${m[1]}`;
}

/**
 * Map one native posts_content row (object keyed by Russian headers) to vk-stats-v1 raw record.
 * Leaves post_id empty — caller must supply wall_url/post_id later. Never invents ids.
 *
 * @param {Record<string, unknown>} nativeRow
 * @param {{ groupId: string, periodFrom: string, periodTo: string, observedAt: string }} meta
 */
export function mapVkPostsContentRow(nativeRow, meta) {
  const publishedAt = moscowDateTimeToIso(nativeRow['Дата'], nativeRow['Время']);
  const textHint = cleanTextHint(nativeRow['Описание']);
  return {
    group_id: meta.groupId,
    post_id: '',
    published_at: publishedAt || '',
    observed_at: meta.observedAt,
    period_from: meta.periodFrom,
    period_to: meta.periodTo,
    metric_mode: 'period',
    views: cellOrEmpty(nativeRow['Просмотры']),
    reach_total: cellOrEmpty(nativeRow['Охват']),
    likes: cellOrEmpty(nativeRow['Лайки']),
    comments: cellOrEmpty(nativeRow['Комментарии']),
    reposts: cellOrEmpty(nativeRow['Поделились']),
    saves: cellOrEmpty(nativeRow['Закладки']),
    text_hint: textHint,
  };
}

/**
 * @param {Record<string, unknown>[]} nativeRows
 * @param {{ filename?: string, groupId?: string, periodFrom?: string, periodTo?: string, observedAt?: string }} [options]
 */
export function adaptVkPostsContentRows(nativeRows, options = {}) {
  const fromName = parseVkPostsExportFilename(options.filename || '');
  if (fromName && fromName.kind !== 'content') {
    return {
      ok: false,
      error: 'vk_export_not_per_post',
      message:
        fromName.kind === 'audience'
          ? 'posts_audience — групповая аудитория (устройства/пол/города), не per-post'
          : 'posts_common — групповые ряды охвата/взаимодействий, не per-post',
    };
  }

  const groupId = String(options.groupId || fromName?.groupId || '').replace(/^-/, '');
  if (!groupId) {
    return {
      ok: false,
      error: 'missing_group_id',
      message: 'Нужен group_id в имени файла ({id}_posts_content_...) или в meta',
    };
  }

  let bounds = null;
  if (fromName) {
    bounds = periodBoundsFromFilenameDates(fromName.periodFrom, fromName.periodTo);
  } else if (options.periodFrom && options.periodTo) {
    bounds = {
      periodFrom: options.periodFrom,
      periodTo: options.periodTo,
      observedAt: options.observedAt || options.periodTo,
    };
  }
  if (!bounds) {
    return {
      ok: false,
      error: 'missing_period',
      message: 'Нужен период в имени файла или periodFrom/periodTo',
    };
  }

  const meta = {
    groupId,
    periodFrom: bounds.periodFrom,
    periodTo: bounds.periodTo,
    observedAt: options.observedAt || bounds.observedAt,
  };

  const records = nativeRows.map((row) => mapVkPostsContentRow(row, meta));
  return {
    ok: true,
    sourceFormat: VK_POSTS_CONTENT_SOURCE,
    groupId,
    periodFrom: meta.periodFrom,
    periodTo: meta.periodTo,
    observedAt: meta.observedAt,
    records,
  };
}

function cellOrEmpty(value) {
  if (value == null) return '';
  const text = String(value).trim();
  if (!text || text === '#' || text === 'нет данных') return '';
  return text;
}

function cleanTextHint(value) {
  if (value == null) return null;
  let text = String(value).replace(/\u00a0/g, ' ').trim();
  if (!text) return null;
  if (text.length > 240) text = `${text.slice(0, 237)}...`;
  return text;
}
