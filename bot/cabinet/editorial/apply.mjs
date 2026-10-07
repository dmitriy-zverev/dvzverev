import { randomUUID } from 'node:crypto';
import { bumpDataVersion, withTransaction } from '../db.mjs';
import { redisConfigured, getRedis } from '../../redis/client.mjs';
import { encodeTask, decodeTask } from '../../redis/codec.mjs';
import { taskKey } from '../../redis/keys.mjs';
import { evaluatePredecessorGate } from './series.mjs';

/**
 * Push already-applied SQLite slot topic/brief/version to Redis.
 * Does not re-bump version — SQLite is authoritative after approve.
 */
export async function syncEditorialSlotToRedis(
  planId,
  { topic, brief, version },
  env = process.env,
) {
  if (!redisConfigured(env)) return { synced: false };
  const redis = await getRedis(env);
  const raw = await redis.get(taskKey(planId));
  const task = decodeTask(raw);
  if (!task) return { synced: false, reason: 'no_redis_task' };
  if (!['planned', 'missed'].includes(task.status)) throw new Error('redis_task_already_started');
  const nextTask = {
    ...task,
    topic,
    brief,
    version,
  };
  const updated = await redis.eval(
    'if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end redis.call("SET", KEYS[1], ARGV[2]); return 1',
    { keys: [taskKey(planId)], arguments: [raw, encodeTask(nextTask)] },
  );
  if (!updated) throw new Error('redis_version_conflict');
  return { synced: true, version };
}

export function getPlanRevision(db, revisionId) {
  const row = db
    .prepare('SELECT * FROM editorial_plan_revisions WHERE revision_id = ?')
    .get(revisionId);
  if (!row) return null;
  const briefs = db
    .prepare(`SELECT * FROM editorial_briefs WHERE revision_id = ? ORDER BY slot_utc ASC`)
    .all(revisionId)
    .map(mapBrief);
  return {
    revisionId: row.revision_id,
    jobId: row.job_id,
    projectId: row.project_id,
    weekStart: row.week_start,
    revisionNumber: row.revision_number,
    status: row.status,
    proposal: JSON.parse(row.proposal_json),
    diff: row.diff_json ? JSON.parse(row.diff_json) : null,
    snapshotSummary: row.snapshot_summary_json ? JSON.parse(row.snapshot_summary_json) : null,
    configVersion: row.config_version,
    promptVersions: row.prompt_versions_json ? JSON.parse(row.prompt_versions_json) : [],
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    contentExpiresAt: row.content_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    briefs,
  };
}

