import { createHash, randomUUID } from 'node:crypto';
import { bumpDataVersion, withTransaction } from '../db.mjs';
import { contentExpiresAt } from '../analytics/ttl.mjs';
import { openingPhrase, closingPhrase } from './phrases.mjs';
import {
  CLASSIFIER_VERSION,
  normalizeIntensity,
  normalizeStructure,
  normalizeTone,
} from './vocab.mjs';

const MEMORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function syncEditorialMemory(db, { projectId = null, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - MEMORY_WINDOW_MS).toISOString();
  const rows = projectId
    ? db
        .prepare(
          `SELECT e.*, d.delivery_id, d.external_id AS vk_post_id, d.sent_at, d.status AS delivery_status,
                  pf.media_actual AS feature_media, pf.topic AS feature_topic, pf.prompt_version_id,
                  pf.model_text
           FROM editions e
           JOIN deliveries d ON d.edition_id = e.edition_id
           LEFT JOIN post_features pf ON pf.edition_id = e.edition_id
           WHERE e.project_id = ?
             AND d.platform = 'vk'
             AND d.status = 'sent'
             AND d.sent_at IS NOT NULL
             AND d.sent_at >= ?
           ORDER BY d.sent_at DESC`,
        )
        .all(projectId, cutoff)
    : db
        .prepare(
          `SELECT e.*, d.delivery_id, d.external_id AS vk_post_id, d.sent_at, d.status AS delivery_status,
                  pf.media_actual AS feature_media, pf.topic AS feature_topic, pf.prompt_version_id,
                  pf.model_text
           FROM editions e
           JOIN deliveries d ON d.edition_id = e.edition_id
           LEFT JOIN post_features pf ON pf.edition_id = e.edition_id
           WHERE d.platform = 'vk'
             AND d.status = 'sent'
             AND d.sent_at IS NOT NULL
             AND d.sent_at >= ?
           ORDER BY d.sent_at DESC`,
        )
        .all(cutoff);

  let upserted = 0;
  withTransaction(db, () => {
    for (const row of rows) {
      upsertMemoryFromEdition(db, row, now);
      upserted += 1;
    }
    bumpDataVersion(db);
  });
  return { upserted };
}

