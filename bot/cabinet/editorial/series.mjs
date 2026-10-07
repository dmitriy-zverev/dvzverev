import { randomUUID } from 'node:crypto';
import { bumpDataVersion, withTransaction } from '../db.mjs';
import { SERIES_STATUSES } from './vocab.mjs';

export function createSeries(
  db,
  {
    projectId,
    title,
    goal = null,
    stages = [],
    plannedEndAt = null,
    status = 'draft',
    now = new Date(),
  },
) {
  if (!projectId || !title?.trim()) return { error: 'invalid_series', status: 400 };
  if (!SERIES_STATUSES.includes(status)) return { error: 'invalid_status', status: 400 };
  const seriesId = randomUUID();
  const iso = now.toISOString();
  db.prepare(
    `INSERT INTO editorial_series (
      series_id, project_id, title, goal, stages_json, planned_end_at, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    seriesId,
    projectId,
    title.trim(),
    goal,
    JSON.stringify(stages),
    plannedEndAt,
    status,
    iso,
    iso,
  );
  bumpDataVersion(db);
  return { seriesId, status };
}

export function listSeries(db, { projectId, limit = 50 } = {}) {
  const rows = projectId
    ? db
        .prepare(
          `SELECT * FROM editorial_series WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(projectId, limit)
    : db.prepare(`SELECT * FROM editorial_series ORDER BY updated_at DESC LIMIT ?`).all(limit);
  return rows.map(mapSeries);
}

export function getSeries(db, seriesId) {
  const row = db.prepare('SELECT * FROM editorial_series WHERE series_id = ?').get(seriesId);
  if (!row) return null;
  const episodes = db
    .prepare(
      `SELECT * FROM editorial_series_episodes WHERE series_id = ? ORDER BY episode_number ASC`,
    )
    .all(seriesId)
    .map(mapEpisode);
  return { ...mapSeries(row), episodes };
}

export function addEpisode(
  db,
  {
    seriesId,
    projectId,
    episodeNumber,
    planId = null,
    editionId = null,
    briefId = null,
    predecessorEpisodeId = null,
    role = null,
    status = 'planned',
    now = new Date(),
  },
) {
  const series = db.prepare('SELECT * FROM editorial_series WHERE series_id = ?').get(seriesId);
  if (!series) return { error: 'series_not_found', status: 404 };
  if (series.project_id !== projectId) return { error: 'project_mismatch', status: 400 };

  if (predecessorEpisodeId) {
    const cycle = wouldCreateCycle(db, seriesId, predecessorEpisodeId, null);
    if (cycle) return { error: 'cyclic_dependency', status: 400, message: cycle };
  }

  const episodeId = randomUUID();
  const iso = now.toISOString();
  try {
    db.prepare(
      `INSERT INTO editorial_series_episodes (
        episode_id, series_id, project_id, episode_number, plan_id, edition_id, brief_id,
        predecessor_episode_id, role, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      episodeId,
      seriesId,
      projectId,
      episodeNumber,
      planId,
      editionId,
      briefId,
      predecessorEpisodeId,
      role,
      status,
      iso,
      iso,
    );
  } catch (error) {
    if (String(error.message || error).includes('UNIQUE')) {
      return { error: 'duplicate_episode', status: 409 };
    }
    throw error;
  }
  bumpDataVersion(db);
  return { episodeId };
}

export function wouldCreateCycle(db, seriesId, predecessorEpisodeId, episodeId) {
  const edges = db
    .prepare(
      `SELECT episode_id, predecessor_episode_id FROM editorial_series_episodes WHERE series_id = ?`,
    )
    .all(seriesId);
  const map = new Map(edges.map((e) => [e.episode_id, e.predecessor_episode_id]));
  if (episodeId) map.set(episodeId, predecessorEpisodeId);
  let cursor = predecessorEpisodeId;
  const seen = new Set(episodeId ? [episodeId] : []);
  while (cursor) {
    if (seen.has(cursor)) return `cycle at ${cursor}`;
    seen.add(cursor);
    cursor = map.get(cursor) || null;
  }
  return null;
}

export function detectSeriesCycles(db, seriesId) {
  const edges = db
    .prepare(
      `SELECT episode_id, predecessor_episode_id FROM editorial_series_episodes WHERE series_id = ?`,
    )
    .all(seriesId);
  for (const edge of edges) {
    if (!edge.predecessor_episode_id) continue;
    const cycle = wouldCreateCycle(db, seriesId, edge.predecessor_episode_id, edge.episode_id);
    if (cycle) return { cyclic: true, detail: cycle };
  }
  return { cyclic: false };
}

/**
 * Predecessor delivery status gates dependent episode publish.
 * Independent posts are never blocked by this check.
 */
export function evaluatePredecessorGate(db, episodeId) {
  const episode = db
    .prepare('SELECT * FROM editorial_series_episodes WHERE episode_id = ?')
    .get(episodeId);
  if (!episode) return { allowed: false, reason: 'episode_not_found' };
  if (!episode.predecessor_episode_id) return { allowed: true, reason: null };

  const pred = db
    .prepare('SELECT * FROM editorial_series_episodes WHERE episode_id = ?')
    .get(episode.predecessor_episode_id);
  if (!pred) return { allowed: false, reason: 'predecessor_missing' };

  const deliveryStatus = resolveEpisodeDeliveryStatus(db, pred);
  if (deliveryStatus === 'sent') return { allowed: true, reason: null, predecessorStatus: 'sent' };
  if (deliveryStatus === 'failed' || deliveryStatus === 'missed') {
    return {
      allowed: false,
      reason: 'predecessor_failed_or_missed',
      predecessorStatus: deliveryStatus,
      blockDependentOnly: true,
    };
  }
  if (deliveryStatus === 'uncertain') {
    return {
      allowed: false,
      reason: 'predecessor_uncertain',
      predecessorStatus: 'uncertain',
      blockDependentOnly: true,
    };
  }
  return {
    allowed: false,
    reason: 'predecessor_not_sent',
    predecessorStatus: deliveryStatus,
    blockDependentOnly: true,
  };
}

export function resolveEpisodeDeliveryStatus(db, episode) {
  if (episode.edition_id) {
    const delivery = db
      .prepare(
        `SELECT status FROM deliveries WHERE edition_id = ? ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(episode.edition_id);
    if (delivery?.status) return delivery.status;
  }
  if (episode.plan_id) {
    const plan = db
      .prepare('SELECT plan_status, edition_id FROM schedule_slots WHERE plan_id = ?')
      .get(episode.plan_id);
    if (plan?.plan_status === 'missed') return 'missed';
    if (plan?.edition_id) {
      const delivery = db
        .prepare(
          `SELECT status FROM deliveries WHERE edition_id = ? ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(plan.edition_id);
      if (delivery?.status) return delivery.status;
    }
  }
  return episode.status || 'planned';
}

export function updateSeriesStatus(db, seriesId, status, now = new Date()) {
  if (!SERIES_STATUSES.includes(status)) return { error: 'invalid_status', status: 400 };
  const updated = db
    .prepare(`UPDATE editorial_series SET status = ?, updated_at = ? WHERE series_id = ?`)
    .run(status, now.toISOString(), seriesId);
  if (!updated.changes) return { error: 'not_found', status: 404 };
  bumpDataVersion(db);
  return { ok: true, status };
}

export function pauseExpiredOpenSeries(db, now = new Date()) {
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT series_id FROM editorial_series
       WHERE status IN ('draft', 'approved', 'active')
         AND (
           (planned_end_at IS NOT NULL AND planned_end_at <= ?)
           OR created_at <= ?
         )`,
    )
    .all(now.toISOString(), cutoff);
  withTransaction(db, () => {
    for (const row of rows) {
      db.prepare(
        `UPDATE editorial_series SET status = 'paused', updated_at = ? WHERE series_id = ?`,
      ).run(now.toISOString(), row.series_id);
    }
  });
  return { paused: rows.length };
}

function mapSeries(row) {
  return {
    seriesId: row.series_id,
    projectId: row.project_id,
    title: row.title,
    goal: row.goal,
    stages: JSON.parse(row.stages_json || '[]'),
    plannedEndAt: row.planned_end_at,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEpisode(row) {
  return {
    episodeId: row.episode_id,
    seriesId: row.series_id,
    projectId: row.project_id,
    episodeNumber: row.episode_number,
    planId: row.plan_id,
    editionId: row.edition_id,
    briefId: row.brief_id,
    predecessorEpisodeId: row.predecessor_episode_id,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
