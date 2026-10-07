import { createHash } from 'node:crypto';
import {
  adaptVkPostsContentRows,
  detectVkPostsNativeKind,
  parseVkPostsExportFilename,
  VK_POSTS_CONTENT_SOURCE,
} from './vk-posts-content.mjs';

export const VK_STATS_SCHEMA_VERSION = 'vk-stats-v1';
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;
export const IMPORT_PROCESS_TIMEOUT_MS = 30_000;

const XLS_CONVERT_HINT =
  'Classic .xls: uvx --from xlrd python bot/vk-posts-xls-to-json.py <file.xls>, затем загрузите *.vk-stats.json';

export const REQUIRED_FIELDS = [
  'group_id',
  'post_id',
  'observed_at',
  'metric_mode',
];

export const OPTIONAL_METRIC_FIELDS = [
  'published_at',
  'period_from',
  'period_to',
  'views',
  'reach_total',
  'reach_organic',
  'reach_paid',
  'likes',
  'comments',
  'reposts',
  'saves',
  'clicks',
  'link_clicks',
  'subscribers_at_publish',
  'ad_spend',
  'promoted',
  'wall_url',
];

export const CSV_TEMPLATE_HEADER = [
  'group_id',
  'post_id',
  'published_at',
  'observed_at',
  'period_from',
  'period_to',
  'metric_mode',
  'views',
  'reach_total',
  'reach_organic',
  'reach_paid',
  'likes',
  'comments',
  'reposts',
  'saves',
  'clicks',
  'link_clicks',
  'subscribers_at_publish',
  'ad_spend',
  'promoted',
  'wall_url',
].join(',');

const EMPTY_CELL = new Set(['', 'null', 'NULL', 'нет данных', 'n/a', 'N/A', '-']);

export function sourceHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function parseImportFile(buffer, { filename = 'upload.csv' } = {}) {
  if (!Buffer.isBuffer(buffer)) {
    buffer = Buffer.from(buffer);
  }
  if (buffer.length === 0) {
    return failParse('empty_file', 'Файл пуст');
  }
  if (buffer.length > MAX_IMPORT_BYTES) {
    return failParse('file_too_large', `Максимум ${MAX_IMPORT_BYTES} байт`);
  }
  const lower = filename.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const named = parseVkPostsExportFilename(filename);
    if (named?.kind === 'audience' || named?.kind === 'common') {
      return failParse(
        'vk_export_not_per_post',
        named.kind === 'audience'
          ? 'posts_audience — групповая аудитория, не per-post'
          : 'posts_common — групповые ряды, не per-post',
      );
    }
    return failParse('xlsx_not_supported', XLS_CONVERT_HINT);
  }
  const text = decodeUtf8(buffer);
  if (text == null) {
    return failParse('invalid_encoding', 'Нужен UTF-8');
  }
  const hash = sourceHash(buffer);
  if (lower.endsWith('.json') || text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) {
    return parseJsonImport(text, { filename, hash, bytes: buffer.length });
  }
  return parseCsvImport(text, { filename, hash, bytes: buffer.length });
}

function failParse(code, message) {
  return {
    ok: false,
    error: code,
    message,
    schemaVersion: VK_STATS_SCHEMA_VERSION,
    rows: [],
  };
}

function decodeUtf8(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    buffer = buffer.subarray(3);
  }
  const text = buffer.toString('utf8');
  if (text.includes('\uFFFD')) return null;
  return text;
}

function parseJsonImport(text, meta) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return failParse('invalid_json', 'Невалидный JSON');
  }
  const records = Array.isArray(doc)
    ? doc
    : Array.isArray(doc.records)
      ? doc.records
      : Array.isArray(doc.posts)
        ? doc.posts
        : null;
  if (!records) {
    return failParse('invalid_schema', 'JSON должен содержать records[] или posts[]');
  }
  if (records.length > MAX_IMPORT_ROWS) {
    return failParse('too_many_rows', `Максимум ${MAX_IMPORT_ROWS} строк`);
  }
  const rows = records.map((record, index) => normalizeRow(record, index));
  const sourceFormat = doc.sourceFormat || doc.source_format || null;
  return {
    ok: true,
    schemaVersion: doc.schemaVersion || doc.schema_version || VK_STATS_SCHEMA_VERSION,
    format: sourceFormat === VK_POSTS_CONTENT_SOURCE ? 'vk_posts_content' : 'json',
    filename: meta.filename,
    sourceHash: meta.hash,
    bytes: meta.bytes,
    projectHint: doc.projectId || doc.project_id || null,
    groupHint: doc.groupId != null ? String(doc.groupId) : doc.group_id != null ? String(doc.group_id) : null,
    rows,
  };
}

