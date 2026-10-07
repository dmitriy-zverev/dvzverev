import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { bumpDataVersion, openCabinetDb, withTransaction } from './db.mjs';
import {
  allowedOrigins,
  assertOrigin,
  clearSession,
  clearSessionCookieHeader,
  createSession,
  ensurePasswordHash,
  getLoginLockStatus,
  loginClientIp,
  loginRateLimitError,
  recordLoginFailure,
  resetLoginAttempts,
  sessionFromRequest,
  verifyPassword,
  requestHeader,
} from './auth.mjs';
import { buildOverview, getEdition, listIncidents, listProjects, patchPlan } from './overview.mjs';
import { loadServiceForCabinet, refreshServiceSnapshot } from './projects.mjs';
import { cabinetTick, materializeScheduleSlots } from './sync.mjs';
import { ensureRubrics, listRubrics, createRubric, changeRubric } from './rubrics.mjs';
import { listBatchReports } from './reports/store.mjs';
import { getRedis, redisConfigured } from '../redis/client.mjs';
import { createAdHocTask, discardTask } from '../redis/schedule.mjs';
import { upsertPlanFromRedisTask } from '../redis/sqlite-bridge.mjs';
import { createLargeBodyReader, handleAnalyticsRoute } from './analytics/routes.mjs';
import { handleEditorialRoute } from './editorial/routes.mjs';
import { handleVkOAuthRoute, getOAuthBroker, reportOAuthError } from '../vk-oauth/routes.mjs';
import { createRefreshTick, startRefreshWorker } from '../vk-oauth/refresh.mjs';
import { getWeeklyVkClient } from '../vk-oauth/legacy.mjs';
import { retryEditionNow } from './retry.mjs';
import { ensureWeeklySnapshot, claimWeeklyJob, prepareWeeklyPosts } from './weekly.mjs';
import { handleOzonRoute } from './ozon.mjs';

const API_PREFIX = '/bot/api/v1';
const readBodyLarge = createLargeBodyReader();

function auditAuth(db, action, detail = {}) {
  db.prepare(
    'INSERT INTO audit_log (audit_id, actor, action, plan_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(randomUUID(), 'owner', action, null, JSON.stringify(detail), new Date().toISOString());
}

function parseJson(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    const error = new Error('Invalid JSON body');
    error.status = 400;
    throw error;
  }
}

function corsHeaders(request, env) {
  const origin = requestHeader(request, 'origin');
  if (!origin || !allowedOrigins(env).includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
}

function json(response, status, body, headers = {}) {
  if (response.writableEnded) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
    ...headers,
  });
  response.end(payload);
}

function clientErrorBody(status) {
  const error =
    status === 401
      ? 'unauthorized'
      : status === 403
        ? 'forbidden'
        : status === 429
          ? 'rate_limited'
          : status === 400
            ? 'bad_request'
            : status === 413
              ? 'payload_too_large'
              : 'server_error';
  const messages = {
    403: 'Доступ запрещён.',
    429: 'Слишком много запросов. Подождите.',
    400: 'Некорректный запрос.',
    413: 'Слишком большой запрос.',
    500: 'Что-то пошло не так. Попробуйте позже.',
  };
  const body = { error };
  const message = messages[status];
  if (message) body.message = message;
  return body;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 65536) {
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
}

function parseUrl(request) {
  const host = request.headers.host || 'localhost';
  return new URL(request.url || '/', `http://${host}`);
}

function requireSession(db, request) {
  const session = sessionFromRequest(db, request.headers.cookie);
  if (!session) {
    const error = new Error('Unauthorized');
    error.status = 401;
    throw error;
  }
  return session;
}

