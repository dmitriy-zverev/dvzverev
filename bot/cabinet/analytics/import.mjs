import { createHash, randomUUID } from 'node:crypto';
import { bumpDataVersion, withTransaction } from '../db.mjs';
import { parseImportFile, VK_STATS_SCHEMA_VERSION } from './parse.mjs';

const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const ACTIVE_IMPORT_LIMIT = 3;

export function buildImportPreview(db, {
  projectId,
  vkGroupId,
  observedAt,
  reportWeek = null,
  metricMode = 'cumulative',
  periodFrom = null,
  periodTo = null,
  buffer,
  filename,
  now = new Date(),
}) {
  if (!projectId || !vkGroupId) {
    return { error: 'project_and_group_required', status: 400 };
  }
  const project = db.prepare('SELECT project_id FROM projects WHERE project_id = ?').get(projectId);
  if (!project) return { error: 'unknown_project', status: 404 };

  const activeCount = db
    .prepare(`SELECT COUNT(*) AS c FROM metric_imports WHERE status = 'preview' AND content_expires_at > ?`)
    .get(now.toISOString()).c;
  if (activeCount >= ACTIVE_IMPORT_LIMIT) {
    return { error: 'too_many_active_imports', status: 429 };
  }

  const parsed = parseImportFile(buffer, { filename });
  if (!parsed.ok) {
    return { error: parsed.error, message: parsed.message, status: 400 };
  }

  const existing = db
    .prepare('SELECT import_id, status FROM metric_imports WHERE project_id = ? AND source_hash = ?')
    .get(projectId, parsed.sourceHash);
  if (existing?.status === 'committed') {
    return {
      error: 'duplicate_file',
      message: 'Тот же файл уже импортирован для проекта',
      importId: existing.import_id,
      status: 409,
    };
  }

  const expectedGroup = String(vkGroupId).replace(/^-/, '');
  const matched = [];
  const rows = [];
  let validCount = 0;
  let errorCount = 0;
  let matchedCount = 0;
  let unknownCount = 0;
  let duplicateCount = 0;
  let foreignGroupCount = 0;
  const seenKeys = new Set();

  for (const row of parsed.rows) {
    const result = {
      rowIndex: row.rowIndex,
      status: 'ok',
      errors: [...row.errors],
      groupId: row.groupId,
      postId: row.postId,
      observedAt: row.observedAt || observedAt,
      periodFrom: row.periodFrom || periodFrom,
      periodTo: row.periodTo || periodTo,
      metricMode: row.metricMode || metricMode,
      metrics: row.metrics,
      match: null,
      anomalyFlags: [],
    };

    if (row.groupId && row.groupId !== expectedGroup) {
      result.errors.push({ code: 'foreign_group', message: 'Данные чужой группы' });
      foreignGroupCount += 1;
    }

    if (!result.observedAt) {
      result.errors.push({ code: 'missing_observed_at', message: 'Нужен observed_at' });
    }

    if (result.errors.length === 0) {
      const key = observationKey({
        projectId,
        postId: row.postId,
        source: 'vk_export',
        observedAt: result.observedAt,
        metricMode: result.metricMode,
        periodFrom: result.periodFrom,
        periodTo: result.periodTo,
      });
      if (seenKeys.has(key)) {
        result.errors.push({ code: 'duplicate_row', message: 'Дубликат строки в файле' });
        duplicateCount += 1;
      } else {
        seenKeys.add(key);
      }
    }

    if (result.errors.length === 0) {
      const delivery = findDelivery(db, projectId, expectedGroup, row.postId);
      if (delivery) {
        result.match = {
          kind: 'delivery',
          editionId: delivery.edition_id,
          deliveryId: delivery.delivery_id,
          publishedAt: delivery.sent_at,
        };
        if (delivery.sent_at && result.observedAt < delivery.sent_at) {
          result.errors.push({ code: 'observed_before_publish', message: 'observed_at раньше публикации' });
        } else {
          matchedCount += 1;
          matched.push(result);
          const prior = latestActiveObservation(db, projectId, row.postId, result.metricMode);
          if (prior && result.metricMode === 'cumulative') {
            for (const field of ['views', 'reach_total', 'likes', 'comments', 'reposts', 'saves']) {
              const prev = prior[field];
              const next = result.metrics[field];
              if (prev != null && next != null && next < prev) {
                result.anomalyFlags.push(`cumulative_drop_${field}`);
              }
            }
          }
        }
      } else {
        result.match = { kind: 'unknown', editionId: null, deliveryId: null };
        unknownCount += 1;
      }
    }

    if (result.errors.length) {
      result.status = 'error';
      errorCount += 1;
    } else {
      result.status = result.match?.kind === 'unknown' ? 'unmatched' : 'ok';
      validCount += 1;
    }
    rows.push(result);
  }

  const windowStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const sentCount = db
    .prepare(
      `SELECT COUNT(*) AS c FROM deliveries
       WHERE project_id = ? AND status = 'sent' AND sent_at >= ?
         AND REPLACE(IFNULL(vk_group_id,''), '-', '') = ?`,
    )
    .get(projectId, windowStart, expectedGroup).c;

  const coverage = {
    sentInWindow: sentCount,
    matchedInFile: matchedCount,
    unknownInFile: unknownCount,
    postsWithStats: matchedCount,
    coverageRatio: sentCount > 0 ? matchedCount / sentCount : null,
  };

  const importId = existing?.import_id || randomUUID();
  const expiresAt = new Date(now.getTime() + PREVIEW_TTL_MS).toISOString();
  const preview = {
    rowCount: rows.length,
    validCount,
    errorCount,
    matchedCount,
    unknownCount,
    duplicateCount,
    foreignGroupCount,
    anomalyCount: rows.filter((r) => r.anomalyFlags.length).length,
    canCommitStrict: errorCount === 0,
    emptyMeans: 'нет данных (null), не ноль',
    timezoneNote: 'даты ISO UTC; отображение в кабинете — Europe/Moscow',
  };

  try {
    withTransaction(db, () => {
      db.prepare('DELETE FROM metric_import_rows WHERE import_id = ?').run(importId);
      db.prepare(
        `INSERT INTO metric_imports (
        import_id, project_id, vk_group_id, source, source_hash, schema_version, status,
        report_week, observed_at, period_from, period_to, metric_mode, filename, raw_bytes,
        row_count, valid_count, error_count, matched_count, unknown_count, duplicate_count,
        coverage_json, preview_json, revision, content_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'vk_export', ?, ?, 'preview', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(import_id) DO UPDATE SET
        status = 'preview',
        observed_at = excluded.observed_at,
        period_from = excluded.period_from,
        period_to = excluded.period_to,
        metric_mode = excluded.metric_mode,
        filename = excluded.filename,
        raw_bytes = excluded.raw_bytes,
        row_count = excluded.row_count,
        valid_count = excluded.valid_count,
        error_count = excluded.error_count,
        matched_count = excluded.matched_count,
        unknown_count = excluded.unknown_count,
        duplicate_count = excluded.duplicate_count,
        coverage_json = excluded.coverage_json,
        preview_json = excluded.preview_json,
        content_expires_at = excluded.content_expires_at,
        updated_at = excluded.updated_at,
        reverted_at = NULL,
        committed_at = NULL`,
      ).run(
      importId,
      projectId,
      expectedGroup,
      parsed.sourceHash,
      parsed.schemaVersion || VK_STATS_SCHEMA_VERSION,
      reportWeek,
      observedAt,
      periodFrom,
      periodTo,
      metricMode,
      filename || parsed.filename,
      parsed.bytes,
      rows.length,
      validCount,
      errorCount,
      matchedCount,
      unknownCount,
      duplicateCount,
      JSON.stringify(coverage),
      JSON.stringify(preview),
      expiresAt,
      now.toISOString(),
      now.toISOString(),
    );

    const insertRow = db.prepare(
      `INSERT INTO metric_import_rows (
        row_id, import_id, row_index, status, vk_group_id, vk_post_id, edition_id, delivery_id,
        match_kind, error_code, error_message, payload_json, excluded, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    );
    for (const row of rows) {
      insertRow.run(
        randomUUID(),
        importId,
        row.rowIndex,
        row.status,
        row.groupId,
        row.postId,
        row.match?.editionId || null,
        row.match?.deliveryId || null,
        row.match?.kind || null,
        row.errors[0]?.code || null,
        row.errors[0]?.message || null,
        JSON.stringify(row),
        now.toISOString(),
      );
    }
      bumpDataVersion(db);
    });
  } catch (error) {
    if (String(error.message || '').includes('UNIQUE')) {
      return {
        error: 'duplicate_file',
        message: 'Конфликт одновременного preview того же файла',
        status: 409,
      };
    }
    throw error;
  }

  return {
    importId,
    status: 'preview',
    sourceHash: parsed.sourceHash,
    schemaVersion: parsed.schemaVersion || VK_STATS_SCHEMA_VERSION,
    matchedCount,
    unknownCount,
    errorCount,
    validCount,
    preview,
    coverage,
    rows,
    contentExpiresAt: expiresAt,
  };
}

export function commitImport(db, importId, {
  mode = 'strict',
  confirmAnomalies = false,
  idempotencyKey = null,
  allowUnmatchedAsExternal = false,
  now = new Date(),
} = {}) {
  const imp = db.prepare('SELECT * FROM metric_imports WHERE import_id = ?').get(importId);
  if (!imp) return { error: 'not_found', status: 404 };
  if (imp.status === 'committed') {
    return {
      importId,
      status: 'committed',
      idempotent: true,
      revision: imp.revision,
      applied: 0,
      skipped: 0,
      errors: 0,
    };
  }
  if (imp.status !== 'preview') return { error: 'not_preview', status: 409 };
  if (imp.content_expires_at && imp.content_expires_at < now.toISOString()) {
    return { error: 'preview_expired', status: 410 };
  }

  const rows = db
    .prepare('SELECT * FROM metric_import_rows WHERE import_id = ? ORDER BY row_index')
    .all(importId)
    .map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));

  const invalid = rows.filter((row) => row.status === 'error');
  if (mode === 'strict' && invalid.length) {
    return {
      error: 'validation_blocked',
      status: 400,
      message: 'Невалидные строки блокируют commit; выберите valid_only',
      errors: invalid.length,
    };
  }
  if (mode !== 'strict' && mode !== 'valid_only') {
    return { error: 'invalid_mode', status: 400 };
  }

  const anomalies = rows.filter((row) => (row.payload.anomalyFlags || []).length);
  if (anomalies.length && !confirmAnomalies) {
    return {
      error: 'anomaly_confirmation_required',
      status: 409,
      anomalyCount: anomalies.length,
      message: 'Снижение cumulative-счётчика требует confirmAnomalies=true',
    };
  }

  let applied = 0;
  let skipped = 0;
  let errors = 0;
  const exclusions = [];

  withTransaction(db, () => {
    const nextRevision = Number(imp.revision || 0) + 1;
    for (const row of rows) {
      if (row.status === 'error') {
        if (mode === 'valid_only') {
          db.prepare('UPDATE metric_import_rows SET excluded = 1 WHERE row_id = ?').run(row.row_id);
          exclusions.push({ rowIndex: row.row_index, code: row.error_code, message: row.error_message });
          skipped += 1;
          continue;
        }
        errors += 1;
        continue;
      }

      const payload = row.payload;
      let editionId = row.edition_id;
      let deliveryId = row.delivery_id;

      if (!editionId && allowUnmatchedAsExternal && payload.postId) {
        const external = ensureExternalEdition(db, imp, payload, now);
        editionId = external.editionId;
        deliveryId = external.deliveryId;
        db.prepare(
          'UPDATE metric_import_rows SET edition_id = ?, delivery_id = ?, match_kind = ? WHERE row_id = ?',
        ).run(editionId, deliveryId, 'external', row.row_id);
      }

      if (!editionId && !allowUnmatchedAsExternal && payload.match?.kind === 'unknown') {
        skipped += 1;
        continue;
      }

      upsertObservation(db, {
        projectId: imp.project_id,
        editionId,
        deliveryId,
        vkGroupId: imp.vk_group_id,
        vkPostId: payload.postId,
        source: imp.source,
        sourceHash: imp.source_hash,
        importId: imp.import_id,
        importRevision: nextRevision,
        observedAt: payload.observedAt || imp.observed_at,
        periodFrom: payload.periodFrom || imp.period_from,
        periodTo: payload.periodTo || imp.period_to,
        metricMode: payload.metricMode || imp.metric_mode,
        publishedAt: payload.match?.publishedAt || payload.publishedAt || null,
        metrics: payload.metrics,
        schemaVersion: imp.schema_version,
        anomalyFlags: payload.anomalyFlags || [],
        now,
      });
      applied += 1;
    }

    db.prepare(
      `UPDATE metric_imports SET
        status = 'committed',
        revision = ?,
        committed_at = ?,
        commit_options_json = ?,
        content_expires_at = ?,
        updated_at = ?
       WHERE import_id = ?`,
    ).run(
      nextRevision,
      now.toISOString(),
      JSON.stringify({ mode, confirmAnomalies, idempotencyKey, allowUnmatchedAsExternal, exclusions }),
      new Date(now.getTime() + PREVIEW_TTL_MS).toISOString(),
      now.toISOString(),
      importId,
    );

    db.prepare(
      `INSERT INTO audit_log (audit_id, actor, action, plan_id, payload_json, created_at)
       VALUES (?, 'owner', 'metrics_import_commit', NULL, ?, ?)`,
    ).run(
      randomUUID(),
      JSON.stringify({
        importId,
        revision: nextRevision,
        applied,
        skipped,
        errors: exclusions.length,
        sourceHash: imp.source_hash,
        rowCount: imp.row_count,
      }),
      now.toISOString(),
    );
    bumpDataVersion(db);
  });

  const refreshed = db.prepare('SELECT revision FROM metric_imports WHERE import_id = ?').get(importId);
  return {
    importId,
    status: 'committed',
    revision: refreshed.revision,
    applied,
    skipped,
    errors: exclusions.length,
    exclusions,
    postsWithoutStats: Math.max(0, (JSON.parse(imp.coverage_json || '{}').sentInWindow || 0) - applied),
  };
}

export function revertImport(db, importId, { now = new Date() } = {}) {
  const imp = db.prepare('SELECT * FROM metric_imports WHERE import_id = ?').get(importId);
  if (!imp) return { error: 'not_found', status: 404 };
  if (imp.status !== 'committed') return { error: 'not_committed', status: 409 };

  let deactivated = 0;
  withTransaction(db, () => {
    const result = db
      .prepare(
        `UPDATE metric_observations SET is_active = 0, updated_at = ?
         WHERE import_id = ? AND import_revision = ? AND is_active = 1`,
      )
      .run(now.toISOString(), importId, imp.revision);
    deactivated = result.changes;

    // Reactivate previous revision for same identity when present.
    const rows = db
      .prepare(
        `SELECT project_id, vk_post_id, source, observed_at, metric_mode, period_from, period_to
         FROM metric_observations WHERE import_id = ? AND import_revision = ?`,
      )
      .all(importId, imp.revision);
    for (const row of rows) {
      const prior = db
        .prepare(
          `SELECT observation_id FROM metric_observations
           WHERE project_id = ? AND vk_post_id = ? AND source = ? AND observed_at = ?
             AND metric_mode = ? AND IFNULL(period_from,'') = IFNULL(?, '')
             AND IFNULL(period_to,'') = IFNULL(?, '')
             AND is_active = 0 AND import_id != ?
           ORDER BY revision DESC LIMIT 1`,
        )
        .get(
          row.project_id,
          row.vk_post_id,
          row.source,
          row.observed_at,
          row.metric_mode,
          row.period_from,
          row.period_to,
          importId,
        );
      if (prior) {
        db.prepare('UPDATE metric_observations SET is_active = 1, updated_at = ? WHERE observation_id = ?').run(
          now.toISOString(),
          prior.observation_id,
        );
      }
    }

    db.prepare(
      `UPDATE metric_imports SET status = 'reverted', reverted_at = ?, updated_at = ? WHERE import_id = ?`,
    ).run(now.toISOString(), now.toISOString(), importId);

    db.prepare(
      `INSERT INTO audit_log (audit_id, actor, action, plan_id, payload_json, created_at)
       VALUES (?, 'owner', 'metrics_import_revert', NULL, ?, ?)`,
    ).run(
      randomUUID(),
      JSON.stringify({ importId, revision: imp.revision, deactivated }),
      now.toISOString(),
    );
    bumpDataVersion(db);
  });

  return { importId, status: 'reverted', deactivated };
}

export function listImports(db, { projectId = null, limit = 50 } = {}) {
  const params = [];
  let sql = 'SELECT * FROM metric_imports';
  if (projectId) {
    sql += ' WHERE project_id = ?';
    params.push(projectId);
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(Math.min(100, limit));
  return db.prepare(sql).all(...params).map(serializeImport);
}

export function getImport(db, importId) {
  const imp = db.prepare('SELECT * FROM metric_imports WHERE import_id = ?').get(importId);
  if (!imp) return null;
  const rows = db
    .prepare('SELECT * FROM metric_import_rows WHERE import_id = ? ORDER BY row_index')
    .all(importId)
    .map((row) => ({
      rowId: row.row_id,
      rowIndex: row.row_index,
      status: row.status,
      groupId: row.vk_group_id,
      postId: row.vk_post_id,
      editionId: row.edition_id,
      deliveryId: row.delivery_id,
      matchKind: row.match_kind,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      excluded: row.excluded === 1,
      payload: JSON.parse(row.payload_json),
    }));
  return { ...serializeImport(imp), rows };
}

function serializeImport(row) {
  return {
    importId: row.import_id,
    projectId: row.project_id,
    vkGroupId: row.vk_group_id,
    source: row.source,
    sourceHash: row.source_hash,
    schemaVersion: row.schema_version,
    status: row.status,
    reportWeek: row.report_week,
    observedAt: row.observed_at,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    metricMode: row.metric_mode,
    filename: row.filename,
    rowCount: row.row_count,
    validCount: row.valid_count,
    errorCount: row.error_count,
    matchedCount: row.matched_count,
    unknownCount: row.unknown_count,
    duplicateCount: row.duplicate_count,
    coverage: JSON.parse(row.coverage_json || '{}'),
    preview: JSON.parse(row.preview_json || '{}'),
    revision: row.revision,
    committedAt: row.committed_at,
    revertedAt: row.reverted_at,
    contentExpiresAt: row.content_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function observationKey({ projectId, postId, source, observedAt, metricMode, periodFrom, periodTo }) {
  return [projectId, postId, source, observedAt, metricMode, periodFrom || '', periodTo || ''].join('\0');
}

function findDelivery(db, projectId, vkGroupId, vkPostId) {
  return db
    .prepare(
      `SELECT delivery_id, edition_id, sent_at, external_id, vk_group_id
       FROM deliveries
       WHERE project_id = ? AND status = 'sent'
         AND external_id = ?
         AND REPLACE(IFNULL(vk_group_id,''), '-', '') = ?
       ORDER BY sent_at DESC LIMIT 1`,
    )
    .get(projectId, String(vkPostId), String(vkGroupId));
}

function latestActiveObservation(db, projectId, vkPostId, metricMode) {
  return db
    .prepare(
      `SELECT * FROM metric_observations
       WHERE project_id = ? AND vk_post_id = ? AND metric_mode = ? AND is_active = 1
       ORDER BY observed_at DESC LIMIT 1`,
    )
    .get(projectId, String(vkPostId), metricMode);
}

function upsertObservation(db, input) {
  const existing = db
    .prepare(
      `SELECT * FROM metric_observations
       WHERE project_id = ? AND vk_post_id = ? AND source = ? AND observed_at = ?
         AND metric_mode = ? AND IFNULL(period_from,'') = IFNULL(?, '')
         AND IFNULL(period_to,'') = IFNULL(?, '') AND is_active = 1
       ORDER BY revision DESC LIMIT 1`,
    )
    .get(
      input.projectId,
      input.vkPostId,
      input.source,
      input.observedAt,
      input.metricMode,
      input.periodFrom,
      input.periodTo,
    );

  if (existing) {
    const same = metricsEqual(existing, input.metrics);
    if (same && existing.import_id === input.importId) return existing.observation_id;
    db.prepare(
      `UPDATE metric_observations SET is_active = 0, replaced_by = ?, updated_at = ? WHERE observation_id = ?`,
    ).run('pending', input.now.toISOString(), existing.observation_id);
  }

  const observationId = createHash('sha256')
    .update(
      [
        input.projectId,
        input.vkPostId,
        input.source,
        input.observedAt,
        input.metricMode,
        input.periodFrom || '',
        input.periodTo || '',
        String((existing?.revision || 0) + 1),
      ].join('\0'),
    )
    .digest('hex')
    .slice(0, 32);

  const revision = (existing?.revision || 0) + 1;
  db.prepare(
    `INSERT INTO metric_observations (
      observation_id, project_id, edition_id, delivery_id, vk_group_id, vk_post_id,
      source, source_hash, import_id, import_revision, observed_at, period_from, period_to,
      metric_mode, published_at, views, reach_total, reach_organic, reach_paid, likes,
      comments, reposts, saves, clicks, link_clicks, subscribers_at_publish, ad_spend,
      promoted, schema_version, is_active, revision, anomaly_flags_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  ).run(
    observationId,
    input.projectId,
    input.editionId || null,
    input.deliveryId || null,
    input.vkGroupId,
    input.vkPostId,
    input.source,
    input.sourceHash,
    input.importId,
    input.importRevision,
    input.observedAt,
    input.periodFrom,
    input.periodTo,
    input.metricMode,
    input.publishedAt,
    input.metrics.views ?? null,
    input.metrics.reach_total ?? null,
    input.metrics.reach_organic ?? null,
    input.metrics.reach_paid ?? null,
    input.metrics.likes ?? null,
    input.metrics.comments ?? null,
    input.metrics.reposts ?? null,
    input.metrics.saves ?? null,
    input.metrics.clicks ?? null,
    input.metrics.link_clicks ?? null,
    input.metrics.subscribers_at_publish ?? null,
    input.metrics.ad_spend ?? null,
    input.metrics.promoted == null ? null : input.metrics.promoted ? 1 : 0,
    input.schemaVersion,
    revision,
    JSON.stringify(input.anomalyFlags || []),
    input.now.toISOString(),
    input.now.toISOString(),
  );

  if (existing) {
    db.prepare('UPDATE metric_observations SET replaced_by = ? WHERE observation_id = ?').run(
      observationId,
      existing.observation_id,
    );
  }
  return observationId;
}

function metricsEqual(existing, metrics) {
  const fields = [
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
  ];
  for (const field of fields) {
    if ((existing[field] ?? null) !== (metrics[field] ?? null)) return false;
  }
  const promoted = metrics.promoted == null ? null : metrics.promoted ? 1 : 0;
  return (existing.promoted ?? null) === promoted;
}

function ensureExternalEdition(db, imp, payload, now) {
  const editionId = createHash('sha256')
    .update(`external\0${imp.project_id}\0${imp.vk_group_id}\0${payload.postId}`)
    .digest('hex')
    .slice(0, 32);
  const deliveryId = `external:${imp.vk_group_id}:${payload.postId}`;
  const existing = db.prepare('SELECT edition_id FROM editions WHERE edition_id = ?').get(editionId);
  if (!existing) {
    db.prepare(
      `INSERT INTO editions (
        edition_id, project_id, slot_key, format, topic, brief, body_text, body_removed_at,
        prompt_version, models_json, cost_usd, aggregate_status, is_external, created_at, updated_at
      ) VALUES (?, ?, NULL, 'external', NULL, NULL, NULL, NULL, 'unknown', NULL, NULL, 'sent', 1, ?, ?)`,
    ).run(editionId, imp.project_id, payload.publishedAt || now.toISOString(), now.toISOString());
  }
  const existingDelivery = db.prepare('SELECT delivery_id FROM deliveries WHERE delivery_id = ?').get(deliveryId);
  if (!existingDelivery) {
    db.prepare(
      `INSERT INTO deliveries (
        delivery_id, edition_id, project_id, destination_id, platform, status, post_id,
        external_id, vk_group_id, attempts, sent_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'external-vk', 'vk', 'sent', NULL, ?, ?, 0, ?, ?, ?)`,
    ).run(
      deliveryId,
      editionId,
      imp.project_id,
      payload.postId,
      imp.vk_group_id,
      payload.publishedAt || now.toISOString(),
      now.toISOString(),
      now.toISOString(),
    );
  }
  return { editionId, deliveryId };
}