function parseCsvImport(text, meta) {
  const lines = splitCsvLines(text);
  if (lines.length < 2) {
    return failParse('invalid_schema', 'CSV: нужна строка заголовков и хотя бы одна строка данных');
  }
  const rawHeaders = parseCsvLine(lines[0]).map((h) => h.trim());
  const nativeKind = detectVkPostsNativeKind(rawHeaders);
  if (nativeKind === 'audience' || nativeKind === 'common') {
    return failParse(
      'vk_export_not_per_post',
      nativeKind === 'audience'
        ? 'posts_audience — групповая аудитория, не per-post'
        : 'posts_common — групповые ряды, не per-post',
    );
  }
  if (nativeKind === 'content') {
    return parseVkPostsContentCsv(lines, rawHeaders, meta);
  }

  const headers = rawHeaders.map((h) => h.toLowerCase());
  for (const required of REQUIRED_FIELDS) {
    if (!headers.includes(required)) {
      return failParse('invalid_schema', `CSV: нет колонки ${required}`);
    }
  }
  const dataLines = lines.slice(1).filter((line) => line.trim().length > 0);
  if (dataLines.length > MAX_IMPORT_ROWS) {
    return failParse('too_many_rows', `Максимум ${MAX_IMPORT_ROWS} строк`);
  }
  const rows = dataLines.map((line, index) => {
    const cells = parseCsvLine(line);
    const record = {};
    for (let i = 0; i < headers.length; i += 1) {
      record[headers[i]] = cells[i] ?? '';
    }
    return normalizeRow(record, index);
  });
  return {
    ok: true,
    schemaVersion: VK_STATS_SCHEMA_VERSION,
    format: 'csv',
    filename: meta.filename,
    sourceHash: meta.hash,
    bytes: meta.bytes,
    projectHint: null,
    groupHint: null,
    rows,
  };
}

function parseVkPostsContentCsv(lines, headers, meta) {
  const dataLines = lines.slice(1).filter((line) => line.trim().length > 0);
  if (dataLines.length > MAX_IMPORT_ROWS) {
    return failParse('too_many_rows', `Максимум ${MAX_IMPORT_ROWS} строк`);
  }
  const nativeRows = dataLines.map((line) => {
    const cells = parseCsvLine(line);
    const record = {};
    for (let i = 0; i < headers.length; i += 1) {
      record[headers[i]] = cells[i] ?? '';
    }
    return record;
  });
  const adapted = adaptVkPostsContentRows(nativeRows, { filename: meta.filename });
  if (!adapted.ok) {
    return failParse(adapted.error, adapted.message);
  }
  const rows = adapted.records.map((record, index) => normalizeRow(record, index));
  return {
    ok: true,
    schemaVersion: VK_STATS_SCHEMA_VERSION,
    format: 'vk_posts_content',
    filename: meta.filename,
    sourceHash: meta.hash,
    bytes: meta.bytes,
    projectHint: null,
    groupHint: adapted.groupId,
    rows,
  };
}

