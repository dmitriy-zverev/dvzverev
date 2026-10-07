import { randomUUID } from 'node:crypto';
import { bumpDataVersion, withTransaction } from '../db.mjs';

export function createExperiment(db, {
  projectId,
  name,
  factor,
  targetPostsPerVariant = 20,
  startAt = null,
  endAt = null,
  notes = null,
  now = new Date(),
}) {
  if (!projectId || !name || !factor) return { error: 'invalid_body', status: 400 };
  const experimentId = randomUUID();
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO experiments (
        experiment_id, project_id, name, factor, status, target_posts_per_variant,
        start_at, end_at, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
    ).run(
      experimentId,
      projectId,
      name,
      factor,
      targetPostsPerVariant,
      startAt,
      endAt,
      notes,
      now.toISOString(),
      now.toISOString(),
    );
    bumpDataVersion(db);
  });
  return { experiment: getExperiment(db, experimentId) };
}

export function getExperiment(db, experimentId) {
  const row = db.prepare('SELECT * FROM experiments WHERE experiment_id = ?').get(experimentId);
  if (!row) return null;
  const assignments = db
    .prepare('SELECT * FROM experiment_assignments WHERE experiment_id = ?')
    .all(experimentId);
  return {
    experimentId: row.experiment_id,
    projectId: row.project_id,
    name: row.name,
    factor: row.factor,
    status: row.status,
    targetPostsPerVariant: row.target_posts_per_variant,
    startAt: row.start_at,
    endAt: row.end_at,
    notes: row.notes,
    assignments: assignments.map((a) => ({
      assignmentId: a.assignment_id,
      planId: a.plan_id,
      editionId: a.edition_id,
      variant: a.variant,
      promptVersionId: a.prompt_version_id,
      assignedAt: a.assigned_at,
    })),
  };
}

export function startExperiment(db, experimentId, { now = new Date() } = {}) {
  const row = db.prepare('SELECT * FROM experiments WHERE experiment_id = ?').get(experimentId);
  if (!row) return { error: 'not_found', status: 404 };
  db.prepare(
    `UPDATE experiments SET status = 'running', start_at = COALESCE(start_at, ?), updated_at = ? WHERE experiment_id = ?`,
  ).run(now.toISOString(), now.toISOString(), experimentId);
  bumpDataVersion(db);
  return { experiment: getExperiment(db, experimentId) };
}

export function assignVariant(db, {
  experimentId,
  planId = null,
  editionId = null,
  variant,
  promptVersionId = null,
  now = new Date(),
}) {
  if (!experimentId || !variant) return { error: 'invalid_body', status: 400 };
  const experiment = db.prepare('SELECT * FROM experiments WHERE experiment_id = ?').get(experimentId);
  if (!experiment) return { error: 'not_found', status: 404 };
  if (!['running', 'draft'].includes(experiment.status)) {
    return { error: 'not_assignable', status: 409 };
  }
  const assignmentId = randomUUID();
  db.prepare(
    `INSERT INTO experiment_assignments (
      assignment_id, experiment_id, plan_id, edition_id, variant, prompt_version_id, assigned_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(assignmentId, experimentId, planId, editionId, variant, promptVersionId, now.toISOString());
  if (editionId) {
    db.prepare(`UPDATE editions SET experiment_variant = ?, updated_at = ? WHERE edition_id = ?`).run(
      variant,
      now.toISOString(),
      editionId,
    );
  }
  bumpDataVersion(db);
  return { assignmentId, experiment: getExperiment(db, experimentId) };
}

export function balanceVariant(db, experimentId, variants = ['A', 'B']) {
  const counts = Object.fromEntries(variants.map((v) => [v, 0]));
  const rows = db
    .prepare('SELECT variant, COUNT(*) AS c FROM experiment_assignments WHERE experiment_id = ? GROUP BY variant')
    .all(experimentId);
  for (const row of rows) {
    if (counts[row.variant] != null) counts[row.variant] = row.c;
  }
  return variants.slice().sort((a, b) => counts[a] - counts[b] || a.localeCompare(b))[0];
}

export function experimentOutcome(db, experimentId) {
  const experiment = getExperiment(db, experimentId);
  if (!experiment) return { error: 'not_found', status: 404 };
  const byVariant = {};
  for (const assignment of experiment.assignments) {
    if (!byVariant[assignment.variant]) byVariant[assignment.variant] = [];
    if (!assignment.editionId) continue;
    const obs = db
      .prepare(
        `SELECT reach_organic FROM metric_observations
         WHERE edition_id = ? AND is_active = 1 ORDER BY observed_at DESC LIMIT 1`,
      )
      .get(assignment.editionId);
    byVariant[assignment.variant].push(obs?.reach_organic ?? null);
  }
  const summary = {};
  for (const [variant, values] of Object.entries(byVariant)) {
    const known = values.filter((v) => v != null);
    summary[variant] = {
      assigned: values.length,
      withMetrics: known.length,
      enoughData: known.length >= (experiment.targetPostsPerVariant || 20),
      medianReach: known.length
        ? known.slice().sort((a, b) => a - b)[Math.floor(known.length / 2)]
        : null,
    };
  }
  const ready = Object.values(summary).every((s) => s.enoughData);
  return {
    experimentId,
    ready,
    summary,
    verdict: ready ? 'compare_medians' : 'недостаточно данных',
  };
}
