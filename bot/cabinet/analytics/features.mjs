import { contentExpiresAt } from './ttl.mjs';
import { promptHashesForEdition } from './prompts.mjs';

export function upsertPostFeatures(db, {
  editionId,
  projectId,
  format,
  topic,
  bodyText,
  mediaPlanned,
  mediaActual,
  slotKey,
  models,
  experimentVariant = null,
  experimentId = null,
  publishedAt = null,
  promptVersionId = null,
  now = new Date(),
}) {
  const hashes = promptHashesForEdition(db, projectId);
  const bodyLength = typeof bodyText === 'string' ? bodyText.length : null;
  const slotMeta = parseSlotKey(slotKey);
  db.prepare(
    `INSERT INTO post_features (
      edition_id, project_id, format, topic, language, body_length,
      media_planned, media_actual, slot_local_time, slot_weekday,
      model_text, model_review, model_media, prompt_version_id, prompt_hashes_json,
      experiment_id, experiment_variant, published_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(edition_id) DO UPDATE SET
      topic = COALESCE(excluded.topic, post_features.topic),
      body_length = COALESCE(excluded.body_length, post_features.body_length),
      media_planned = COALESCE(excluded.media_planned, post_features.media_planned),
      media_actual = COALESCE(excluded.media_actual, post_features.media_actual),
      model_text = COALESCE(excluded.model_text, post_features.model_text),
      model_review = COALESCE(excluded.model_review, post_features.model_review),
      model_media = COALESCE(excluded.model_media, post_features.model_media),
      prompt_version_id = COALESCE(excluded.prompt_version_id, post_features.prompt_version_id),
      prompt_hashes_json = excluded.prompt_hashes_json,
      experiment_variant = COALESCE(excluded.experiment_variant, post_features.experiment_variant),
      published_at = COALESCE(excluded.published_at, post_features.published_at),
      updated_at = excluded.updated_at`,
  ).run(
    editionId,
    projectId,
    format || null,
    topic || null,
    detectLanguage(bodyText),
    bodyLength,
    mediaPlanned || null,
    mediaActual || null,
    slotMeta.localTime,
    slotMeta.weekday,
    models?.text || null,
    models?.review || null,
    models?.media || null,
    promptVersionId,
    JSON.stringify(hashes),
    experimentId,
    experimentVariant,
    publishedAt,
    now.toISOString(),
    now.toISOString(),
  );

  // Once published, TTL is published_at+30d (spec). Provisional expiry from generation
  // must be replaced when sentAt arrives — COALESCE alone freezes the early clock.
  const publishedIso = publishedAt || null;
  const provisionalExpiry = contentExpiresAt(now.toISOString(), now);
  const publishedExpiry = publishedIso ? contentExpiresAt(publishedIso, now) : null;
  db.prepare(
    `UPDATE editions SET
      media_planned = COALESCE(?, media_planned),
      media_actual = COALESCE(?, media_actual),
      prompt_hashes_json = ?,
      experiment_variant = COALESCE(?, experiment_variant),
      content_expires_at = CASE
        WHEN ? IS NOT NULL THEN ?
        ELSE COALESCE(content_expires_at, ?)
      END,
      updated_at = ?
     WHERE edition_id = ?`,
  ).run(
    mediaPlanned || null,
    mediaActual || null,
    JSON.stringify(hashes),
    experimentVariant,
    publishedIso,
    publishedExpiry,
    provisionalExpiry,
    now.toISOString(),
    editionId,
  );

  return hashes;
}

export function inferMediaActual(entry) {
  if (entry?.image?.status === 'attached' || entry?.image?.gifPath || entry?.image?.path) {
    if (entry.image?.kind === 'video' || entry.image?.videoPath) return 'gif';
    return entry.image?.kind || 'image';
  }
  if (entry?.image?.status === 'failed' || entry?.image?.fallback === 'text') return 'text_fallback';
  return 'none';
}

function parseSlotKey(slotKey) {
  if (!slotKey || typeof slotKey !== 'string') return { localTime: null, weekday: null };
  // Formats like 2026-10-06T18:00 or 2026-10-06 18:00 Europe/Moscow
  const match = slotKey.match(/(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  if (!match) return { localTime: null, weekday: null };
  const date = new Date(`${match[1]}T${match[2]}:00+03:00`);
  const weekday = Number.isFinite(date.getTime()) ? ((date.getUTCDay() + 6) % 7) + 1 : null;
  return { localTime: match[2], weekday };
}

function detectLanguage(text) {
  if (!text) return null;
  if (/[а-яё]/i.test(text)) return 'ru';
  if (/[a-z]/i.test(text)) return 'en';
  return 'unknown';
}
