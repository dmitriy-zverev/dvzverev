import { getMeta, setMeta } from '../db.mjs';
import { isEditorialProposalWindow, nextPlanWeekStart } from './snapshot.mjs';
import { createWeeklyEditorialJob } from './job.mjs';
import { notifyEditorialFailure, notifyEditorialProposal } from './notify.mjs';
import { syncEditorialMemory } from './memory.mjs';
import { pauseExpiredOpenSeries } from './series.mjs';

/**
 * Sunday 19:30 Europe/Moscow: one weekly proposal job per enabled project.
 * Failures never stop independent delivery. Concurrent jobs rejected per project.
 */
export async function runEditorialScheduler(db, service, env, now = new Date()) {
  syncEditorialMemory(db, { now });
  pauseExpiredOpenSeries(db, now);

  if (!isEditorialProposalWindow(now)) {
    return { skipped: true, reason: 'outside_window' };
  }

  const weekStart = nextPlanWeekStart(now);
  const marker = `editorial_weekly_ran:${weekStart}`;
  if (getMeta(db, marker)) {
    return { skipped: true, reason: 'already_ran', weekStart };
  }

  const results = [];
  for (const [projectId, project] of Object.entries(service.projects || {})) {
    if (!project.enabled) continue;
    try {
      const result = createWeeklyEditorialJob(db, {
        projectId,
        weekStart,
        mode: 'preview',
        now,
        llm: null,
      });
      if (result.error) {
        await notifyEditorialFailure(db, {
          projectId,
          jobId: result.jobId,
          message: result.message || result.error,
          env,
          now,
        });
      } else if (result.revisionId && !result.reused) {
        await notifyEditorialProposal(db, {
          jobId: result.jobId,
          revisionId: result.revisionId,
          projectId,
          env,
          now,
        });
      }
      results.push({ projectId, ...result });
    } catch (error) {
      const message = String(error.message || error);
      console.error(
        JSON.stringify({
          type: 'editorial_weekly_failure',
          projectId,
          message,
          at: now.toISOString(),
        }),
      );
      await notifyEditorialFailure(db, { projectId, message, env, now });
      results.push({ projectId, error: message });
    }
  }

  setMeta(db, marker, now.toISOString());
  return { weekStart, results };
}