async function handleRequest(request, response, env) {
  const url = parseUrl(request);
  const cors = corsHeaders(request, env);

  if (request.method === 'OPTIONS' && url.pathname.startsWith(API_PREFIX)) {
    if (!cors['Access-Control-Allow-Origin']) {
      json(response, 403, { error: 'origin_not_allowed' }, cors);
      return;
    }
    response.writeHead(204, {
      ...cors,
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'private, no-store',
    });
    response.end();
    return;
  }

  const vkAlias = env.VK_OAUTH_ENABLED === 'true' && url.pathname.startsWith('/vk/');
  if (!url.pathname.startsWith(API_PREFIX) && !vkAlias) {
    json(response, 404, { error: 'not_found' }, cors);
    return;
  }

  const db = openCabinetDb(env);
  try {
    ensurePasswordHash(db, env);
    const rawRoute = vkAlias ? url.pathname : url.pathname.slice(API_PREFIX.length);
    const route = rawRoute.startsWith('/vk/') ? rawRoute.replace(/\/$/, '') : rawRoute;

    if (route === '/auth/login' && request.method === 'POST') {
      assertOrigin(request, env);
      const body = parseJson(await readBody(request));
      const ip = loginClientIp(request);
      const lockStatus = getLoginLockStatus(request, env);
      if (lockStatus.locked) {
        auditAuth(db, 'login_rate_limited', {
          ip,
          retryAfterSeconds: lockStatus.retryAfterSeconds,
        });
        console.error(`cabinet_auth_fail ip=${ip} locked=1`);
        throw loginRateLimitError(lockStatus.retryAfterSeconds);
      }
      const hash = ensurePasswordHash(db, env);
      const password = String(body.password || '');
      const valid = verifyPassword(password, hash);
      if (!valid) {
        const failure = recordLoginFailure(request, env);
        auditAuth(db, 'login_failed', {
          ip,
          locked: failure.locked,
          retryAfterSeconds: failure.retryAfterSeconds || undefined,
        });
        console.error(`cabinet_auth_fail ip=${ip}`);
        if (failure.locked) {
          throw loginRateLimitError(failure.retryAfterSeconds);
        }
        json(response, 401, { error: 'invalid_credentials' }, cors);
        return;
      }
      resetLoginAttempts(request);
      auditAuth(db, 'login_success', { ip });
      const session = createSession(db, env);
      json(
        response,
        200,
        { ok: true, expiresAt: session.expiresAt },
        {
          ...cors,
          'Set-Cookie': `cabinet_session=${session.token}; ${session.cookieFlags}; Max-Age=${12 * 3600}`,
        },
      );
      return;
    }

    if (route === '/auth/logout' && request.method === 'POST') {
      assertOrigin(request, env);
      clearSession(db, request.headers.cookie);
      json(
        response,
        200,
        { ok: true },
        {
          ...cors,
          'Set-Cookie': clearSessionCookieHeader(env),
        },
      );
      return;
    }

    if (route === '/auth/session' && request.method === 'GET') {
      const session = sessionFromRequest(db, request.headers.cookie);
      json(response, 200, { authenticated: Boolean(session) }, cors);
      return;
    }

    const session = requireSession(db, request);
    if (route === '/rubrics' || /^\/rubrics\/[\w-]+$/.test(route)) {
      if (request.method !== 'GET') assertOrigin(request, env);
      const { document: service } = await loadServiceForCabinet(env);
      ensureRubrics(db, service);
      try {
        if (route === '/rubrics' && request.method === 'GET') {
          json(response, 200, { rubrics: listRubrics(db), projects: listProjects(db) }, cors);
          return;
        }
        assertOrigin(request, env);
        const body = parseJson(await readBody(request));
        let result;
        if (route === '/rubrics' && request.method === 'POST')
          result = createRubric(db, service, body.projectId, body);
        else if (['PATCH', 'DELETE'].includes(request.method))
          result = await changeRubric(db, route.split('/')[2], body, {
            remove: request.method === 'DELETE',
            client: getWeeklyVkClient(env),
          });
        else {
          json(response, 405, { error: 'method_not_allowed' }, cors);
          return;
        }
        materializeScheduleSlots(db, service, env);
        auditAuth(db, 'rubric_change', {
          id: result.id || route.split('/')[2],
          removed: result.removed,
        });
        json(response, 200, { result, rubrics: listRubrics(db) }, cors);
      } catch (error) {
        if (error.status) throw error;
        const code = /^(rubric_|vk_)/.test(error.message) ? error.message : 'rubric_update_failed';
        json(
          response,
          code.includes('invalid') || code.includes('too_long') ? 400 : 409,
          { error: code },
          cors,
        );
      }
      return;
    }
    if (
      await handleOzonRoute({
        route,
        request,
        response,
        db,
        env,
        json,
        cors,
        assertOrigin,
        parseJson,
        readBody,
      })
    )
      return;
    if (route === '/weekly-preparation' && ['GET', 'POST'].includes(request.method)) {
      if (request.method === 'POST') assertOrigin(request, env);
      const current = url.searchParams.get('scope') === 'current';
      const snapshot = await ensureWeeklySnapshot(db, env, new Date(), current);
      const client = getWeeklyVkClient(env);
      if (request.method === 'POST') {
        if (!client?.status().canPrepare) {
          json(
            response,
            409,
            {
              error: 'vk_login_required',
              message: 'Войдите в VK с правами на стену, фотографии и сообщества.',
            },
            cors,
          );
          return;
        }
        if (
          snapshot.posts.some(
            (p) => p.media === 'video' && !['scheduled', 'sent'].includes(p.status),
          ) &&
          !client.status().canVideo
        ) {
          json(
            response,
            409,
            {
              error: 'vk_video_permission_required',
              message: 'Войдите в VK повторно и разрешите доступ к видео.',
            },
            cors,
          );
          return;
        }
        if (!snapshot.running && snapshot.missing > 0) {
          const owner = claimWeeklyJob(db, snapshot.week.start);
          if (owner) {
            auditAuth(db, 'vk_weekly_preparation', {
              week: snapshot.week.start,
              missing: snapshot.missing,
            });
            // The background job owns its SQLite connection after this request closes.
            void prepareWeeklyPosts(env, snapshot.week.start, owner);
          }
        }
      }
      json(
        response,
        request.method === 'POST' ? 202 : 200,
        {
          ...(await ensureWeeklySnapshot(db, env, new Date(), current)),
          current: await ensureWeeklySnapshot(db, env, new Date(), true),
          vk: client?.status() || { available: false, canPrepare: false, connected: false },
        },
        cors,
      );
      return;
    }
    if (
      await handleVkOAuthRoute({
        route,
        request,
        response,
        url,
        env,
        session,
        assertOrigin,
        readBody,
        parseJson,
        json,
        cors,
      })
    )
      return;

    if (route === '/overview' && request.method === 'GET') {
      const { document: service } = await loadServiceForCabinet(env);
      ensureRubrics(db, service);
      materializeScheduleSlots(db, service, env);
      const slotCount = db.prepare('SELECT COUNT(*) AS count FROM schedule_slots').get().count;
      if (!slotCount) {
        json(response, 503, { error: 'data_unavailable' }, cors);
        return;
      }
      const data = await buildOverview(
        db,
        {
          week: url.searchParams.get('week'),
          projectFilter: url.searchParams.get('project'),
          statusFilter: url.searchParams.get('status'),
          rubricFilter: url.searchParams.get('rubric'),
        },
        env,
      );
      json(response, 200, data, cors);
      return;
    }

    if (route === '/projects' && request.method === 'GET') {
      json(response, 200, { projects: listProjects(db) }, cors);
      return;
    }

    if (route.startsWith('/editions/') && route.endsWith('/retry') && request.method === 'POST') {
      assertOrigin(request, env);
      const editionId = decodeURIComponent(route.slice('/editions/'.length, -'/retry'.length));
      if (!/^[a-f0-9]{32}$/.test(editionId)) {
        json(response, 400, { error: 'invalid_id' }, cors);
        return;
      }
      const result = await retryEditionNow(db, editionId, env);
      if (result.error) {
        json(response, result.status, { error: result.error }, cors);
        return;
      }
      json(response, 202, result, cors);
      return;
    }

    if (route.startsWith('/editions/') && request.method === 'GET') {
      const editionId = decodeURIComponent(route.slice('/editions/'.length));
      if (!/^[a-f0-9]{32}$/.test(editionId)) {
        json(response, 400, { error: 'invalid_id' }, cors);
        return;
      }
      const edition = getEdition(db, editionId);
      if (!edition) {
        json(response, 404, { error: 'not_found' }, cors);
        return;
      }
      json(response, 200, edition, cors);
      return;
    }

    if (route.startsWith('/batches/') && route.endsWith('/reports') && request.method === 'GET') {
      const parts = route.slice('/batches/'.length, -'/reports'.length).split('/');
      if (parts.length !== 2 || !/^\d{4}-\d{2}-\d{2}$/.test(parts[0])) {
        json(response, 400, { error: 'invalid_path' }, cors);
        return;
      }
      const period = parts[1];
      if (!['morning', 'evening'].includes(period)) {
        json(response, 400, { error: 'invalid_period' }, cors);
        return;
      }
      json(response, 200, { reports: listBatchReports(db, parts[0], period) }, cors);
      return;
    }

    if (route === '/incidents' && request.method === 'GET') {
      json(
        response,
        200,
        listIncidents(db, {
          project: url.searchParams.get('project'),
          status: url.searchParams.get('status') || 'open',
          cursor: Number(url.searchParams.get('cursor') || 0),
          limit: Math.min(100, Number(url.searchParams.get('limit') || 30)),
        }),
        cors,
      );
      return;
    }

    if (route.startsWith('/plans/') && request.method === 'PATCH') {
      assertOrigin(request, env);
      const planId = decodeURIComponent(route.slice('/plans/'.length));
      if (!/^[0-9a-f-]{36}$/.test(planId)) {
        json(response, 400, { error: 'invalid_id' }, cors);
        return;
      }
      const body = parseJson(await readBody(request));
      const result = await patchPlan(db, planId, body, 'owner', env);
      if (result.error) {
        json(response, result.status, { error: result.error }, cors);
        return;
      }
      json(response, 200, result, cors);
      return;
    }

    if (route === '/tasks/ad-hoc' && request.method === 'POST') {
      assertOrigin(request, env);
      if (!redisConfigured(env)) {
        json(response, 503, { error: 'redis_required' }, cors);
        return;
      }
      const body = parseJson(await readBody(request));
      if (
        typeof body.projectId !== 'string' ||
        !body.projectId.trim() ||
        typeof body.destinationId !== 'string' ||
        !body.destinationId.trim() ||
        typeof body.slotUtc !== 'string' ||
        !Number.isFinite(Date.parse(body.slotUtc))
      ) {
        json(response, 400, { error: 'invalid_body' }, cors);
        return;
      }
      const { document } = await loadServiceForCabinet(env);
      const redis = await getRedis(env);
      const result = await createAdHocTask(redis, document, {
        projectId: body.projectId,
        destinationId: body.destinationId,
        slotUtc: body.slotUtc,
        topic: body.topic,
        brief: body.brief,
      });
      if (result.error) {
        json(
          response,
          result.status,
          {
            error: result.error,
            suggestedSlotUtc: result.suggestedSlotUtc || undefined,
          },
          cors,
        );
        return;
      }
      const now = new Date().toISOString();
      try {
        withTransaction(db, () => {
          upsertPlanFromRedisTask(db, result.task, now);
          db.prepare(
            'INSERT INTO audit_log (audit_id, actor, action, plan_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          ).run(
            randomUUID(),
            'owner',
            'create_ad_hoc_task',
            result.task.id,
            JSON.stringify({
              projectId: result.task.projectId,
              destinationId: result.task.destinationId,
              slotUtc: result.task.slotUtc,
            }),
            now,
          );
          bumpDataVersion(db);
        });
      } catch (error) {
        await discardTask(redis, result.task.id);
        throw error;
      }
      json(response, 201, { task: result.task }, cors);
      return;
    }

    if (route === '/sync' && request.method === 'POST') {
      assertOrigin(request, env);
      const { document } = await loadServiceForCabinet(env);
      refreshServiceSnapshot(db, document);
      await cabinetTick(db, document, env);
      json(response, 200, { ok: true }, cors);
      return;
    }

    const analyticsHandled = await handleAnalyticsRoute({
      route,
      method: request.method,
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
    });
    if (analyticsHandled) return;

    const editorialHandled = await handleEditorialRoute({
      route,
      method: request.method,
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
    });
    if (editorialHandled) return;

    json(response, 404, { error: 'not_found' }, cors);
  } catch (error) {
    if (error.status !== 401 && error.status !== 403 && error.status !== 429) {
      console.error('cabinet api error:', error);
    }
    const status = error.status || 500;
    const rateLimitHeaders =
      status === 429 && error.retryAfterSeconds
        ? { 'Retry-After': String(error.retryAfterSeconds) }
        : {};
    json(response, status, clientErrorBody(status), { ...cors, ...rateLimitHeaders });
  } finally {
    db.close();
  }
}

export function startCabinetServer(env = process.env) {
  const port = Number(env.BOT_CABINET_PORT || 8787);
  const server = createServer((request, response) => {
    handleRequest(request, response, env).catch(() => {
      json(response, 500, { error: 'server_error' }, corsHeaders(request, env));
    });
  });
  server.listen(port, env.BOT_CABINET_HOST || 'localhost');
  if (env.VK_OAUTH_ENABLED === 'true') {
    const tick = createRefreshTick(getOAuthBroker(env), (error) => reportOAuthError(env, error));
    const stop = startRefreshWorker(tick);
    server.once('close', stop);
  }
  return server;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) startCabinetServer();
