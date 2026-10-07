import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { OAuthStore } from './store.mjs';
import { VkOAuthClient } from './client.mjs';

export class LegacyVkClient extends VkOAuthClient {
  begin(sessionId) {
    const state = randomBytes(32).toString('base64url');
    this.store.clearStates();
    this.store.set(`state:${state}`, { sessionId, expiresAt: this.now() + 600000 });
    return (
      'https://oauth.vk.ru/authorize?' +
      new URLSearchParams({
        client_id: this.config.clientId,
        redirect_uri: this.config.redirectUri,
        response_type: 'token',
        scope: 'wall,photos,video,groups',
        display: 'page',
        v: '5.199',
        state,
      })
    );
  }
  async complete(body, sessionId) {
    if (!/^[\w-]{43}$/.test(body.state || '')) throw new Error('vk_oauth_invalid_state');
    const attempt = this.store.takeState(body.state);
    if (!attempt || attempt.sessionId !== sessionId || attempt.expiresAt <= this.now())
      throw new Error('vk_oauth_invalid_state');
    if (!/^vk1\.a\.[\w.-]{20,2000}$/.test(body.access_token || ''))
      throw new Error('vk_oauth_invalid_token');
    const expiresIn = Number(body.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn < 0) throw new Error('vk_oauth_invalid_expiry');
    const users = await this.rawApi('users.get', {}, body.access_token);
    const userId = users?.[0]?.id;
    if (
      !Number.isSafeInteger(userId) ||
      userId <= 0 ||
      (this.config.allowedUserId && String(userId) !== this.config.allowedUserId)
    )
      throw new Error('vk_oauth_wrong_user');
    const previous = this.store.get('token');
    if (previous && previous.userId !== userId)
      throw new Error('vk_oauth_account_replacement_blocked');
    const permissions = await this.rawApi('account.getAppPermissions', {}, body.access_token);
    if ((Number(permissions) & 270340) !== 270340)
      throw new Error('vk_oauth_wall_photos_groups_required');
    // Implicit flow has no refresh token. Bound local validity even for expires_in=0.
    this.store.set('token', {
      accessToken: body.access_token,
      userId,
      permissions,
      expiresAt: this.now() + Math.min(expiresIn || 86400, 86400) * 1000,
      scope: 'wall photos groups' + (Number(permissions) & 16 ? ' video' : ''),
      updatedAt: this.now(),
    });
    return this.status();
  }
  status() {
    const token = this.store.get('token');
    const connected = Boolean(token && token.expiresAt > this.now());
    return {
      available: true,
      connected,
      canPrepare: connected && (token.permissions & 270340) === 270340,
      canVideo: connected && (token.permissions & 16) === 16,
      userId: token?.userId || null,
      expiresAt: token ? new Date(token.expiresAt).toISOString() : null,
      refreshAvailable: false,
      grantedScope: token?.scope || null,
    };
  }
  async accessToken(force = false) {
    const token = this.store.get('token');
    if (force || !token || token.expiresAt <= this.now())
      throw new Error('vk_oauth_login_required');
    return token.accessToken;
  }
}

let broker;
export function getWeeklyVkClient(env) {
  if (env.VK_LEGACY_OAUTH_ENABLED !== 'true') return null;
  if (!broker) {
    const clientId = env.VK_LEGACY_CLIENT_ID;
    const redirectUri = new URL(env.VK_LEGACY_REDIRECT_URI);
    if (
      !/^\d+$/.test(clientId || '') ||
      redirectUri.protocol !== 'https:' ||
      redirectUri.hash ||
      redirectUri.search
    )
      throw new Error('vk_legacy_config_invalid');
    const path =
      env.VK_OAUTH_STORE_PATH ||
      resolve(dirname(env.BOT_CABINET_DB_PATH || 'bot/data/cabinet.sqlite'), 'vk-oauth.sqlite');
    broker = new LegacyVkClient(
      new OAuthStore(`${path}.legacy-${clientId}`, env.VK_OAUTH_ENCRYPTION_KEY),
      {
        clientId,
        redirectUri: redirectUri.href,
        allowedUserId: env.VK_OAUTH_ALLOWED_USER_ID || '',
      },
    );
  }
  return broker;
}

export function legacyCallbackPage() {
  const nonce = randomBytes(18).toString('base64');
  return {
    nonce,
    html: `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Подключение VK</title><body><p>Проверяем права VK. Сейчас вернём вас в календарь…</p><script nonce="${nonce}">
    const values = Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
    history.replaceState({}, '', location.pathname);
    fetch('/vk/legacy/complete', {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:JSON.stringify(values)})
      .then(r=>{location.replace(r.ok?'/bot/?vk=connected':'/bot/?vk=error')})
      .catch(()=>location.replace('/bot/?vk=error'));
  </script></body></html>`,
  };
}
