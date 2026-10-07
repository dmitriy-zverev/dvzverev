import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { bumpDataVersion, getMeta, setMeta, withTransaction } from '../db.mjs';

export const CONTENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const IMPORT_RAW_TTL_MS = 24 * 60 * 60 * 1000;
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export function contentExpiresAt(publishedAt, now = new Date()) {
  const base = publishedAt ? Date.parse(publishedAt) : now.getTime();
  return new Date(base + CONTENT_TTL_MS).toISOString();
}

export function isContentExpired(edition, now = new Date()) {
  if (edition.body_removed_at) return true;
  if (edition.content_expires_at && edition.content_expires_at <= now.toISOString()) return true;
  return false;
}

export function runAnalyticsCleanup(db, {
  now = new Date(),
  force = false,
  uploadDir = null,
  mediaRoots = [],
} = {}) {
  if (!force) {
    const last = getMeta(db, 'analytics_cleanup_at');
    if (last && Date.parse(last) > now.getTime() - CLEANUP_INTERVAL_MS) {
      return { skipped: true, reason: 'not_due' };
    }
  }

  const iso = now.toISOString();
  const cutoff30d = new Date(now.getTime() - CONTENT_TTL_MS).toISOString();
  const cutoff24h = new Date(now.getTime() - IMPORT_RAW_TTL_MS).toISOString();
  const stats = {
    editionsScrubbed: 0,
    featuresCleared: 0,
    observationsRemoved: 0,
    recommendationsScrubbed: 0,
    importsPurged: 0,
    tombstonesWritten: 0,
    tombstonesExpired: 0,
    uploadFilesRemoved: 0,
    mediaFilesRemoved: 0,
  };

  withTransaction(db, () => {
    const expiredEditions = db
      .prepare(
        `SELECT e.*, d.delivery_id, d.destination_id, d.platform, d.external_id, d.vk_group_id, d.status AS delivery_status
         FROM editions e
         LEFT JOIN deliveries d ON d.edition_id = e.edition_id
         WHERE e.body_text IS NOT NULL
           AND (
             (e.content_expires_at IS NOT NULL AND e.content_expires_at <= ?)
             OR (e.content_expires_at IS NULL AND e.created_at <= ?)
           )`,
      )
      .all(iso, cutoff30d);

    const seenEditions = new Set();
    for (const row of expiredEditions) {
      if (!seenEditions.has(row.edition_id)) {
        const payloadHash = row.body_text
          ? createHash('sha256').update(row.body_text).digest('hex').slice(0, 16)
          : null;
        db.prepare(
          `UPDATE editions SET body_text = NULL, brief = NULL, body_removed_at = COALESCE(body_removed_at, ?), updated_at = ?
           WHERE edition_id = ?`,
        ).run(iso, iso, row.edition_id);
        db.prepare(
          `UPDATE post_features SET topic = NULL, updated_at = ? WHERE edition_id = ?`,
        ).run(iso, row.edition_id);
        stats.editionsScrubbed += 1;
        stats.featuresCleared += 1;
        seenEditions.add(row.edition_id);

        if (row.delivery_id) {
          db.prepare(
            `INSERT OR IGNORE INTO delivery_tombstones (
              tombstone_id, delivery_id, edition_id, project_id, destination_id, platform,
              external_id, vk_group_id, slot_key, outcome, payload_hash, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            randomUUID(),
            row.delivery_id,
            row.edition_id,
            row.project_id,
            row.destination_id,
            row.platform,
            row.external_id,
            row.vk_group_id,
            row.slot_key,
            row.delivery_status || 'sent',
            payloadHash,
            iso,
            new Date(now.getTime() + TOMBSTONE_TTL_MS).toISOString(),
          );
          stats.tombstonesWritten += 1;
        }
      }
    }

    // Cancel expired pending deliveries — no regenerate under same delivery_id.
    const pendingExpired = db
      .prepare(
        `SELECT d.delivery_id, e.edition_id FROM deliveries d
         JOIN editions e ON e.edition_id = d.edition_id
         WHERE d.status IN ('planned', 'generating')
           AND e.content_expires_at IS NOT NULL AND e.content_expires_at <= ?`,
      )
      .all(iso);
    for (const row of pendingExpired) {
      db.prepare(
        `UPDATE deliveries SET status = 'cancelled', failure_reason = 'expired', updated_at = ?
         WHERE delivery_id = ?`,
      ).run(iso, row.delivery_id);
    }

    const oldObs = db
      .prepare(
        `DELETE FROM metric_observations
         WHERE observed_at <= ?
           AND edition_id IN (SELECT edition_id FROM editions WHERE body_removed_at IS NOT NULL)`,
      )
      .run(cutoff30d);
    stats.observationsRemoved = oldObs.changes;

    // Scrub recommendation quotes older than TTL.
    const recs = db
      .prepare(`SELECT recommendation_id, evidence_json FROM recommendations WHERE created_at <= ?`)
      .all(cutoff30d);
    for (const rec of recs) {
      const evidence = JSON.parse(rec.evidence_json || '[]');
      const scrubbed = evidence.map((item) => {
        if (item && typeof item === 'object') {
          const next = { ...item };
          delete next.quote;
          delete next.bodyText;
          return next;
        }
        return item;
      });
      db.prepare(
        `UPDATE recommendations SET evidence_json = ?, updated_at = ? WHERE recommendation_id = ?`,
      ).run(JSON.stringify(scrubbed), iso, rec.recommendation_id);
      stats.recommendationsScrubbed += 1;
    }

    const imports = db
      .prepare(
        `SELECT import_id FROM metric_imports
         WHERE (content_expires_at IS NOT NULL AND content_expires_at <= ?)
            OR (status IN ('preview', 'rejected') AND created_at <= datetime(?, '-1 day'))
            OR (status = 'committed' AND committed_at IS NOT NULL AND committed_at <= datetime(?, '-1 day'))`,
      )
      .all(iso, iso, iso);
    for (const row of imports) {
      db.prepare('DELETE FROM metric_import_rows WHERE import_id = ?').run(row.import_id);
      // Keep minimal audit fields on import row; clear heavy preview JSON.
      db.prepare(
        `UPDATE metric_imports SET preview_json = NULL, commit_options_json = NULL,
          coverage_json = ?, updated_at = ?
         WHERE import_id = ?`,
      ).run(JSON.stringify({ purged: true }), iso, row.import_id);
      stats.importsPurged += 1;
    }

    const expiredTombs = db
      .prepare(`DELETE FROM delivery_tombstones WHERE expires_at <= ?`)
      .run(iso);
    stats.tombstonesExpired = expiredTombs.changes;

    // Compact monthly aggregates from remaining active observations (no body text).
    rollMonthlyAggregates(db, now);
    setMeta(db, 'analytics_cleanup_at', iso);
    bumpDataVersion(db);
  });

  if (uploadDir && existsSync(uploadDir)) {
    // Best-effort: remove files older than 24h by mtime is left to OS; explicit names not tracked.
    stats.uploadFilesRemoved = 0;
  }
  for (const root of mediaRoots) {
    if (!root || !existsSync(root)) continue;
    // Media purge for sent covers older than 30d is handled by maintenance.mjs; count only.
    stats.mediaFilesRemoved += 0;
  }

  // Checkpoint WAL to reclaim pages after deletes (not secure erase, but required step).
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // :memory: and some adapters may not support checkpoint.
  }

  return stats;
}

export function rollMonthlyAggregates(db, now = new Date()) {
  const ym = now.toISOString().slice(0, 7);
  const projects = db.prepare('SELECT DISTINCT project_id FROM metric_observations WHERE is_active = 1').all();
  for (const { project_id: projectId } of projects) {
    const rows = db
      .prepare(
        `SELECT reach_organic, reach_paid, views, likes, comments, reposts, saves
         FROM metric_observations
         WHERE project_id = ? AND is_active = 1 AND observed_at LIKE ?`,
      )
      .all(projectId, `${ym}%`);
    const summary = {
      observations: rows.length,
      organicReachSum: sum(rows.map((r) => r.reach_organic)),
      paidReachSum: sum(rows.map((r) => r.reach_paid)),
      viewsSum: sum(rows.map((r) => r.views)),
      note: 'Агрегат без текстов постов; сумма reach ≠ уникальный охват',
    };
    db.prepare(
      `INSERT INTO monthly_aggregates (
        aggregate_id, project_id, period_ym, metric_key, segment_key, value_json, coverage_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'overview', 'all', ?, ?, ?, ?)
      ON CONFLICT(project_id, period_ym, metric_key, segment_key) DO UPDATE SET
        value_json = excluded.value_json,
        coverage_json = excluded.coverage_json,
        updated_at = excluded.updated_at`,
    ).run(
      `${projectId}:${ym}:overview`,
      projectId,
      ym,
      JSON.stringify(summary),
      JSON.stringify({ observations: rows.length }),
      now.toISOString(),
      now.toISOString(),
    );
  }
}

function sum(values) {
  let total = 0;
  let any = false;
  for (const v of values) {
    if (v == null) continue;
    total += v;
    any = true;
  }
  return any ? total : null;
}

export function hideExpiredPayload(edition, now = new Date()) {
  if (!isContentExpired(edition, now)) {
    return {
      bodyText: edition.body_text,
      brief: edition.brief,
      bodyNotice: null,
    };
  }
  return {
    bodyText: null,
    brief: null,
    bodyNotice: 'содержимое удалено после 30 дней',
  };
}
