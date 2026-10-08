import { oauthStatusPage } from './pages.mjs';
import { resolve, dirname } from 'node:path';
import { OAuthStore } from './store.mjs';
import { VkOAuthClient, oauthConfig } from './client.mjs';
import { logError } from '../logging.mjs';
import { sendNotification } from '../notifications.mjs';
import { publicationBackoffSeconds, sendTelegram } from '../core.mjs';
import {
  getOwnerVkClient,
  getWeeklyVkClient,
  legacyCallbackPage,
  legacyManualLoginPage,
  parseLegacyRedirectUrl,
  weeklyVkStatus,
} from './legacy.mjs';

let broker;
let trialBroker;
export function getOAuthBroker(env) {
  if (!broker) {
    const path =
      env.VK_OAUTH_STORE_PATH ||
      resolve(dirname(env.BOT_CABINET_DB_PATH || 'bot/data/cabinet.sqlite'), 'vk-oauth.sqlite');
    broker = new VkOAuthClient(new OAuthStore(path, env.VK_OAUTH_ENCRYPTION_KEY), oauthConfig(env));
  }
  return broker;
}

export function getTrialOAuthBroker(env) {
  if (!/^\d+$/.test(env.VK_OAUTH_TRIAL_CLIENT_ID || ''))
    throw new Error('vk_oauth_trial_not_configured');
  if (env.VK_OAUTH_TRIAL_CLIENT_ID === env.VK_OAUTH_CLIENT_ID)
    throw new Error('vk_oauth_trial_requires_separate_app');
  if (!trialBroker) {
    const primary = getOAuthBroker(env);
    const path =
      env.VK_OAUTH_STORE_PATH ||
      resolve(dirname(env.BOT_CABINET_DB_PATH || 'bot/data/cabinet.sqlite'), 'vk-oauth.sqlite');
    trialBroker = new VkOAuthClient(
      new OAuthStore(`${path}.trial-${env.VK_OAUTH_TRIAL_CLIENT_ID}`, env.VK_OAUTH_ENCRYPTION_KEY),
      { ...primary.config, clientId: env.VK_OAUTH_TRIAL_CLIENT_ID, scope: 'wall photos groups' },
    );
  }
  return trialBroker;
}

