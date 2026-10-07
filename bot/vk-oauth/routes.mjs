import { resolve, dirname } from 'node:path';
import { OAuthStore } from './store.mjs';
import { VkOAuthClient, oauthConfig } from './client.mjs';
import { logError } from '../logging.mjs';
import { sendNotification } from '../notifications.mjs';
import { publicationBackoffSeconds, sendTelegram } from '../core.mjs';

let broker;
export function getOAuthBroker(env) {
  if (!broker) {
    const path =
      env.VK_OAUTH_STORE_PATH ||
      resolve(dirname(env.BOT_CABINET_DB_PATH || 'bot/data/cabinet.sqlite'), 'vk-oauth.sqlite');
    broker = new VkOAuthClient(new OAuthStore(path, env.VK_OAUTH_ENCRYPTION_KEY), oauthConfig(env));
  }
  return broker;
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
  if (!route.startsWith('/vk/') || env.VK_OAUTH_ENABLED !== 'true') return false;
  try {
    const client = getOAuthBroker(env);
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
      json(
        response,
        200,
        { ...result, message: 'VK подключён. Токены сохранены на сервере; вернитесь в кабинет.' },
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
    const notifyConfig = {
      logDir: env.BOT_LOG_DIR || 'bot/data/logs',
      statePath: resolve(env.BOT_LOG_DIR || 'bot/data/logs', 'vk-oauth-notify.json'),
      token: env.TELEGRAM_BOT_TOKEN || '',
      alertChatId: env.BOT_ALERT_CHAT_ID || '',
    };
    const logId = await logError(
      notifyConfig,
      { platform: 'vk-oauth', reason: 'vk_oauth_operation_failed' },
      new Error(
        /^vk_[a-z0-9_]+$/.test(error.message) ? error.message : 'vk_oauth_internal_failure',
      ),
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