export function upsertMemoryFromEdition(db, row, now = new Date()) {
  const existing = db
    .prepare('SELECT memory_id FROM editorial_memory WHERE edition_id = ?')
    .get(row.edition_id);
  const classified = classifyEdition(row);
  const bodyText = row.body_removed_at ? null : row.body_text;
  const iso = now.toISOString();
  const expiresAt = contentExpiresAt(row.sent_at || iso, now);
  const observations = listObservationIds(db, row.edition_id, row.project_id);
  const coverage = observationCoverage(db, row.project_id, row.edition_id);

  if (existing) {
    db.prepare(
      `UPDATE editorial_memory SET
        delivery_id = ?, vk_post_id = ?, sent_at = ?,
        body_text = CASE WHEN body_removed_at IS NOT NULL THEN NULL ELSE ? END,
        media_actual = ?, rubric_id = COALESCE(rubric_id, ?),
        topic_tags_json = ?, tone = CASE WHEN feature_source = 'manual' THEN tone ELSE ? END,
        intensity = CASE WHEN feature_source = 'manual' THEN intensity ELSE ? END,
        structure = CASE WHEN feature_source = 'manual' THEN structure ELSE ? END,
        author = COALESCE(author, ?), work_title = COALESCE(work_title, ?),
        quote_id = COALESCE(quote_id, ?), source_verified = COALESCE(source_verified, ?),
        opening_phrase = CASE WHEN body_removed_at IS NOT NULL THEN opening_phrase ELSE ? END,
        closing_phrase = CASE WHEN body_removed_at IS NOT NULL THEN closing_phrase ELSE ? END,
        prompt_version_id = COALESCE(?, prompt_version_id),
        model_text = COALESCE(?, model_text),
        observation_ids_json = ?, coverage_json = ?, observed_at = ?,
        classifier_version = ?, content_expires_at = COALESCE(content_expires_at, ?),
        updated_at = ?
       WHERE memory_id = ?`,
    ).run(
      row.delivery_id,
      row.vk_post_id,
      row.sent_at,
      bodyText,
      row.feature_media || row.media_actual || null,
      classified.rubricId,
      JSON.stringify(classified.topicTags),
      classified.tone,
      classified.intensity,
      classified.structure,
      classified.author,
      classified.workTitle,
      classified.quoteId,
      classified.sourceVerified,
      openingPhrase(bodyText || ''),
      closingPhrase(bodyText || ''),
      row.prompt_version_id || null,
      row.model_text || null,
      JSON.stringify(observations),
      JSON.stringify(coverage),
      coverage.observedAt,
      CLASSIFIER_VERSION,
      expiresAt,
      iso,
      existing.memory_id,
    );
    return existing.memory_id;
  }

  const memoryId = randomUUID();
  db.prepare(
    `INSERT INTO editorial_memory (
      memory_id, project_id, edition_id, delivery_id, vk_post_id, sent_at,
      body_text, content_expires_at, media_actual, rubric_id, topic_tags_json,
      tone, intensity, structure, author, work_title, quote_id, source_verified,
      opening_phrase, closing_phrase, prompt_version_id, model_text,
      observation_ids_json, coverage_json, observed_at, feature_source,
      classifier_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?)`,
  ).run(
    memoryId,
    row.project_id,
    row.edition_id,
    row.delivery_id,
    row.vk_post_id,
    row.sent_at,
    bodyText,
    expiresAt,
    row.feature_media || row.media_actual || null,
    classified.rubricId,
    JSON.stringify(classified.topicTags),
    classified.tone,
    classified.intensity,
    classified.structure,
    classified.author,
    classified.workTitle,
    classified.quoteId,
    classified.sourceVerified,
    openingPhrase(bodyText || ''),
    closingPhrase(bodyText || ''),
    row.prompt_version_id || null,
    row.model_text || null,
    JSON.stringify(observations),
    JSON.stringify(coverage),
    coverage.observedAt,
    CLASSIFIER_VERSION,
    iso,
    iso,
  );
  return memoryId;
}

export function listMemory(db, { projectId, limit = 100, now = new Date() } = {}) {
  if (!projectId) return [];
  const cutoff = new Date(now.getTime() - MEMORY_WINDOW_MS).toISOString();
  return db
    .prepare(
      `SELECT * FROM editorial_memory
       WHERE project_id = ?
         AND (sent_at IS NULL OR sent_at >= ?)
         AND (body_removed_at IS NULL OR body_text IS NULL OR 1=1)
       ORDER BY sent_at DESC LIMIT ?`,
    )
    .all(projectId, cutoff, limit)
    .map(mapMemory);
}

export function patchMemoryFeatures(db, memoryId, patch, now = new Date()) {
  const row = db.prepare('SELECT * FROM editorial_memory WHERE memory_id = ?').get(memoryId);
  if (!row) return { error: 'not_found', status: 404 };
  db.prepare(
    `UPDATE editorial_memory SET
      tone = ?, intensity = ?, structure = ?, rubric_id = ?,
      author = ?, work_title = ?, feature_source = 'manual',
      classifier_version = ?, updated_at = ?
     WHERE memory_id = ?`,
  ).run(
    normalizeTone(patch.tone ?? row.tone),
    normalizeIntensity(patch.intensity ?? row.intensity),
    normalizeStructure(patch.structure ?? row.structure),
    patch.rubricId ?? row.rubric_id,
    patch.author ?? row.author,
    patch.workTitle ?? row.work_title,
    CLASSIFIER_VERSION,
    now.toISOString(),
    memoryId,
  );
  bumpDataVersion(db);
  return { ok: true };
}

