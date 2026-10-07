import { createHash, randomUUID } from 'node:crypto';
import { bumpDataVersion, withTransaction } from '../db.mjs';
import { buildSegments, listAnalyticsPosts } from './query.mjs';
import { activatePromptVersion, getPromptVersion, registerPromptVersion } from './prompts.mjs';

const ANALYSIS_BUDGET_USD = 0.5;

export function datasetHashForAnalysis(db, projectId, now = new Date()) {
  const posts = listAnalyticsPosts(db, { projectId, paginate: false, limit: 5000 }, now);
  const payload = posts.items.map((p) => ({
    editionId: p.editionId,
    promptVersion: p.promptVersion,
    mediaActual: p.mediaActual,
    reachOrganic: p.metrics?.reachOrganic ?? null,
    ageDays: p.derived?.ageDays ?? null,
    promoted: p.metrics?.promoted ?? null,
  }));
  return createHash('sha256').update(JSON.stringify({ projectId, payload })).digest('hex');
}

export function createAnalysisJob(db, {
  projectId,
  budgetUsd = ANALYSIS_BUDGET_USD,
  now = new Date(),
  llm = null,
}) {
  if (!projectId) return { error: 'project_required', status: 400 };
  const hash = datasetHashForAnalysis(db, projectId, now);
  const existingPaid = db
    .prepare(
      `SELECT job_id, status FROM analysis_jobs
       WHERE project_id = ? AND dataset_hash = ? AND status IN ('queued', 'running', 'completed')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(projectId, hash);
  if (existingPaid) {
    return {
      error: 'dataset_already_analyzed',
      status: 409,
      message: 'Тот же набор данных уже оплачен/в очереди; нужен новый запрос владельца после изменения данных',
      jobId: existingPaid.job_id,
    };
  }

  const jobId = randomUUID();
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO analysis_jobs (
        job_id, project_id, status, dataset_hash, budget_usd, created_at
      ) VALUES (?, ?, 'queued', ?, ?, ?)`,
    ).run(jobId, projectId, hash, budgetUsd, now.toISOString());
    bumpDataVersion(db);
  });

  try {
    const result = runAnalysisJob(db, jobId, { now, llm });
    return result;
  } catch (error) {
    db.prepare(
      `UPDATE analysis_jobs SET status = 'failed', error_message = ?, finished_at = ? WHERE job_id = ?`,
    ).run(String(error.message || error), now.toISOString(), jobId);
    return { error: 'analysis_failed', status: 500, jobId, message: String(error.message || error) };
  }
}