export async function handleVkOAuthRoute({
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
}) {
  if (!route.startsWith('/vk/')) return false;
  let weeklyCallback = false;
  let weekly = null;
  try {
    weekly = env.VK_WEEKLY_OAUTH_ENABLED === 'true' ? getOwnerVkClient(env) : null;
    const callbackState = url.searchParams.get('state');
    weeklyCallback =
      route === '/vk/callback' &&
      callbackState &&
      /^[\w-]{43}$/.test(callbackState) &&
      weekly?.store.get('state:' + callbackState);
    if (
      route.startsWith('/vk/legacy/') ||
      (route === '/vk/callback' &&
        !weeklyCallback &&
        !url.searchParams.has('code') &&
        env.VK_LEGACY_OAUTH_ENABLED === 'true')
    ) {
      const owner = getOwnerVkClient(env);
      if (route === '/vk/legacy/status') {
        json(response, 200, weeklyVkStatus(env), cors);
        return true;
      }
      if (request.method === 'GET' && route === '/vk/legacy/capabilities') {
        if (!owner) {
          json(response, 404, { error: 'vk_owner_oauth_not_configured' }, cors);
          return true;
        }
        const methods = [
          ['permissions', 'account.getAppPermissions', {}],
          ['identity', 'users.get', {}],
          ['groups', 'groups.get', { filter: 'admin,editor', extended: 1, count: 1000 }],
        ];
        const groupId = url.searchParams.get('group_id');
        if (groupId && !/^\d+$/.test(groupId)) throw new Error('vk_invalid_target');
        methods.push([
          'photoUpload',
          'photos.getWallUploadServer',
          groupId ? { group_id: groupId } : {},
        ]);
        const results = [];
        for (const [capability, method, parameters] of methods) {
          try {
            const result = await owner.api(method, parameters);
            results.push({
              capability,
              method,
              ok: true,
              ...(capability === 'permissions'
                ? { permissions: result }
                : capability === 'groups'
                  ? {
                      groups:
                        result.items?.map((g) => ({
                          id: g.id,
                          name: g.name,
                          isAdmin: g.is_admin,
                        })) || [],
                    }
                  : {}),
            });
          } catch (error) {
            results.push({ capability, method, ok: false, error: error.message });
          }
        }
        json(
          response,
          200,
          {
            results,
            note: 'Owner OAuth probe only. Weekly posts still use community GIF docs until photo upload is switched on.',
          },
          cors,
        );
        return true;
      }
      if (!owner) {
        json(response, 404, { error: 'vk_owner_oauth_not_configured' }, cors);
        return true;
      }
      if (request.method === 'GET' && route === '/vk/legacy/login') {
        if (
          ['https://oauth.vk.ru/blank.html', 'https://oauth.vk.com/blank.html'].includes(
            owner.config.redirectUri,
          )
        ) {
          const page = legacyManualLoginPage(owner.begin(session.sessionId));
          response.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${page.nonce}'; script-src 'nonce-${page.nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
          });
          response.end(page.html);
          return true;
        }
        response.writeHead(303, {
          Location: owner.begin(session.sessionId),
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        });
        response.end();
        return true;
      }
      if (request.method === 'GET' && route === '/vk/callback') {
        const page = legacyCallbackPage();
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${page.nonce}'; script-src 'nonce-${page.nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
        });
        response.end(page.html);
        return true;
      }
      if (request.method === 'POST' && route === '/vk/legacy/complete') {
        if (weekly) throw new Error('vk_oauth_server_login_required');
        assertOrigin(request, env);
        const body = parseJson(await readBody(request));
        json(
          response,
          200,
          await owner.complete(
            body.redirectUrl ? parseLegacyRedirectUrl(body.redirectUrl) : body,
            session.sessionId,
          ),
          cors,
        );
        return true;
      }
      json(response, 404, { error: 'not_found' }, cors);
      return true;
    }
    if (env.VK_OAUTH_ENABLED !== 'true' && !weeklyCallback) return false;
    let client = weeklyCallback ? weekly : getOAuthBroker(env);
    let trial = false;
    if (route.startsWith('/vk/trial/')) {
      client = getTrialOAuthBroker(env);
      trial = true;
      route = route.replace('/vk/trial/', '/vk/');
      if (!['/vk/login', '/vk/status', '/vk/refresh', '/vk/capabilities'].includes(route))
        throw new Error('vk_oauth_trial_read_only');
    } else if (!weeklyCallback && route === '/vk/callback' && env.VK_OAUTH_TRIAL_CLIENT_ID) {
      const state = url.searchParams.get('state');
      if (state && /^[\w-]{43}$/.test(state)) {
        const candidate = getTrialOAuthBroker(env);
        if (candidate.store.get('state:' + state)) {
          client = candidate;
          trial = true;
        }
      }
    }
    if (request.method === 'GET' && route === '/vk/login') {
      response.writeHead(303, {
        Location: client.begin(session.sessionId),
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      });
      response.end();
      return true;
    }
    if (request.method === 'GET' && route === '/vk/callback') {
      const result = await client.callback(url.searchParams, session.sessionId);
      if (weeklyCallback) {
        response.writeHead(303, {
          Location: '/bot/?vk=connected',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        });
        response.end();
        return true;
      }
      json(
        response,
        200,
        {
          ...result,
          clientId: client.config.clientId,
          trial,
          message: trial
            ? 'Тестовое подключение сохранено отдельно. Права и refresh ещё нужно проверить; основное подключение не изменено.'
            : 'VK подключён. Токены сохранены на сервере; вернитесь в кабинет.',
        },
        cors,
      );
      return true;
    }
    if (request.method === 'GET' && route === '/vk/status') {
      json(response, 200, client.status(), cors);
      return true;
    }
    if (request.method === 'GET' && route === '/vk/capabilities') {
      const methods = [
        ['permissions', 'account.getAppPermissions', {}],
        ['identity', 'users.get', {}],
        ['groups', 'groups.get', { filter: 'admin,editor', extended: 1, count: 1000 }],
      ];
      const groupId = url.searchParams.get('group_id');
      if (groupId && !/^\d+$/.test(groupId)) throw new Error('vk_invalid_target');
      methods.push([
        'photoUpload',
        'photos.getWallUploadServer',
        groupId ? { group_id: groupId } : {},
      ]);
      const results = [];
      for (const [capability, method, parameters] of methods) {
        try {
          const result = await client.api(method, parameters);
          results.push({
            capability,
            method,
            ok: true,
            ...(capability === 'permissions'
              ? { permissions: result }
              : capability === 'groups'
                ? {
                    groups:
                      result.items?.map((g) => ({ id: g.id, name: g.name, isAdmin: g.is_admin })) ||
                      [],
                  }
                : {}),
          });
        } catch (error) {
          results.push({ capability, method, ok: false, error: error.message });
        }
      }
      json(
        response,
        200,
        {
          results,
          note: 'Upload URL proves session access only; a real local-file upload and wall attachment still need a separate test.',
        },
        cors,
      );
      return true;
    }
    if (
      request.method === 'POST' &&
      ['/vk/refresh', '/vk/upload/photo', '/vk/upload/video', '/vk/posts'].includes(route)
    ) {
      assertOrigin(request, env);
      const body = parseJson(await readBody(request));
      let result;
      if (route === '/vk/refresh') {
        await client.accessToken(true);
        result = client.status();
      } else {
        client.target(body.target_type, body.target_id);
        if (route === '/vk/posts') {
          if (
            typeof body.message !== 'string' ||
            body.message.length > 16000 ||
            (body.attachment && typeof body.attachment !== 'string')
          )
            throw new Error('vk_invalid_post');
          result = await client.publishPost(
            body.target_type,
            body.target_id,
            body.message,
            body.attachment || '',
            body.guid,
          );
        } else {
          if (typeof body.filename !== 'string') throw new Error('vk_invalid_media_filename');
          result =
            route === '/vk/upload/photo'
              ? await client.uploadPhoto(body.target_type, body.target_id, body.filename)
              : await client.uploadVideo(body.target_type, body.target_id, body.filename);
        }
      }
      json(response, 200, result, cors);
      return true;
    }
    json(response, 404, { error: 'not_found' }, cors);
    return true;
  } catch (error) {
    await reportOAuthError(env, error);
    if (weeklyCallback) {
      const messages = {
        vk_oauth_wall_photos_groups_required: `VK не выдал приложению права wall, photos и groups. Вход выполнен, но публикации недоступны. Проверьте доступы приложения ${weekly.config.clientId} в кабинете VK ID: повторный вход без изменения доступов их не добавит.`,
        vk_oauth_refresh_token_missing:
          'VK не выдал ключ обновления. Постоянное серверное подключение не сохранено.',
        vk_oauth_exchange_rejected_invalid_scope:
          'VK запретил запрошенные права. Проверьте доступы приложения в кабинете разработчика VK.',
        vk_oauth_exchange_rejected_invalid_client:
          'VK не разрешил серверную авторизацию этого приложения. Проверьте подключение VK ID и Redirect URI в настройках приложения.',
        vk_oauth_consent_denied: 'Доступ в VK не разрешён. Подключение не сохранено.',
        vk_oauth_invalid_state:
          'Попытка входа истекла или относится к другой сессии. Вернитесь в кабинет и начните новый вход.',
      };
      const message =
        messages[error.message] ||
        'VK не завершил серверное подключение. Причина записана в журнале кабинета.';
      const page = oauthStatusPage('VK не подключён для публикаций', message);
      response.writeHead(400, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${page.nonce}'; base-uri 'none'; frame-ancestors 'none'`,
      });
      response.end(page.html);
      return true;
    }
    json(
      response,
      error.status || 400,
      {
        error: /^vk_[a-z0-9_]+$/.test(error.message) ? error.message : 'vk_oauth_internal_failure',
        message:
          'Операция VK не завершена. Проверьте журнал; публикацию с неизвестным исходом не повторяйте автоматически.',
      },
      cors,
    );
    return true;
  }
}