function normalizeRow(raw, index) {
  const errors = [];
  const wall = extractWallIds(raw.wall_url || raw.wallUrl || raw.url);
  const groupId = cleanId(raw.group_id ?? raw.groupId ?? wall?.groupId);
  const postId = cleanId(raw.post_id ?? raw.postId ?? wall?.postId);
  const observedAt = parseIso(raw.observed_at ?? raw.observedAt);
  const publishedAt = parseIso(raw.published_at ?? raw.publishedAt, true);
  const periodFrom = parseIso(raw.period_from ?? raw.periodFrom, true);
  const periodTo = parseIso(raw.period_to ?? raw.periodTo, true);
  const metricMode = String(raw.metric_mode ?? raw.metricMode ?? '').trim().toLowerCase();

  if (!groupId) errors.push({ code: 'missing_group_id', message: 'Нужен group_id' });
  if (!postId) errors.push({ code: 'missing_post_id', message: 'Нужен post_id или wall_url' });
  if (!observedAt.ok) errors.push({ code: 'invalid_observed_at', message: 'Невалидный observed_at' });
  if (!['cumulative', 'period'].includes(metricMode)) {
    errors.push({ code: 'invalid_metric_mode', message: 'metric_mode: cumulative|period' });
  }
  if (metricMode === 'period') {
    if (!periodFrom.ok || !periodTo.ok) {
      errors.push({ code: 'period_required', message: 'Для period нужны period_from и period_to' });
    } else if (periodFrom.value > periodTo.value) {
      errors.push({ code: 'period_order', message: 'period_from позже period_to' });
    }
  }
  if (publishedAt.present && !publishedAt.ok) {
    errors.push({ code: 'invalid_published_at', message: 'Невалидный published_at' });
  }
  if (publishedAt.ok && observedAt.ok && observedAt.value < publishedAt.value) {
    errors.push({ code: 'observed_before_publish', message: 'observed_at раньше published_at' });
  }

  const metrics = {};
  for (const field of [
    'views',
    'reach_total',
    'reach_organic',
    'reach_paid',
    'likes',
    'comments',
    'reposts',
    'saves',
    'clicks',
    'link_clicks',
    'subscribers_at_publish',
  ]) {
    const parsed = parseNullableInt(raw[field] ?? raw[camel(field)]);
    if (parsed.error) errors.push({ code: `invalid_${field}`, message: parsed.error });
    else metrics[field] = parsed.value;
  }
  const adSpend = parseNullableMoney(raw.ad_spend ?? raw.adSpend);
  if (adSpend.error) errors.push({ code: 'invalid_ad_spend', message: adSpend.error });
  else metrics.ad_spend = adSpend.value;
  const promoted = parseNullableBool(raw.promoted);
  if (promoted.error) errors.push({ code: 'invalid_promoted', message: promoted.error });
  else metrics.promoted = promoted.value;

  const textHintRaw = raw.text_hint ?? raw.textHint ?? null;
  const textHint =
    textHintRaw == null || textHintRaw === '' || EMPTY_CELL.has(String(textHintRaw).trim())
      ? null
      : String(textHintRaw).trim();

  return {
    rowIndex: index,
    valid: errors.length === 0,
    errors,
    groupId,
    postId,
    publishedAt: publishedAt.ok ? publishedAt.value : null,
    observedAt: observedAt.ok ? observedAt.value : null,
    periodFrom: periodFrom.ok ? periodFrom.value : null,
    periodTo: periodTo.ok ? periodTo.value : null,
    metricMode: ['cumulative', 'period'].includes(metricMode) ? metricMode : null,
    wallUrl: wall?.url || null,
    textHint,
    metrics,
  };
}

function camel(snake) {
  return snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function cleanId(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || EMPTY_CELL.has(text)) return null;
  if (!/^-?\d+$/.test(text)) return null;
  return text.replace(/^-/, '');
}

function parseIso(value, optional = false) {
  if (value == null || value === '' || EMPTY_CELL.has(String(value).trim())) {
    return optional ? { present: false, ok: true, value: null } : { present: false, ok: false, value: null };
  }
  const text = String(value).trim();
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return { present: true, ok: false, value: null };
  return { present: true, ok: true, value: new Date(ms).toISOString() };
}

function parseNullableInt(value) {
  if (value == null || value === '' || EMPTY_CELL.has(String(value).trim())) {
    return { value: null };
  }
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) return { error: 'Нужно целое число или пусто' };
  const n = Number(text);
  if (!Number.isInteger(n)) return { error: 'Дробные счётчики не принимаются' };
  if (n < 0) return { error: 'Отрицательные счётчики запрещены' };
  return { value: n };
}

function parseNullableMoney(value) {
  if (value == null || value === '' || EMPTY_CELL.has(String(value).trim())) {
    return { value: null };
  }
  const n = Number(String(value).trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return { error: 'Невалидный ad_spend' };
  return { value: Math.round(n * 100) / 100 };
}

function parseNullableBool(value) {
  if (value == null || value === '' || EMPTY_CELL.has(String(value).trim())) {
    return { value: null };
  }
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'да'].includes(text)) return { value: true };
  if (['0', 'false', 'no', 'n', 'нет'].includes(text)) return { value: false };
  return { error: 'promoted: true/false или пусто' };
}

export function extractWallIds(url) {
  if (!url) return null;
  const text = String(url).trim();
  if (!text) return null;
  const match = text.match(/wall(-?\d+)_(\d+)/i);
  if (!match) return null;
  return {
    groupId: match[1].replace(/^-/, ''),
    postId: match[2],
    url: text,
  };
}

function splitCsvLines(text) {
  const lines = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      lines.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.length) lines.push(current);
  return lines;
}

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells;
}
