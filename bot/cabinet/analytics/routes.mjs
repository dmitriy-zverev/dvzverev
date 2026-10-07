import { CSV_TEMPLATE_HEADER, MAX_IMPORT_BYTES } from './parse.mjs';
import {
  buildImportPreview,
  commitImport,
  getImport,
  listImports,
  revertImport,
} from './import.mjs';
import {
  buildAnalyticsOverview,
  buildImportsCoverage,
  buildSegments,
  listAnalyticsPosts,
} from './query.mjs';
import {
  activatePromptVersion,
  listPromptVersions,
  registerPromptVersion,
  rollbackPromptVersion,
} from './prompts.mjs';
import {
  createAnalysisJob,
  decideRecommendation,
  listRecommendations,
} from './recommendations.mjs';
import { runAnalyticsCleanup } from './ttl.mjs';

export async function handleAnalyticsRoute({
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
  readBodyLarge,
  parseJson,
}) {
  if (route === '/imports/template' && method === 'GET') {
    if (response.writableEnded) return true;
    response.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="vk-stats-template.csv"',
      'Cache-Control': 'private, no-store',
      ...cors,
    });
    response.end(`${CSV_TEMPLATE_HEADER}\n`);
    return true;
  }

  if (route === '/imports/preview' && method === 'POST') {
    assertOrigin(request, env);
    const body = parseJson(await readBodyLarge(request));
    if (typeof body.content !== 'string' || !body.content.length) {
      json(response, 400, { error: 'content_required' }, cors);
      return true;
    }
    if (!body.observedAt) {
      json(response, 400, { error: 'observed_at_required' }, cors);
      return true;
    }
    const buffer = Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8');
    const result = buildImportPreview(db, {
      projectId: body.projectId,
      vkGroupId: String(body.vkGroupId || body.groupId || ''),
      observedAt: body.observedAt,
      reportWeek: body.reportWeek || null,
      metricMode: body.metricMode || 'cumulative',
      periodFrom: body.periodFrom || null,
      periodTo: body.periodTo || null,
      buffer,
      filename: body.filename || 'upload.csv',
    });
    if (result.error) {
      json(response, result.status || 400, {
        error: result.error,
        message: result.message,
        importId: result.importId,
      }, cors);
      return true;
    }
    json(response, 200, result, cors);
    return true;
  }

  if (route.startsWith('/imports/') && route.endsWith('/commit') && method === 'POST') {
    assertOrigin(request, env);
    const importId = decodeURIComponent(route.slice('/imports/'.length, -'/commit'.length));
    const body = parseJson(await readBodyLarge(request));
    const result = commitImport(db, importId, {
      mode: body.mode || 'strict',
      confirmAnomalies: Boolean(body.confirmAnomalies),
      idempotencyKey: body.idempotencyKey || null,
      allowUnmatchedAsExternal: Boolean(body.allowUnmatchedAsExternal),
    });
    if (result.error) {
      json(response, result.status || 400, result, cors);
      return true;
    }
    json(response, 200, result, cors);
    return true;
  }

  if (route.startsWith('/imports/') && route.endsWith('/revert') && method === 'POST') {
    assertOrigin(request, env);
    const importId = decodeURIComponent(route.slice('/imports/'.length, -'/revert'.length));
    const result = revertImport(db, importId);
    if (result.error) {
      json(response, result.status || 400, result, cors);
      return true;
    }
    json(response, 200, result, cors);
    return true;
  }

  if (route === '/imports' && method === 'GET') {
    json(response, 200, {
      imports: listImports(db, {
        projectId: url.searchParams.get('project'),
        limit: Number(url.searchParams.get('limit') || 50),
      }),
    }, cors);
    return true;
  }

  if (route.startsWith('/imports/') && method === 'GET') {
    const importId = decodeURIComponent(route.slice('/imports/'.length));
    if (importId.includes('/')) return false;
    const item = getImport(db, importId);
    if (!item) {
      json(response, 404, { error: 'not_found' }, cors);
      return true;
    }
    json(response, 200, item, cors);
    return true;
  }

  if (route === '/analytics' && method === 'GET') {
    json(response, 200, buildAnalyticsOverview(db, filterParams(url)), cors);
    return true;
  }

  if (route === '/analytics/posts' && method === 'GET') {
    json(
      response,
      200,
      listAnalyticsPosts(db, {
        ...filterParams(url),
        cursor: url.searchParams.get('cursor'),
        limit: url.searchParams.get('limit'),
        requireMetrics: url.searchParams.get('requireMetrics'),
      }),
      cors,
    );
    return true;
  }

  if (route === '/analytics/segments' && method === 'GET') {
    json(response, 200, buildSegments(db, filterParams(url)), cors);
    return true;
  }

  if (route === '/analytics/imports' && method === 'GET') {
    json(response, 200, buildImportsCoverage(db, { projectId: url.searchParams.get('project') }), cors);
    return true;
  }

  if (route === '/analytics/cleanup' && method === 'POST') {
    assertOrigin(request, env);
    json(response, 200, { ok: true, stats: runAnalyticsCleanup(db, { force: true }) }, cors);
    return true;
  }

  if (route === '/analysis-jobs' && method === 'POST') {
    assertOrigin(request, env);
    const body = parseJson(await readBodyLarge(request));
    const result = createAnalysisJob(db, {
      projectId: body.projectId,
      budgetUsd: body.budgetUsd,
      llm: null,
    });
    if (result.error) {
      json(response, result.status || 400, result, cors);
      return true;
    }
    json(response, 201, result, cors);
    return true;
  }

  if (route === '/recommendations' && method === 'GET') {
    json(response, 200, {
      recommendations: listRecommendations(db, {
        projectId: url.searchParams.get('project'),
        status: url.searchParams.get('status'),
        limit: Number(url.searchParams.get('limit') || 50),
      }),
    }, cors);
    return true;
  }

  if (route.startsWith('/recommendations/') && route.endsWith('/decide') && method === 'POST') {
    assertOrigin(request, env);
    const recommendationId = decodeURIComponent(
      route.slice('/recommendations/'.length, -'/decide'.length),
    );
    const body = parseJson(await readBodyLarge(request));
    try {
      const result = decideRecommendation(db, recommendationId, {
        decision: body.decision,
        note: body.note,
        editedDiff: body.promptDiff,
      });
      if (result.error) {
        json(response, result.status || 400, result, cors);
        return true;
      }
      json(response, 200, result, cors);
    } catch (error) {
      json(
        response,
        error.status || 500,
        { error: error.code || 'server_error', message: error.message },
        cors,
      );
    }
    return true;
  }

  if (route === '/prompt-versions' && method === 'GET') {
    json(response, 200, {
      versions: listPromptVersions(db, {
        projectId: url.searchParams.get('project'),
        role: url.searchParams.get('role'),
        status: url.searchParams.get('status'),
      }),
    }, cors);
    return true;
  }

  if (route === '/prompt-versions' && method === 'POST') {
    assertOrigin(request, env);
    const body = parseJson(await readBodyLarge(request));
    const result = registerPromptVersion(db, body);
    if (result.error) {
      json(response, result.status || 400, result, cors);
      return true;
    }
    json(response, 201, result, cors);
    return true;
  }

  if (route.startsWith('/prompt-versions/') && route.endsWith('/activate') && method === 'POST') {
    assertOrigin(request, env);
    const versionId = decodeURIComponent(route.slice('/prompt-versions/'.length, -'/activate'.length));
    const result = activatePromptVersion(db, versionId);
    if (result.error) {
      json(response, result.status || 400, result, cors);
      return true;
    }
    json(response, 200, result, cors);
    return true;
  }

  if (route.startsWith('/prompt-versions/') && route.endsWith('/rollback') && method === 'POST') {
    assertOrigin(request, env);
    const versionId = decodeURIComponent(route.slice('/prompt-versions/'.length, -'/rollback'.length));
    const result = rollbackPromptVersion(db, versionId);
    if (result.error) {
      json(response, result.status || 400, result, cors);
      return true;
    }
    json(response, 200, result, cors);
    return true;
  }

  return false;
}

function filterParams(url) {
  return {
    projectId: url.searchParams.get('project'),
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
    format: url.searchParams.get('format'),
    topic: url.searchParams.get('topic'),
    media: url.searchParams.get('media'),
    promptVersion: url.searchParams.get('promptVersion'),
    source: url.searchParams.get('source'),
    organicPaid: url.searchParams.get('organicPaid'),
    ageBucket: url.searchParams.get('ageBucket'),
  };
}

export function createLargeBodyReader(maxBytes = MAX_IMPORT_BYTES) {
  return function readBodyLarge(request) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      request.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          const error = new Error('Body too large');
          error.status = 413;
          reject(error);
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      request.on('error', reject);
    });
  };
}
