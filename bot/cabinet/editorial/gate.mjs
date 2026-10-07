import { evaluatePredecessorGate } from './series.mjs';

/** Terminal blocks must not reclaim Redis forever; wait-blocks may retry. */
const TERMINAL_SERIES_BLOCK_REASONS = new Set([
  'predecessor_failed_or_missed',
  'predecessor_uncertain',
  'predecessor_missing',
  'episode_not_found',
  'predecessor_content_expired',
]);

/**
 * Blocks only dependent series episodes when predecessor is failed/missed/uncertain.
 * Independent scheduled posts always return allowed=true.
 */
export function checkEditorialPublishGate(db, { planId = null, projectId = null } = {}) {
  if (!planId) return { allowed: true, reason: null };

  const episode = db
    .prepare(
      `SELECT * FROM editorial_series_episodes
       WHERE plan_id = ? AND (? IS NULL OR project_id = ?)
       LIMIT 1`,
    )
    .get(planId, projectId, projectId);
  if (!episode || !episode.predecessor_episode_id) {
    return { allowed: true, reason: null };
  }

  const gate = evaluatePredecessorGate(db, episode.episode_id);
  if (gate.allowed) return { allowed: true, reason: null, episodeId: episode.episode_id };

  return {
    allowed: false,
    reason: gate.reason,
    predecessorStatus: gate.predecessorStatus,
    blockDependentOnly: true,
    episodeId: episode.episode_id,
    seriesId: episode.series_id,
    terminal: TERMINAL_SERIES_BLOCK_REASONS.has(gate.reason),
  };
}

export function isTerminalSeriesBlock(gate) {
  return Boolean(
    gate && !gate.allowed && (gate.terminal || TERMINAL_SERIES_BLOCK_REASONS.has(gate.reason)),
  );
}

export function recordTerminalSeriesBlock(db, gate, now = new Date()) {
  if (!isTerminalSeriesBlock(gate) || !gate.episodeId) return;
  db.prepare(
    `UPDATE editorial_series_episodes
     SET status = 'blocked', updated_at = ?
     WHERE episode_id = ? AND status != 'blocked'`,
  ).run(now.toISOString(), gate.episodeId);
}

/**
 * For code-to-think solutions: continuation must use the exact confirmed sent task,
 * never a regenerated variant.
 */
export function resolveConfirmedTaskPredecessor(db, { projectId, predecessorEditionId }) {
  if (!predecessorEditionId) return { ok: false, reason: 'predecessor_required' };
  const delivery = db
    .prepare(
      `SELECT d.status, d.external_id, e.edition_id, e.body_removed_at, e.body_text
       FROM deliveries d
       JOIN editions e ON e.edition_id = d.edition_id
       WHERE e.edition_id = ? AND e.project_id = ? AND d.platform = 'vk'
       ORDER BY d.updated_at DESC LIMIT 1`,
    )
    .get(predecessorEditionId, projectId);
  if (!delivery) return { ok: false, reason: 'predecessor_missing' };
  if (delivery.status === 'uncertain') return { ok: false, reason: 'predecessor_uncertain' };
  if (delivery.status === 'failed' || delivery.status === 'missed') {
    return { ok: false, reason: 'predecessor_failed_or_missed' };
  }
  if (delivery.status !== 'sent') return { ok: false, reason: 'predecessor_not_sent' };
  if (delivery.body_removed_at || !delivery.body_text) {
    return { ok: false, reason: 'predecessor_content_expired' };
  }
  return {
    ok: true,
    editionId: delivery.edition_id,
    vkPostId: delivery.external_id,
    status: delivery.status,
  };
}
