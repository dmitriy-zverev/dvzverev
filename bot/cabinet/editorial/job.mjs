import { createHash, randomUUID } from 'node:crypto';
import { bumpDataVersion, withTransaction } from '../db.mjs';
import { contentExpiresAt } from '../analytics/ttl.mjs';
import { buildEditorialSnapshot, nextPlanWeekStart } from './snapshot.mjs';
import { buildDeterministicProposal, diffProposals, validateProposal } from './proposal.mjs';
import { WEEKLY_BUDGET_USD } from './vocab.mjs';

export function createWeeklyEditorialJob(
  db,
  {
    projectId,
    weekStart = null,
    forceNew = false,
    budgetUsd = WEEKLY_BUDGET_USD,
    mode = 'preview',
    now = new Date(),
    llm = null,
    estimatedCostUsd = null,
  },
) {
  if (!projectId) return { error: 'project_required', status: 400 };

  // Server-enforced weekly cap; client overrides cannot inflate remaining.
  const cappedBudget = Math.min(
    WEEKLY_BUDGET_USD,
    Number.isFinite(Number(budgetUsd)) && Number(budgetUsd) > 0
      ? Number(budgetUsd)
      : WEEKLY_BUDGET_USD,
  );

  const concurrent = db
    .prepare(
      `SELECT job_id, status FROM editorial_weekly_jobs
       WHERE project_id = ? AND status IN ('queued', 'running')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(projectId);
  if (concurrent) {
    return {
      error: 'concurrent_job',
      status: 409,
      message: 'Для проекта уже есть активный weekly job',
      jobId: concurrent.job_id,
    };
  }

  const { snapshot, inputSnapshotHash, metricsStale } = buildEditorialSnapshot(db, {
    projectId,
    weekStart: weekStart || nextPlanWeekStart(now),
    now,
  });

  const existing = db
    .prepare(
      `SELECT * FROM editorial_weekly_jobs
       WHERE project_id = ? AND week_start = ? AND input_snapshot_hash = ?
         AND status IN ('queued', 'running', 'completed')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(projectId, snapshot.weekStart, inputSnapshotHash);

  if (existing && !forceNew) {
    return {
      reused: true,
      jobId: existing.job_id,
      status: existing.status,
      revisionId: existing.result_revision_id,
      message: 'Повтор по тому же snapshot возвращает готовый результат',
    };
  }

  // Explicit regen creates a new job/revision; keep original hash recoverable via audit.
  const jobSnapshotHash = forceNew
    ? `${inputSnapshotHash}:force:${now.toISOString()}`
    : inputSnapshotHash;

  const committed = weeklyCommittedUsd(db, projectId, snapshot.weekStart);
  const remaining = cappedBudget - committed;
  if (remaining <= 0) {
    const jobId = recordFailedJob(db, {
      projectId,
      weekStart: snapshot.weekStart,
      inputSnapshotHash,
      budgetUsd: cappedBudget,
      metricsStale,
      mode,
      now,
      errorMessage: 'budget_exhausted',
      errorLog: { committed, budgetUsd: cappedBudget, remaining },
    });
    return {
      error: 'budget_exhausted',
      status: 402,
      jobId,
      message: 'Недельный бюджет редакционного анализа исчерпан; независимые посты продолжаются',
    };
  }

  if (
    llm &&
    (estimatedCostUsd == null || !Number.isFinite(estimatedCostUsd) || estimatedCostUsd <= 0)
  ) {
    const jobId = recordFailedJob(db, {
      projectId,
      weekStart: snapshot.weekStart,
      inputSnapshotHash,
      budgetUsd: cappedBudget,
      metricsStale,
      mode,
      now,
      errorMessage: 'unknown_price',
      errorLog: { reason: 'estimatedCostUsd required before LLM' },
    });
    return {
      error: 'unknown_price',
      status: 402,
      jobId,
      message: 'При неизвестной цене LLM weekly-анализ не запускается',
    };
  }

  const reserve = llm ? estimatedCostUsd : 0;
  if (llm && reserve > remaining) {
    return { error: 'budget_exhausted', status: 402, message: 'Недостаточно бюджета для резерва' };
  }

  const jobId = randomUUID();
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO editorial_weekly_jobs (
        job_id, project_id, week_start, input_snapshot_hash, status, budget_usd,
        reserved_usd, mode, metrics_stale, created_at
      ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
    ).run(
      jobId,
      projectId,
      snapshot.weekStart,
      jobSnapshotHash,
      cappedBudget,
      reserve || null,
      mode,
      metricsStale ? 1 : 0,
      now.toISOString(),
    );
    if (reserve > 0) {
      db.prepare(
        `INSERT INTO editorial_budget_ledger (
          ledger_id, project_id, week_start, job_id, kind, amount_usd, note, created_at
        ) VALUES (?, ?, ?, ?, 'reserve', ?, ?, ?)`,
      ).run(
        randomUUID(),
        projectId,
        snapshot.weekStart,
        jobId,
        reserve,
        'weekly_analysis_reserve',
        now.toISOString(),
      );
    }
    bumpDataVersion(db);
  });

  try {
    return runWeeklyEditorialJob(db, jobId, { now, llm, snapshot, inputSnapshotHash });
  } catch (error) {
    const message = String(error.message || error);
    withTransaction(db, () => {
      db.prepare(
        `UPDATE editorial_weekly_jobs SET status = 'failed', error_message = ?, error_log_json = ?, finished_at = ?
         WHERE job_id = ?`,
      ).run(message, JSON.stringify({ message }), now.toISOString(), jobId);
      releaseReservedBudget(db, jobId, now);
      bumpDataVersion(db);
    });
    return { error: 'job_failed', status: 500, jobId, message };
  }
}