export function listPlanRevisions(db, { projectId, weekStart = null, limit = 20 } = {}) {
  let rows;
  if (projectId && weekStart) {
    rows = db
      .prepare(
        `SELECT * FROM editorial_plan_revisions
         WHERE project_id = ? AND week_start = ?
         ORDER BY revision_number DESC LIMIT ?`,
      )
      .all(projectId, weekStart, limit);
  } else if (projectId) {
    rows = db
      .prepare(
        `SELECT * FROM editorial_plan_revisions WHERE project_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(projectId, limit);
  } else {
    rows = db
      .prepare(`SELECT * FROM editorial_plan_revisions ORDER BY created_at DESC LIMIT ?`)
      .all(limit);
  }
  return rows.map((row) => ({
    revisionId: row.revision_id,
    projectId: row.project_id,
    weekStart: row.week_start,
    revisionNumber: row.revision_number,
    status: row.status,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  }));
}

/**
 * Approve whole/partial revision and apply briefs only to unstarted future slots.
 * Stale revisions (superseded / older than latest proposed) cannot be approved.
 */
export async function decidePlanRevision(
  db,
  revisionId,
  {
    decision,
    planIds = null,
    briefEdits = {},
    note = null,
    actor = 'owner',
    now = new Date(),
    applyToSlots = true,
    syncRedisFn = syncEditorialSlotToRedis,
    env = process.env,
  } = {},
) {
  if (!['approve', 'reject', 'partial'].includes(decision)) {
    return { error: 'invalid_decision', status: 400 };
  }

  const revision = db
    .prepare('SELECT * FROM editorial_plan_revisions WHERE revision_id = ?')
    .get(revisionId);
  if (!revision) return { error: 'not_found', status: 404 };
  if (!['proposed'].includes(revision.status)) {
    return { error: 'not_decidable', status: 409, message: 'Ревизия уже решена или устарела' };
  }

  const latest = db
    .prepare(
      `SELECT revision_id, revision_number FROM editorial_plan_revisions
       WHERE project_id = ? AND week_start = ?
       ORDER BY revision_number DESC LIMIT 1`,
    )
    .get(revision.project_id, revision.week_start);
  if (latest && latest.revision_id !== revisionId) {
    return {
      error: 'stale_revision',
      status: 409,
      message: 'Нельзя утвердить устаревшую revision',
    };
  }

  const briefs = db.prepare(`SELECT * FROM editorial_briefs WHERE revision_id = ?`).all(revisionId);

  const selected =
    decision === 'approve'
      ? briefs
      : decision === 'partial'
        ? briefs.filter((b) => (planIds || []).includes(b.plan_id))
        : [];

  if (decision === 'partial' && !selected.length) {
    return { error: 'plan_ids_required', status: 400 };
  }

  const applied = [];
  const skipped = [];
  const blocked = [];
  const pendingSlotWrites = [];

  withTransaction(db, () => {
    const nextStatus =
      decision === 'reject' ? 'rejected' : decision === 'partial' ? 'partial' : 'approved';

    const claimed = db
      .prepare(
        `UPDATE editorial_plan_revisions SET
          status = ?, decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ?
         WHERE revision_id = ? AND status = 'proposed'`,
      )
      .run(nextStatus, actor, now.toISOString(), note, now.toISOString(), revisionId);
    if (claimed.changes !== 1) {
      throw Object.assign(new Error('concurrent_decision'), {
        status: 409,
        code: 'concurrent_decision',
      });
    }

    if (decision === 'reject') {
      db.prepare(
        `UPDATE editorial_briefs SET status = 'rejected', updated_at = ? WHERE revision_id = ?`,
      ).run(now.toISOString(), revisionId);
    } else {
      const selectedIds = new Set(selected.map((b) => b.brief_id));
      for (const brief of briefs) {
        if (!selectedIds.has(brief.brief_id)) {
          db.prepare(
            `UPDATE editorial_briefs SET status = 'rejected', updated_at = ? WHERE brief_id = ?`,
          ).run(now.toISOString(), brief.brief_id);
          continue;
        }

        const edit = briefEdits[brief.plan_id] || {};
        const topic = edit.topic !== undefined ? String(edit.topic).slice(0, 500) : brief.topic;
        const thesis =
          edit.thesis !== undefined ? String(edit.thesis).slice(0, 4000) : brief.thesis;

        db.prepare(
          `UPDATE editorial_briefs SET topic = ?, thesis = ?, status = 'approved', updated_at = ?
           WHERE brief_id = ?`,
        ).run(topic, thesis, now.toISOString(), brief.brief_id);

        if (!applyToSlots) {
          applied.push({ planId: brief.plan_id, briefId: brief.brief_id, applied: false });
          continue;
        }

        const slot = db
          .prepare('SELECT * FROM schedule_slots WHERE plan_id = ?')
          .get(brief.plan_id);
        if (!slot) {
          skipped.push({ planId: brief.plan_id, reason: 'slot_missing' });
          db.prepare(
            `UPDATE editorial_briefs SET status = 'blocked', block_reason = 'slot_missing', updated_at = ?
             WHERE brief_id = ?`,
          ).run(now.toISOString(), brief.brief_id);
          continue;
        }
        if (slot.edition_id) {
          skipped.push({ planId: brief.plan_id, reason: 'already_started' });
          db.prepare(
            `UPDATE editorial_briefs SET status = 'blocked', block_reason = 'already_started', updated_at = ?
             WHERE brief_id = ?`,
          ).run(now.toISOString(), brief.brief_id);
          continue;
        }
        if (!['planned', 'missed'].includes(slot.plan_status)) {
          skipped.push({ planId: brief.plan_id, reason: 'not_editable' });
          db.prepare(
            `UPDATE editorial_briefs SET status = 'blocked', block_reason = 'not_editable', updated_at = ?
             WHERE brief_id = ?`,
          ).run(now.toISOString(), brief.brief_id);
          continue;
        }
        if (slot.project_id !== revision.project_id) {
          skipped.push({ planId: brief.plan_id, reason: 'project_isolation' });
          db.prepare(
            `UPDATE editorial_briefs SET status = 'blocked', block_reason = 'project_isolation', updated_at = ?
             WHERE brief_id = ?`,
          ).run(now.toISOString(), brief.brief_id);
          continue;
        }

        const episode = db
          .prepare(
            `SELECT * FROM editorial_series_episodes WHERE brief_id = ? OR plan_id = ? LIMIT 1`,
          )
          .get(brief.brief_id, brief.plan_id);
        if (episode?.predecessor_episode_id) {
          const gate = evaluatePredecessorGate(db, episode.episode_id);
          if (!gate.allowed) {
            blocked.push({
              planId: brief.plan_id,
              reason: gate.reason,
              predecessorStatus: gate.predecessorStatus,
            });
            db.prepare(
              `UPDATE editorial_briefs SET status = 'blocked', block_reason = ?, updated_at = ?
               WHERE brief_id = ?`,
            ).run(gate.reason, now.toISOString(), brief.brief_id);
            continue;
          }
        }

        const composedBrief = composeBriefText({
          topic,
          thesis,
          tone: brief.tone,
          structure: brief.structure,
          constraints: JSON.parse(brief.constraints_json || '[]'),
          evidenceIds: JSON.parse(brief.evidence_ids_json || '[]'),
        });

        pendingSlotWrites.push({
          planId: brief.plan_id,
          briefId: brief.brief_id,
          topic,
          brief: composedBrief,
          expectedVersion: slot.version,
        });
      }
    }

    // Always apply to SQLite inside the decision transaction so revision/briefs/slots stay atomic.
    for (const item of pendingSlotWrites) {
      const updated = db
        .prepare(
          `UPDATE schedule_slots SET topic = ?, brief = ?, topic_state = 'editorial',
            version = version + 1, updated_at = ?
           WHERE plan_id = ? AND edition_id IS NULL AND plan_status IN ('planned', 'missed')
             AND version = ?`,
        )
        .run(item.topic, item.brief, now.toISOString(), item.planId, item.expectedVersion);
      if (updated.changes !== 1) {
        skipped.push({ planId: item.planId, reason: 'version_conflict' });
        db.prepare(
          `UPDATE editorial_briefs SET status = 'blocked', block_reason = 'version_conflict', updated_at = ?
           WHERE brief_id = ?`,
        ).run(now.toISOString(), item.briefId);
        continue;
      }
      db.prepare(
        `UPDATE editorial_briefs SET status = 'applied', updated_at = ? WHERE brief_id = ?`,
      ).run(now.toISOString(), item.briefId);
      applied.push({
        planId: item.planId,
        briefId: item.briefId,
        topic: item.topic,
        brief: item.brief,
        version: item.expectedVersion + 1,
      });
    }

    db.prepare(
      'INSERT INTO audit_log (audit_id, actor, action, plan_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      randomUUID(),
      actor,
      `editorial_revision_${decision}`,
      null,
      JSON.stringify({
        revisionId,
        decision,
        pending: pendingSlotWrites.map((a) => a.planId),
        skipped,
        blocked,
        note,
      }),
      now.toISOString(),
    );
    bumpDataVersion(db);
  });

  // Redis sync is best-effort after commit; never re-bumps SQLite version.
  const redisSyncErrors = [];
  if (typeof syncRedisFn === 'function') {
    for (const item of applied) {
      if (item.version == null || item.brief === undefined) continue;
      try {
        await syncRedisFn(
          item.planId,
          { topic: item.topic, brief: item.brief, version: item.version },
          env,
        );
      } catch {
        redisSyncErrors.push({ planId: item.planId, reason: 'redis_sync_failed' });
      }
    }
  }

  return {
    revisionId,
    decision,
    status: decision === 'reject' ? 'rejected' : decision === 'partial' ? 'partial' : 'approved',
    applied,
    skipped,
    blocked,
    redisSyncErrors,
  };
}

export function editFutureBrief(
  db,
  briefId,
  { topic, thesis, actor = 'owner', now = new Date() } = {},
) {
  return withTransaction(db, () =>
    editFutureBriefInTransaction(db, briefId, { topic, thesis, actor, now }),
  );
}

function editFutureBriefInTransaction(db, briefId, { topic, thesis, actor, now }) {
  const brief = db.prepare('SELECT * FROM editorial_briefs WHERE brief_id = ?').get(briefId);
  if (!brief) return { error: 'not_found', status: 404 };
  if (!['proposed', 'approved', 'applied'].includes(brief.status)) {
    return { error: 'not_editable', status: 409 };
  }
  if (brief.plan_id) {
    const slot = db
      .prepare('SELECT edition_id, slot_utc, plan_status FROM schedule_slots WHERE plan_id = ?')
      .get(brief.plan_id);
    if (slot?.edition_id) return { error: 'already_started', status: 409 };
    if (
      !slot ||
      Date.parse(slot.slot_utc) <= now.getTime() ||
      !['planned', 'missed'].includes(slot.plan_status)
    )
      return { error: 'not_editable', status: 409 };
  }

  const nextTopic = topic !== undefined ? String(topic).slice(0, 500) : brief.topic;
  const nextThesis = thesis !== undefined ? String(thesis).slice(0, 4000) : brief.thesis;
  db.prepare(
    `UPDATE editorial_briefs SET topic = ?, thesis = ?, updated_at = ? WHERE brief_id = ?`,
  ).run(nextTopic, nextThesis, now.toISOString(), briefId);

  if (brief.status === 'applied' && brief.plan_id) {
    const composed = composeBriefText({
      topic: nextTopic,
      thesis: nextThesis,
      tone: brief.tone,
      structure: brief.structure,
      constraints: JSON.parse(brief.constraints_json || '[]'),
      evidenceIds: JSON.parse(brief.evidence_ids_json || '[]'),
    });
    db.prepare(
      `UPDATE schedule_slots SET topic = ?, brief = ?, topic_state = 'editorial',
        version = version + 1, updated_at = ?
       WHERE plan_id = ? AND edition_id IS NULL`,
    ).run(nextTopic, composed, now.toISOString(), brief.plan_id);
  }

  db.prepare(
    'INSERT INTO audit_log (audit_id, actor, action, plan_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    randomUUID(),
    actor,
    'editorial_brief_edit',
    brief.plan_id,
    JSON.stringify({ briefId, topic: nextTopic }),
    now.toISOString(),
  );
  bumpDataVersion(db);
  const slot =
    brief.status === 'applied' && brief.plan_id
      ? db
          .prepare(
            'SELECT plan_id AS planId, topic, brief, version FROM schedule_slots WHERE plan_id = ?',
          )
          .get(brief.plan_id)
      : null;
  return { ok: true, briefId, topic: nextTopic, thesis: nextThesis, slot };
}

export function composeBriefText({ thesis, tone, structure, constraints, evidenceIds }) {
  return [
    thesis || '',
    tone ? `Тон: ${tone}` : '',
    structure ? `Структура: ${structure}` : '',
    constraints?.length ? `Ограничения: ${constraints.join('; ')}` : '',
    evidenceIds?.length ? `Evidence: ${evidenceIds.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 4000);
}

export function buildEditorialOverview(db, { projectId, now = new Date() } = {}) {
  if (!projectId) return { error: 'project_required', status: 400 };
  const revisions = listPlanRevisions(db, { projectId, limit: 10 });
  const latestProposed = db
    .prepare(
      `SELECT revision_id FROM editorial_plan_revisions
       WHERE project_id = ? AND status = 'proposed'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(projectId);
  const memoryCount = db
    .prepare(`SELECT COUNT(*) AS c FROM editorial_memory WHERE project_id = ?`)
    .get(projectId).c;
  const seriesCount = db
    .prepare(
      `SELECT COUNT(*) AS c FROM editorial_series WHERE project_id = ? AND status IN ('draft','approved','active')`,
    )
    .get(projectId).c;
  const decisions = db
    .prepare(
      `SELECT action, payload_json, created_at FROM audit_log
       WHERE action LIKE 'editorial_revision_%'
       ORDER BY created_at DESC LIMIT 30`,
    )
    .all()
    .map((row) => ({
      action: row.action,
      payload: JSON.parse(row.payload_json || '{}'),
      createdAt: row.created_at,
    }))
    .filter(
      (d) =>
        d.payload.revisionId &&
        revisions.some(
          (r) => r.revisionId === d.payload.revisionId || d.payload.projectId === projectId,
        ),
    );

  const accepted = decisions.filter(
    (d) => d.action.includes('approve') || d.action.includes('partial'),
  ).length;
  const rejected = decisions.filter((d) => d.action.includes('reject')).length;

  return {
    projectId,
    memoryCount,
    seriesCount,
    revisions,
    latestProposedRevisionId: latestProposed?.revision_id || null,
    pilotStats: {
      decisions: decisions.length,
      accepted,
      rejected,
      acceptanceRate: decisions.length ? accepted / decisions.length : null,
      asOf: now.toISOString(),
    },
    latestRevision: latestProposed ? getPlanRevision(db, latestProposed.revision_id) : null,
  };
}

function mapBrief(row) {
  return {
    briefId: row.brief_id,
    revisionId: row.revision_id,
    projectId: row.project_id,
    planId: row.plan_id,
    slotUtc: row.slot_utc,
    rubricId: row.rubric_id,
    topic: row.topic,
    thesis: row.thesis,
    tone: row.tone,
    structure: row.structure,
    constraints: JSON.parse(row.constraints_json || '[]'),
    sources: JSON.parse(row.sources_json || '[]'),
    seriesId: row.series_id,
    experimentId: row.experiment_id,
    evidenceIds: JSON.parse(row.evidence_ids_json || '[]'),
    predecessorBriefId: row.predecessor_brief_id,
    status: row.status,
    blockReason: row.block_reason,
  };
}