export function memoryFingerprint(rows) {
  const payload = rows.map((r) => ({
    memoryId: r.memoryId || r.memory_id,
    editionId: r.editionId || r.edition_id,
    sentAt: r.sentAt || r.sent_at,
    rubricId: r.rubricId || r.rubric_id,
    tone: r.tone,
    author: r.author,
    opening: r.openingPhrase || r.opening_phrase,
    closing: r.closingPhrase || r.closing_phrase,
    coverage: r.coverage || (r.coverage_json ? JSON.parse(r.coverage_json) : null),
  }));
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function classifyEdition(row) {
  const format = row.format || '';
  let rubricId = null;
  let structure = 'unknown';
  let tone = 'unknown';
  let intensity = 'unknown';
  let author = null;
  let workTitle = null;
  let quoteId = null;
  let sourceVerified = null;
  const topicTags = [];

  if (row.feature_topic) topicTags.push(row.feature_topic);
  if (row.topic) topicTags.push(row.topic);

  if (format === 'literary') {
    rubricId = 'dark-academia:quote';
    structure = 'quote_commentary';
    tone = 'reflective';
    intensity = 'medium';
    // quote metadata lives in generation JSON historically; mark unknown if absent
    quoteId = null;
    sourceVerified = 1;
  } else if (format === 'programming') {
    const brief = String(row.brief || '').toLowerCase();
    if (brief.includes('разбор') || brief.includes('solution')) {
      rubricId = 'code-to-think:solution';
      structure = 'solution';
    } else if (brief.includes('редактор') || brief.includes('editorial')) {
      rubricId = 'code-to-think:editorial';
      structure = 'editorial';
    } else {
      rubricId = 'code-to-think:task';
      structure = 'task';
    }
    tone = 'precise';
    intensity = 'medium';
  } else if (format === 'lifestyle') {
    rubricId = 'things:scenario';
    structure = 'scenario_tip';
    tone = 'calm';
    intensity = 'low';
  }

  return {
    rubricId,
    topicTags: [...new Set(topicTags.filter(Boolean))],
    tone: normalizeTone(tone),
    intensity: normalizeIntensity(intensity),
    structure: normalizeStructure(structure),
    author,
    workTitle,
    quoteId,
    sourceVerified,
  };
}

function listObservationIds(db, editionId, projectId) {
  try {
    return db
      .prepare(
        `SELECT observation_id FROM metric_observations
         WHERE project_id = ? AND edition_id = ? AND is_active = 1
         ORDER BY observed_at DESC LIMIT 10`,
      )
      .all(projectId, editionId)
      .map((r) => r.observation_id);
  } catch {
    return [];
  }
}

function observationCoverage(db, projectId, editionId) {
  try {
    const row = db
      .prepare(
        `SELECT observed_at, reach_organic, reach_paid, views
         FROM metric_observations
         WHERE project_id = ? AND edition_id = ? AND is_active = 1
         ORDER BY observed_at DESC LIMIT 1`,
      )
      .get(projectId, editionId);
    if (!row) {
      return { hasMetrics: false, observedAt: null, note: 'данных недостаточно' };
    }
    return {
      hasMetrics: true,
      observedAt: row.observed_at,
      reachOrganic: row.reach_organic,
      reachPaid: row.reach_paid,
      views: row.views,
    };
  } catch {
    return { hasMetrics: false, observedAt: null, note: 'данных недостаточно' };
  }
}

function mapMemory(row) {
  return {
    memoryId: row.memory_id,
    projectId: row.project_id,
    editionId: row.edition_id,
    deliveryId: row.delivery_id,
    vkPostId: row.vk_post_id,
    sentAt: row.sent_at,
    bodyText: row.body_removed_at ? null : row.body_text,
    bodyRemovedAt: row.body_removed_at,
    mediaActual: row.media_actual,
    rubricId: row.rubric_id,
    topicTags: JSON.parse(row.topic_tags_json || '[]'),
    tone: row.tone,
    intensity: row.intensity,
    structure: row.structure,
    author: row.author,
    workTitle: row.work_title,
    quoteId: row.quote_id,
    sourceVerified: row.source_verified,
    openingPhrase: row.opening_phrase,
    closingPhrase: row.closing_phrase,
    seriesId: row.series_id,
    episode: row.episode,
    seriesRole: row.series_role,
    predecessorId: row.predecessor_id,
    briefId: row.brief_id,
    promptVersionId: row.prompt_version_id,
    modelText: row.model_text,
    observationIds: JSON.parse(row.observation_ids_json || '[]'),
    coverage: JSON.parse(row.coverage_json || '{}'),
    observedAt: row.observed_at,
    featureSource: row.feature_source,
    classifierVersion: row.classifier_version,
    contentExpiresAt: row.content_expires_at,
  };
}