export async function reportOAuthError(env, error) {
  const notifyConfig = {
    logDir: env.BOT_LOG_DIR || 'bot/data/logs',
    statePath: resolve(env.BOT_LOG_DIR || 'bot/data/logs', 'vk-oauth-notify.json'),
    token: env.TELEGRAM_BOT_TOKEN || '',
    alertChatId: env.BOT_ALERT_CHAT_ID || '',
  };
  const logId = await logError(
    notifyConfig,
    {
      platform: 'vk-oauth',
      reason: 'vk_oauth_operation_failed',
      ...(typeof error.vkMethod === 'string' && /^[a-zA-Z]+\.[a-zA-Z]+$/.test(error.vkMethod)
        ? { vkMethod: error.vkMethod }
        : {}),
      ...(Number.isSafeInteger(error.vkSubcode) ? { vkSubcode: error.vkSubcode } : {}),
    },
    new Error(/^vk_[a-z0-9_]+$/.test(error.message) ? error.message : 'vk_oauth_internal_failure'),
  );
  if (notifyConfig.token && notifyConfig.alertChatId) {
    try {
      await sendNotification(
        notifyConfig,
        sendTelegram,
        `<b>Ошибка VK OAuth</b>\nКод: ${/^vk_[a-z0-9_]+$/.test(error.message) ? error.message : 'vk_oauth_internal_failure'}\nЖурнал: ${logId}\nПроверьте операцию в кабинете.`,
        (failure) => publicationBackoffSeconds(failure, 1),
      );
    } catch {
      await logError(
        notifyConfig,
        { platform: 'vk-oauth', reason: 'vk_oauth_alert_failed' },
        new Error('vk_oauth_alert_failed'),
      );
    }
  }
}
