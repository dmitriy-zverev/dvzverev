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

export function parseLegacyRedirectUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('vk_oauth_invalid_redirect');
  }
  if (
    typeof value !== 'string' ||
    value.length > 4000 ||
    url.protocol !== 'https:' ||
    !['oauth.vk.ru', 'oauth.vk.com'].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/blank.html' ||
    url.search
  )
    throw new Error('vk_oauth_invalid_redirect');
  const fields = new URLSearchParams(url.hash.slice(1));
  if (fields.has('error')) throw new Error('vk_oauth_consent_required');
  return {
    state: fields.get('state'),
    access_token: fields.get('access_token'),
    expires_in: fields.get('expires_in'),
  };
}

export function legacyManualLoginPage(authorizeUrl) {
  const nonce = randomBytes(18).toString('base64');
  const href = authorizeUrl
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;');
  return {
    nonce,
    html: `<!doctype html><html lang="ru"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex,nofollow"><title>Подключить VK · Редакционный кабинет</title>
    <style nonce="${nonce}">
    *{box-sizing:border-box}body{margin:0;background:#f3f5f8;color:#20364d;font:16px/1.55 system-ui,sans-serif}
    main{max-width:600px;margin:8vh auto;padding:32px;background:#fff;border:1px solid #dce4eb;border-radius:18px}
    h1{margin:12px 0;font-size:28px;line-height:1.2}h2{font-size:18px;margin:24px 0 8px}p{color:#526981}
    a{color:#2f5f95}label{display:block;margin:16px 0 8px;font-weight:600}
    input{width:100%;min-height:48px;padding:12px;border:1px solid #bac9d9;border-radius:8px;font:inherit}
    .action,button{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:10px 20px;border:0;border-radius:8px;background:#2f5f95;color:#fff;font:600 15px system-ui;text-decoration:none;cursor:pointer}
    button{margin-top:16px}button:disabled{opacity:.55;cursor:wait}:focus-visible{outline:3px solid #6a9cc9;outline-offset:3px}
    #feedback{color:#a32c28;min-height:24px}small{display:block;color:#526981;margin-top:8px}
    @media(max-width:640px){main{margin:20px 12px;padding:24px}}
    </style></head><body><main>
    <a href="/bot/">← В кабинет</a><h1>Подключить VK</h1>
    <p>Подключение нужно для фото, коротких видео и подготовки отложенных постов.</p>
    <h2>1. Войдите в VK</h2><p>Разрешите приложению доступ. VK откроет пустую страницу — оставьте эту вкладку открытой.</p>
    <a class="action" id="vk-authorize" href="${href}" target="_blank" rel="noopener noreferrer">Открыть VK ↗</a>
    <h2>2. Вернитесь сюда с адресом страницы</h2>
    <p>Скопируйте полный адрес пустой страницы из адресной строки браузера и вставьте ниже.</p>
    <form id="vk-connect"><label for="vk-return">Адрес страницы после входа</label>
    <input id="vk-return" type="password" autocomplete="off" spellcheck="false" required maxlength="4000" aria-describedby="vk-private">
    <small id="vk-private">Адрес содержит ключ доступа. Вставляйте его только сюда; кабинет сохранит ключ зашифрованным.</small>
    <button type="submit">Подключить VK</button><p id="feedback" role="status" aria-live="polite"></p></form>
    <script nonce="${nonce}">
    document.getElementById('vk-connect').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget, input = document.getElementById('vk-return'), button = form.querySelector('button'), feedback = document.getElementById('feedback');
      const redirectUrl = input.value.trim(); input.value = ''; button.disabled = true; feedback.textContent = 'Проверяем аккаунт и права…';
      try {
        const response = await fetch('/bot/api/v1/vk/legacy/complete', {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:JSON.stringify({redirectUrl})});
        if (response.status === 401) { location.replace('/bot/'); return; }
        const result = await response.json();
        if (!response.ok) {
          const messages = {vk_oauth_invalid_redirect:'Нужен полный адрес страницы oauth.vk.ru/blank.html после входа.', vk_oauth_invalid_state:'Попытка входа истекла или относится к другой вкладке. Обновите эту страницу и снова откройте VK.', vk_oauth_wrong_user:'Войдите в VK под аккаунтом владельца кабинета.', vk_oauth_wall_photos_groups_required:'VK не выдал права на стену, фотографии и сообщества. Пройдите вход заново.', vk_oauth_invalid_token:'В адресе нет корректного ключа VK. Скопируйте полный адрес после разрешения доступа.', vk_oauth_consent_required:'Сначала разрешите приложению доступ в VK.'};
          feedback.textContent = messages[result.error] || 'Не удалось проверить подключение. Повторите вход в VK.'; return;
        }
        location.replace('/bot/?vk=connected');
      } catch { feedback.textContent = 'Нет связи с кабинетом. Проверьте подключение перед повтором.'; }
      finally { button.disabled = false; }
    });
    </script></main></body></html>`,
  };
}