function releaseReservedBudget(db, jobId, now) {
  const job = db
    .prepare(
      `SELECT project_id, week_start, reserved_usd FROM editorial_weekly_jobs WHERE job_id = ?`,
    )
    .get(jobId);
  if (!job?.reserved_usd) return;
  const already = db
    .prepare(
      `SELECT 1 AS ok FROM editorial_budget_ledger WHERE job_id = ? AND kind = 'release' LIMIT 1`,
    )
    .get(jobId);
  if (already) return;
  db.prepare(
    `INSERT INTO editorial_budget_ledger (
      ledger_id, project_id, week_start, job_id, kind, amount_usd, note, created_at
    ) VALUES (?, ?, ?, ?, 'release', ?, ?, ?)`,
  ).run(
    randomUUID(),
    job.project_id,
    job.week_start,
    jobId,
    job.reserved_usd,
    'weekly_analysis_release',
    now.toISOString(),
  );
}

export function runWeeklyEditorialJob(
  db,
  jobId,
  { now = new Date(), llm = null, snapshot = null, inputSnapshotHash = null } = {},
) {
  const job = db.prepare('SELECT * FROM editorial_weekly_jobs WHERE job_id = ?').get(jobId);
  if (!job) return { error: 'not_found', status: 404 };

  db.prepare(
    `UPDATE editorial_weekly_jobs SET status = 'running', started_at = ? WHERE job_id = ?`,
  ).run(now.toISOString(), jobId);

  const built =
    snapshot && inputSnapshotHash
      ? { snapshot, inputSnapshotHash, metricsStale: Boolean(job.metrics_stale) }
      : buildEditorialSnapshot(db, {
          projectId: job.project_id,
          weekStart: job.week_start,
          now,
        });

  let llmEnrichment = null;
  let costUsd = 0;
  if (llm) {
    const llmResult = llm({
      projectId: job.project_id,
      weekStart: job.week_start,
      snapshot: sanitizeSnapshotForLlm(built.snapshot),
    });
    llmEnrichment = llmResult?.proposal || null;
    costUsd = Number(llmResult?.costUsd) || 0;
    if (costUsd > (job.budget_usd || WEEKLY_BUDGET_USD)) {
      throw new Error('analysis_budget_exceeded');
    }
  }

  const { proposal, validation } = buildDeterministicProposal(built.snapshot, { llmEnrichment });
  if (!validation.ok) {
    throw new Error(`invalid_proposal:${validation.errors.join(',')}`);
  }

  const previous = db
    .prepare(
      `SELECT * FROM editorial_plan_revisions
       WHERE project_id = ? AND week_start = ?
       ORDER BY revision_number DESC LIMIT 1`,
    )
    .get(job.project_id, job.week_start);
  const previousProposal = previous ? JSON.parse(previous.proposal_json) : null;
  const diff = diffProposals(previousProposal, proposal);
  const revisionNumber = previous ? previous.revision_number + 1 : 1;
  const revisionId = randomUUID();
  const expiresAt = contentExpiresAt(now.toISOString(), now);

  withTransaction(db, () => {
    if (previous && previous.status === 'proposed') {
      db.prepare(
        `UPDATE editorial_plan_revisions SET status = 'superseded', updated_at = ? WHERE revision_id = ?`,
      ).run(now.toISOString(), previous.revision_id);
    }

    db.prepare(
      `INSERT INTO editorial_plan_revisions (
        revision_id, job_id, project_id, week_start, revision_number, status,
        proposal_json, diff_json, snapshot_summary_json, config_version,
        prompt_versions_json, content_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      revisionId,
      jobId,
      job.project_id,
      job.week_start,
      revisionNumber,
      JSON.stringify(proposal),
      JSON.stringify(diff),
      JSON.stringify({
        memoryCount: built.snapshot.memory.length,
        slotCount: built.snapshot.slots.length,
        metrics: built.snapshot.metrics,
        diversityFindings: built.snapshot.diversity.findings?.length || 0,
      }),
      built.snapshot.configVersion,
      JSON.stringify(built.snapshot.promptVersions || []),
      expiresAt,
      now.toISOString(),
      now.toISOString(),
    );

    for (const item of proposal.calendar) {
      db.prepare(
        `INSERT INTO editorial_briefs (
          brief_id, revision_id, project_id, plan_id, slot_utc, rubric_id, topic, thesis,
          tone, structure, constraints_json, sources_json, series_id, experiment_id,
          evidence_ids_json, status, content_expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?)`,
      ).run(
        item.briefId || randomUUID(),
        revisionId,
        job.project_id,
        item.planId,
        item.slotUtc,
        item.rubricId,
        item.topic,
        item.thesis,
        item.tone,
        item.structure,
        JSON.stringify(item.constraints || []),
        JSON.stringify(item.sources || []),
        item.seriesId,
        item.experimentId,
        JSON.stringify(item.evidenceIds || []),
        expiresAt,
        now.toISOString(),
        now.toISOString(),
      );
    }

    db.prepare(
      `UPDATE editorial_weekly_jobs SET
        status = 'completed', cost_usd = ?, result_revision_id = ?, finished_at = ?
       WHERE job_id = ?`,
    ).run(costUsd, revisionId, now.toISOString(), jobId);

    // Release open reserve before recording spend so committed = spend + open reserves.
    releaseReservedBudget(db, jobId, now);

    if (costUsd > 0) {
      db.prepare(
        `INSERT INTO editorial_budget_ledger (
          ledger_id, project_id, week_start, job_id, kind, amount_usd, note, created_at
        ) VALUES (?, ?, ?, ?, 'spend', ?, ?, ?)`,
      ).run(
        randomUUID(),
        job.project_id,
        job.week_start,
        jobId,
        costUsd,
        'weekly_analysis_spend',
        now.toISOString(),
      );
    }

    db.prepare(
      'INSERT INTO audit_log (audit_id, actor, action, plan_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      randomUUID(),
      'system',
      'editorial_weekly_job_completed',
      null,
      JSON.stringify({ jobId, revisionId, projectId: job.project_id, costUsd }),
      now.toISOString(),
    );
    bumpDataVersion(db);
  });

  return {
    jobId,
    revisionId,
    status: 'completed',
    costUsd,
    metricsStale: Boolean(job.metrics_stale || built.metricsStale),
    validation,
    proposal,
    diff,
  };
}

export function getWeeklyJob(db, jobId) {
  const job = db.prepare('SELECT * FROM editorial_weekly_jobs WHERE job_id = ?').get(jobId);
  if (!job) return null;
  return mapJob(job);
}

export function listWeeklyJobs(db, { projectId, limit = 20 } = {}) {
  const rows = projectId
    ? db
        .prepare(
          `SELECT * FROM editorial_weekly_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`,
        )
        .all(projectId, limit)
    : db.prepare(`SELECT * FROM editorial_weekly_jobs ORDER BY created_at DESC LIMIT ?`).all(limit);
  return rows.map(mapJob);
}

export function weeklySpendUsd(db, projectId, weekStart) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_usd), 0) AS total FROM editorial_budget_ledger
       WHERE project_id = ? AND week_start = ? AND kind = 'spend'`,
    )
    .get(projectId, weekStart);
  return Number(row?.total) || 0;
}

/** Spend + open reserves (reserve − release). Used for weekly budget gate. */
export function weeklyCommittedUsd(db, projectId, weekStart) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(
         CASE kind
           WHEN 'spend' THEN amount_usd
           WHEN 'reserve' THEN amount_usd
           WHEN 'release' THEN -amount_usd
           ELSE 0
         END
       ), 0) AS total
       FROM editorial_budget_ledger
       WHERE project_id = ? AND week_start = ?`,
    )
    .get(projectId, weekStart);
  return Math.max(0, Number(row?.total) || 0);
}

function recordFailedJob(
  db,
  {
    projectId,
    weekStart,
    inputSnapshotHash,
    budgetUsd,
    metricsStale,
    mode,
    now,
    errorMessage,
    errorLog,
  },
) {
  const hash =
    inputSnapshotHash ||
    createHash('sha256').update(`${projectId}:${weekStart}:fail`).digest('hex');

  // UNIQUE (project_id, week_start, input_snapshot_hash) — reuse prior failed row.
  const existing = db
    .prepare(
      `SELECT job_id FROM editorial_weekly_jobs
       WHERE project_id = ? AND week_start = ? AND input_snapshot_hash = ?
         AND status = 'failed'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(projectId, weekStart, hash);
  if (existing) {
    db.prepare(
      `UPDATE editorial_weekly_jobs SET
        error_message = ?, error_log_json = ?, finished_at = ?, budget_usd = ?
       WHERE job_id = ?`,
    ).run(
      errorMessage,
      JSON.stringify(errorLog || {}),
      now.toISOString(),
      budgetUsd,
      existing.job_id,
    );
    bumpDataVersion(db);
    return existing.job_id;
  }

  const jobId = randomUUID();
  try {
    db.prepare(
      `INSERT INTO editorial_weekly_jobs (
        job_id, project_id, week_start, input_snapshot_hash, status, budget_usd, mode,
        metrics_stale, error_message, error_log_json, created_at, finished_at
      ) VALUES (?, ?, ?, ?, 'failed', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      jobId,
      projectId,
      weekStart,
      hash,
      budgetUsd,
      mode,
      metricsStale ? 1 : 0,
      errorMessage,
      JSON.stringify(errorLog || {}),
      now.toISOString(),
      now.toISOString(),
    );
  } catch (error) {
    if (!String(error.message || error).includes('UNIQUE')) throw error;
    const raced = db
      .prepare(
        `SELECT job_id FROM editorial_weekly_jobs
         WHERE project_id = ? AND week_start = ? AND input_snapshot_hash = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(projectId, weekStart, hash);
    if (raced) return raced.job_id;
    throw error;
  }
  bumpDataVersion(db);
  return jobId;
}

function sanitizeSnapshotForLlm(snapshot) {
  return {
    projectId: snapshot.projectId,
    weekStart: snapshot.weekStart,
    rules: snapshot.rules,
    slots: snapshot.slots.map((s) => ({
      planId: s.planId,
      slotUtc: s.slotUtc,
      topic: s.topic,
      started: s.started,
    })),
    memory: snapshot.memory.map((m) => ({
      memoryId: m.memoryId,
      sentAt: m.sentAt,
      rubricId: m.rubricId,
      tone: m.tone,
      author: m.author,
      openingPhrase: m.openingPhrase,
      closingPhrase: m.closingPhrase,
      observationIds: m.observationIds,
      coverage: m.coverage,
    })),
    diversity: snapshot.diversity,
    metrics: snapshot.metrics,
    series: snapshot.series,
    incompleteEditions: snapshot.incompleteEditions,
    experiments: snapshot.experiments,
  };
}

function mapJob(job) {
  return {
    jobId: job.job_id,
    projectId: job.project_id,
    weekStart: job.week_start,
    inputSnapshotHash: job.input_snapshot_hash,
    status: job.status,
    budgetUsd: job.budget_usd,
    reservedUsd: job.reserved_usd,
    costUsd: job.cost_usd,
    mode: job.mode,
    errorMessage: job.error_message,
    errorLog: job.error_log_json ? JSON.parse(job.error_log_json) : null,
    revisionId: job.result_revision_id,
    metricsStale: Boolean(job.metrics_stale),
    notifyStatus: job.notify_status,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
  };
}

// re-export for tests
export { validateProposal };
