import { listMemory, patchMemoryFeatures, syncEditorialMemory } from './memory.mjs';
import {
  addEpisode,
  createSeries,
  detectSeriesCycles,
  getSeries,
  listSeries,
  updateSeriesStatus,
} from './series.mjs';
import { buildEditorialSnapshot, nextPlanWeekStart } from './snapshot.mjs';
import { createWeeklyEditorialJob, getWeeklyJob, listWeeklyJobs } from './job.mjs';
import {
  buildEditorialOverview,
  decidePlanRevision,
  editFutureBrief,
  getPlanRevision,
  listPlanRevisions,
  syncEditorialSlotToRedis,
} from './apply.mjs';
import { notifyEditorialFailure, notifyEditorialProposal } from './notify.mjs';
import { analyzeDiversity } from './diversity.mjs';
export async function handleEditorialRoute({
  route,
  method,
  url,
  request,
  response,
  db,
  env,
  json,
  cors,
  assertOrigin,
  parseJson,
  readBody,
}) {
  if (!route.startsWith('/editorial') && !route.startsWith('/editorial-')) {
    // also accept short paths under /editorial/*
  }

  if (route === '/editorial' && method === 'GET') {
    const projectId = url.searchParams.get('project');
    if (!projectId) {
      json(response, 400, { error: 'project_required' }, cors);
      return true;
    }
    json(response, 200, buildEditorialOverview(db, { projectId }), cors);
    return true;
  }

  if (route === '/editorial/memory' && method === 'GET') {
    const projectId = url.searchParams.get('project');
    if (!projectId) {
      json(response, 400, { error: 'project_required' }, cors);
      return true;
    }
    syncEditorialMemory(db, { projectId });
    const items = listMemory(db, {
      projectId,
      limit: Math.min(200, Number(url.searchParams.get('limit') || 100)),
    });
    json(
      response,
      200,
      {
        items,
        diversity: analyzeDiversity(items, { projectId }),
      },
      cors,
    );
    return true;
  }

  if (route.startsWith('/editorial/memory/') && method === 'PATCH') {
    assertOrigin(request, env);
    const memoryId = decodeURIComponent(route.slice('/editorial/memory/'.length));
    const body = parseJson(await readBody(request));
    const result = patchMemoryFeatures(db, memoryId, body);
    if (result.error) {
      json(response, result.status || 400, result, cors);
      return true;
    }
    json(response, 200, result, cors);
    return true;
  }

  if (route === '/editorial/series' && method === 'GET') {
    json(
      response,
      200,
      { series: listSeries(db, { projectId: url.searchParams.get('project') }) },
      cors,
    );
    return true;
  }

  if (route === '/editorial/series' && method === 'POST') {
    assertOrigin(request, env);
    const body = parseJson(await readBody(request));
    const result = createSeries(db, body);
    if (result.error) {
      json(response, result.status || 400, result, cors);
      return true;
    }
    json(response, 201, result, cors);
    return true;
  }

  if (route.startsWith('/editorial/series/') && method === 'GET') {
    const seriesId = decodeURIComponent(route.slice('/editorial/series/'.length));
    if (seriesId.includes('/')) return false;
    const item = getSeries(db, seriesId);
    if (!item) {
      json(response, 404, { error: 'not_found' }, cors);
      return true;
    }
    json(response, 200, { ...item, cycles: detectSeriesCycles(db, seriesId) }, cors);
    return true;
  }

  if (route.startsWith('/editorial/series/') && route.endsWith('/episodes') && method === 'POST') {
    assertOrigin(request, env);
    const seriesId = decodeURIComponent(
      route.slice('/editorial/series/'.length, -'/episodes'.length),
    );
    const body = parseJson(await readBody(request));
    const result = addEpisode(db, { ...body, seriesId });
    if (result.error) {
      json(response, result.status || 400, result, cors);
      return true;
    }
    json(response, 201, result, cors);
    return true;
  }

  if (route.startsWith('/editorial/series/') && route.endsWith('/status') && method === 'POST') {
    assertOrigin(request, env);
    const seriesId = decodeURIComponent(
      route.slice('/editorial/series/'.length, -'/status'.length),
    );
    const body = parseJson(await readBody(request));
    const result = updateSeriesStatus(db, seriesId, body.status);
    if (result.error) {
      json(response, result.status || 400, result, cors);
      return true;
    }
    json(response, 200, result, cors);
    return true;
  }

  if (route === '/editorial/snapshot' && method === 'GET') {
    const projectId = url.searchParams.get('project');
    if (!projectId) {
      json(response, 400, { error: 'project_required' }, cors);
      return true;
    }
    const built = buildEditorialSnapshot(db, {
      projectId,
      weekStart: url.searchParams.get('week') || nextPlanWeekStart(),
    });
    json(response, 200, built, cors);
    return true;
  }

  if (route === '/editorial/jobs' && method === 'GET') {
    json(
      response,
      200,
      {
        jobs: listWeeklyJobs(db, {
          projectId: url.searchParams.get('project'),
          limit: Math.min(50, Number(url.searchParams.get('limit') || 20)),
        }),
      },
      cors,
    );
    return true;
  }

  if (route === '/editorial/jobs' && method === 'POST') {
    assertOrigin(request, env);
    const body = parseJson(await readBody(request));
    const result = createWeeklyEditorialJob(db, {
      projectId: body.projectId,
      weekStart: body.weekStart || null,
      forceNew: Boolean(body.forceNew),
      // Ignore client budgetUsd — WEEKLY_BUDGET_USD is server-enforced.
      mode: body.mode || 'preview',
      estimatedCostUsd: body.estimatedCostUsd ?? null,
      llm: null, // GET-like safety: server never auto-calls paid LLM without explicit adapter injection
    });
    if (result.error) {
      console.error(
        JSON.stringify({
          type: 'editorial_weekly_failure',
          projectId: body.projectId,
          jobId: result.jobId,
          message: result.message || result.error,
        }),
      );
      if (result.jobId) {
        await notifyEditorialFailure(db, {
          projectId: body.projectId,
          jobId: result.jobId,
          message: result.message || result.error,
          env,
        });
      }
      json(response, result.status || 400, result, cors);
      return true;
    }
    if (result.revisionId && !result.reused) {
      await notifyEditorialProposal(db, {
        jobId: result.jobId,
        revisionId: result.revisionId,
        projectId: body.projectId,
        env,
      });
    }
    json(response, result.reused ? 200 : 201, result, cors);
    return true;
  }

  if (route.startsWith('/editorial/jobs/') && method === 'GET') {
    const jobId = decodeURIComponent(route.slice('/editorial/jobs/'.length));
    if (jobId.includes('/')) return false;
    const job = getWeeklyJob(db, jobId);
    if (!job) {
      json(response, 404, { error: 'not_found' }, cors);
      return true;
    }
    const revision = job.revisionId ? getPlanRevision(db, job.revisionId) : null;
    json(response, 200, { job, revision }, cors);
    return true;
  }

  if (route === '/editorial/revisions' && method === 'GET') {
    json(
      response,
      200,
      {
        revisions: listPlanRevisions(db, {
          projectId: url.searchParams.get('project'),
          weekStart: url.searchParams.get('week'),
        }),
      },
      cors,
    );
    return true;
  }

  if (route.startsWith('/editorial/revisions/') && route.endsWith('/decide') && method === 'POST') {
    assertOrigin(request, env);
    const revisionId = decodeURIComponent(
      route.slice('/editorial/revisions/'.length, -'/decide'.length),
    );
    const body = parseJson(await readBody(request));
    try {
      const result = await decidePlanRevision(db, revisionId, {
        decision: body.decision,
        planIds: body.planIds || null,
        briefEdits: body.briefEdits || {},
        note: body.note || null,
        actor: 'owner',
        env,
      });
      if (result.error) {
        json(response, result.status || 400, result, cors);
        return true;
      }
      json(response, 200, result, cors);
      return true;
    } catch (error) {
      if (error.code === 'concurrent_decision' || error.message === 'concurrent_decision') {
        json(response, 409, { error: 'concurrent_decision' }, cors);
        return true;
      }
      throw error;
    }
  }

  if (route.startsWith('/editorial/revisions/') && method === 'GET') {
    const revisionId = decodeURIComponent(route.slice('/editorial/revisions/'.length));
    if (revisionId.includes('/')) return false;
    const revision = getPlanRevision(db, revisionId);
    if (!revision) {
      json(response, 404, { error: 'not_found' }, cors);
      return true;
    }
    json(response, 200, revision, cors);
    return true;
  }

  if (route.startsWith('/editorial/briefs/') && method === 'PATCH') {
    assertOrigin(request, env);
    const briefId = decodeURIComponent(route.slice('/editorial/briefs/'.length));
    const body = parseJson(await readBody(request));
    const result = editFutureBrief(db, briefId, {
      topic: body.topic,
      thesis: body.thesis,
      actor: 'owner',
    });
    if (result.error) {
      json(response, result.status || 400, result, cors);
      return true;
    }
    if (result.slot) {
      try {
        await syncEditorialSlotToRedis(result.slot.planId, result.slot, env);
      } catch {
        json(
          response,
          503,
          {
            ...result,
            error: 'redis_sync_failed',
            message: 'Бриф сохранён; очередь не обновлена. Повторите сохранение.',
          },
          cors,
        );
        return true;
      }
    }
    json(response, 200, result, cors);
    return true;
  }

  return false;
}