export function runAnalysisJob(db, jobId, { now = new Date(), llm = null } = {}) {
  const job = db.prepare('SELECT * FROM analysis_jobs WHERE job_id = ?').get(jobId);
  if (!job) return { error: 'not_found', status: 404 };

  db.prepare(`UPDATE analysis_jobs SET status = 'running', started_at = ? WHERE job_id = ?`).run(
    now.toISOString(),
    jobId,
  );

  const segments = buildSegments(db, { projectId: job.project_id }, now);
  const posts = listAnalyticsPosts(db, {
    projectId: job.project_id,
    paginate: false,
    limit: 5000,
  }, now).items;
  const deterministic = buildDeterministicFindings(segments, posts);

  let llmFindings = [];
  let costUsd = 0;
  if (llm && deterministic.comparableSegments.length) {
    const llmResult = llm({
      projectId: job.project_id,
      findings: deterministic.findings,
      posts: posts.slice(0, 40).map((p) => ({
        editionId: p.editionId,
        topic: p.topic,
        mediaActual: p.mediaActual,
        promptVersion: p.promptVersion,
        reachOrganic: p.metrics?.reachOrganic ?? null,
        ageDays: p.derived?.ageDays ?? null,
        promoted: p.metrics?.promoted ?? null,
      })),
    });
    llmFindings = llmResult?.recommendations || [];
    costUsd = Number(llmResult?.costUsd) || 0;
    if (costUsd > (job.budget_usd || ANALYSIS_BUDGET_USD)) {
      throw new Error('analysis_budget_exceeded');
    }
  }

  const recommendations = [];
  withTransaction(db, () => {
    for (const finding of [...deterministic.findings, ...llmFindings]) {
      const recommendationId = randomUUID();
      db.prepare(
        `INSERT INTO recommendations (
          recommendation_id, job_id, project_id, status, observation, evidence_json,
          alternatives_json, prompt_role, prompt_diff_json, hypothesis, constraints_json,
          experiment_plan_json, created_at, updated_at
        ) VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        recommendationId,
        jobId,
        job.project_id,
        finding.observation,
        JSON.stringify(finding.evidence || []),
        JSON.stringify(finding.alternatives || []),
        finding.promptRole || 'editor',
        JSON.stringify(finding.promptDiff || null),
        finding.hypothesis || null,
        JSON.stringify(finding.constraints || []),
        JSON.stringify(finding.experimentPlan || null),
        now.toISOString(),
        now.toISOString(),
      );
      recommendations.push(recommendationId);
    }

    db.prepare(
      `UPDATE analysis_jobs SET status = 'completed', cost_usd = ?, result_json = ?, finished_at = ?
       WHERE job_id = ?`,
    ).run(
      costUsd,
      JSON.stringify({
        deterministicCount: deterministic.findings.length,
        llmCount: llmFindings.length,
        insufficientData: deterministic.insufficientData,
      }),
      now.toISOString(),
      jobId,
    );
    bumpDataVersion(db);
  });

  return {
    jobId,
    status: 'completed',
    costUsd,
    recommendationIds: recommendations,
    insufficientData: deterministic.insufficientData,
  };
}

export function listRecommendations(db, { projectId = null, status = null, limit = 50 } = {}) {
  const params = [];
  let sql = 'SELECT * FROM recommendations WHERE 1=1';
  if (projectId) {
    sql += ' AND project_id = ?';
    params.push(projectId);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(Math.min(100, limit));
  return db.prepare(sql).all(...params).map(serializeRecommendation);
}

export function decideRecommendation(db, recommendationId, {
  decision,
  note = null,
  editedDiff = null,
  actor = 'owner',
  now = new Date(),
}) {
  const row = db.prepare('SELECT * FROM recommendations WHERE recommendation_id = ?').get(recommendationId);
  if (!row) return { error: 'not_found', status: 404 };
  if (!['approve', 'reject', 'edit'].includes(decision)) {
    return { error: 'invalid_decision', status: 400 };
  }
  if (row.status !== 'proposed') return { error: 'not_proposed', status: 409 };

  let appliedVersionId = null;
  withTransaction(db, () => {
    if (decision === 'reject') {
      db.prepare(
        `UPDATE recommendations SET status = 'rejected', decision_note = ?, decided_at = ?, decided_by = ?, updated_at = ?
         WHERE recommendation_id = ?`,
      ).run(note, now.toISOString(), actor, now.toISOString(), recommendationId);
    } else {
      const diff = editedDiff || JSON.parse(row.prompt_diff_json || 'null');
      if (!diff?.afterText) {
        throw Object.assign(new Error('prompt_diff_required'), { status: 400, code: 'prompt_diff_required' });
      }
      const parent = getActiveEditorVersion(db, row.project_id, row.prompt_role || 'editor');
      const registered = registerPromptVersion(
        db,
        {
          projectId: row.project_id,
          role: row.prompt_role || 'editor',
          versionLabel: `rec-${recommendationId.slice(0, 8)}`,
          contentText: diff.afterText,
          source: 'recommendation',
          parentVersionId: parent?.version_id || null,
          actor,
          now,
        },
        { inTransaction: true },
      );
      if (registered.error) {
        throw Object.assign(new Error(registered.error), { status: registered.status });
      }
      const activated = activatePromptVersion(db, registered.version.versionId, {
        actor,
        now,
        inTransaction: true,
      });
      appliedVersionId = activated.version.versionId;
      db.prepare(
        `UPDATE recommendations SET
          status = ?, decision_note = ?, decided_at = ?, decided_by = ?,
          prompt_diff_json = ?, applied_version_id = ?, updated_at = ?
         WHERE recommendation_id = ?`,
      ).run(
        decision === 'edit' ? 'edited' : 'approved',
        note,
        now.toISOString(),
        actor,
        JSON.stringify(diff),
        appliedVersionId,
        now.toISOString(),
        recommendationId,
      );
    }

    db.prepare(
      `INSERT INTO audit_log (audit_id, actor, action, plan_id, payload_json, created_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    ).run(
      randomUUID(),
      actor,
      `recommendation_${decision}`,
      JSON.stringify({ recommendationId, appliedVersionId }),
      now.toISOString(),
    );
    bumpDataVersion(db);
  });

  const updated = db
    .prepare('SELECT * FROM recommendations WHERE recommendation_id = ?')
    .get(recommendationId);
  return {
    recommendation: updated ? serializeRecommendation(updated) : null,
    appliedVersionId,
  };
}

function getActiveEditorVersion(db, projectId, role) {
  return db
    .prepare(
      `SELECT * FROM prompt_versions WHERE project_id = ? AND role = ? AND status = 'active' LIMIT 1`,
    )
    .get(projectId, role);
}

function buildDeterministicFindings(segments, posts) {
  const findings = [];
  const insufficientData = [];
  const byMedia = segments.segments.byMedia || [];

  for (const segment of byMedia) {
    if (!segment.comparableForRecommendation) {
      insufficientData.push({ segment: `media:${segment.key}`, reason: segment.note });
      continue;
    }
    const peers = byMedia.filter((s) => s.comparableForRecommendation && s.key !== segment.key);
    if (!peers.length) continue;
    const bestPeer = peers.slice().sort((a, b) => (b.organicReach.median || 0) - (a.organicReach.median || 0))[0];
    if (
      segment.organicReach.median != null &&
      bestPeer.organicReach.median != null &&
      segment.organicReach.median < bestPeer.organicReach.median * 0.7
    ) {
      const evidencePosts = posts
        .filter((p) => (p.mediaActual || 'none') === segment.key && p.metrics?.reachOrganic != null)
        .slice(0, 5)
        .map((p) => ({ editionId: p.editionId, reachOrganic: p.metrics.reachOrganic, ageDays: p.derived?.ageDays }));
      findings.push({
        observation: `Сегмент media=${segment.key} имеет медиану organic reach ниже сопоставимого сегмента ${bestPeer.key}`,
        evidence: evidencePosts,
        alternatives: [
          'Разница может объясняться возрастом наблюдения или платной поддержкой',
          'Разный размер аудитории в слотах',
        ],
        promptRole: 'editor',
        promptDiff: null,
        hypothesis: `Изменение структуры opening для media=${segment.key} может поднять organic reach`,
        constraints: ['Не ухудшать качество и фактологию', 'Один фактор за эксперимент'],
        experimentPlan: {
          factor: 'opening',
          days: 14,
          targetPostsPerVariant: 20,
          kpi: 'organic_reach',
        },
      });
    }
  }

  if (!findings.length) {
    findings.push({
      observation: 'Данных недостаточно для доказанного победителя промпта',
      evidence: posts.slice(0, 3).map((p) => ({ editionId: p.editionId })),
      alternatives: ['Дождаться ≥20 сопоставимых постов и ≥80% покрытия метрики'],
      promptRole: 'editor',
      promptDiff: null,
      hypothesis: null,
      constraints: ['Не объявлять победителя при недостаточном покрытии'],
      experimentPlan: null,
    });
  }

  return {
    findings,
    insufficientData,
    comparableSegments: byMedia.filter((s) => s.comparableForRecommendation),
  };
}

function serializeRecommendation(row) {
  return {
    recommendationId: row.recommendation_id,
    jobId: row.job_id,
    projectId: row.project_id,
    status: row.status,
    observation: row.observation,
    evidence: JSON.parse(row.evidence_json || '[]'),
    alternatives: JSON.parse(row.alternatives_json || '[]'),
    promptRole: row.prompt_role,
    promptDiff: JSON.parse(row.prompt_diff_json || 'null'),
    hypothesis: row.hypothesis,
    constraints: JSON.parse(row.constraints_json || '[]'),
    experimentPlan: JSON.parse(row.experiment_plan_json || 'null'),
    decisionNote: row.decision_note,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    appliedVersionId: row.applied_version_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
