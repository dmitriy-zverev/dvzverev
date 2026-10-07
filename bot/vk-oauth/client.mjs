import { randomBytes, createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep, basename } from 'node:path';

export function oauthConfig(env = process.env) {
  if (!/^\d+$/.test(env.VK_OAUTH_CLIENT_ID || '')) throw new Error('VK_OAUTH_CLIENT_ID required');
  const redirect = new URL(env.VK_OAUTH_REDIRECT_URI);
  if (redirect.protocol !== 'https:' || redirect.search || redirect.hash)
    throw new Error('OAuth redirect must be HTTPS without query/fragment');
  return {
    clientId: env.VK_OAUTH_CLIENT_ID,
    redirectUri: redirect.href,
    scope: env.VK_OAUTH_SCOPES || 'wall photos groups video',
    mediaDir: env.VK_OAUTH_MEDIA_DIR || 'bot/content/oauth',
    allowedUserId: env.VK_OAUTH_ALLOWED_USER_ID || '',
  };
}

export class VkOAuthClient {
  constructor(store, config, fetcher = fetch, now = Date.now) {
    this.store = store;
    this.config = config;
    this.fetcher = fetcher;
    this.now = now;
    this.refreshPromise = null;
  }
  begin(sessionId) {
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    this.store.clearStates(); // One owner and one login at a time; a new attempt invalidates the previous link.
    this.store.set('state:' + state, { sessionId, verifier, expiresAt: this.now() + 600000 });
    const query = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: this.config.scope,
      state,
      code_challenge_method: 's256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    });
    return `https://id.vk.ru/authorize?${query}`;
  }
  async tokenRequest(parameters) {
    const state = randomBytes(32).toString('base64url');
    const response = await this.fetcher('https://id.vk.ru/oauth2/auth', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      body: new URLSearchParams({
        ...parameters,
        client_id: this.config.clientId,
        redirect_uri: this.config.redirectUri,
        state,
      }),
    });
    const body = await response.json();
    if (!response.ok || body.error) throw new Error('vk_oauth_exchange_rejected');
    if (body.state !== state) throw new Error('vk_oauth_response_state_mismatch');
    if (
      !body.access_token ||
      !Number.isFinite(Number(body.expires_in)) ||
      Number(body.expires_in) <= 0
    )
      throw new Error('vk_oauth_invalid_response');
    return body;
  }
  async callback(query, sessionId) {
    const state = query.get('state');
    if (!state || !/^[\w-]{43}$/.test(state)) throw new Error('vk_oauth_invalid_state');
    const attempt = this.store.takeState(state);
    if (!attempt || attempt.sessionId !== sessionId || attempt.expiresAt <= this.now())
      throw new Error('vk_oauth_invalid_state');
    if (query.get('error')) throw new Error('vk_oauth_consent_denied');
    const code = query.get('code'),
      deviceId = query.get('device_id');
    if (!code || !deviceId) throw new Error('vk_oauth_callback_incomplete');
    const token = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      device_id: deviceId,
      code_verifier: attempt.verifier,
    });
    const users = await this.rawApi('users.get', {}, token.access_token);
    const userId = users?.[0]?.id;
    if (
      !Number.isSafeInteger(userId) ||
      userId <= 0 ||
      (this.config.allowedUserId && String(userId) !== this.config.allowedUserId)
    )
      throw new Error('vk_oauth_wrong_user');
    if (token.user_id && Number(token.user_id) !== userId)
      throw new Error('vk_oauth_identity_mismatch');
    const previous = this.store.get('token');
    if (previous && previous.userId !== userId)
      throw new Error('vk_oauth_account_replacement_blocked');
    this.save(token, { deviceId, userId });
    return this.status();
  }
  save(token, previous) {
    if (!token.refresh_token && !previous.refreshToken)
      throw new Error('vk_oauth_refresh_token_missing');
    if (token.user_id && Number(token.user_id) !== previous.userId)
      throw new Error('vk_oauth_identity_mismatch');
    this.store.set('token', {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || previous.refreshToken,
      deviceId: token.device_id || previous.deviceId,
      userId: previous.userId,
      expiresAt: this.now() + Number(token.expires_in) * 1000,
      scope: token.scope ?? previous.scope ?? null,
      updatedAt: this.now(),
    });
  }
  status() {
    const token = this.store.get('token');
    return token
      ? {
          connected: true,
          userId: token.userId,
          expiresAt: new Date(token.expiresAt).toISOString(),
          refreshAvailable: Boolean(token.refreshToken),
          grantedScope: token.scope,
        }
      : { connected: false };
  }
  async accessToken(force = false, rejectedToken = null) {
    const token = this.store.get('token');
    if (!token) throw new Error('vk_oauth_login_required');
    if (force && rejectedToken && token.accessToken !== rejectedToken) return token.accessToken;
    if (!force && token.expiresAt - this.now() > 300000) return token.accessToken;
    // Single broker process owns refresh rotation. Do not run multiple replicas on this volume.
    if (!this.refreshPromise) {
      this.refreshPromise = this.tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken,
        device_id: token.deviceId,
      })
        .then((next) => {
          this.save(next, token);
          return next.access_token;
        })
        .finally(() => {
          this.refreshPromise = null;
        });
    }
    return this.refreshPromise;
  }
  async rawApi(method, parameters, accessToken) {
    let response;
    try {
      response = await this.fetcher(`https://api.vk.com/method/${method}`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        body: new URLSearchParams({ ...parameters, access_token: accessToken, v: '5.199' }),
      });
    } catch {
      throw new Error('vk_api_transport_failure_no_retry');
    }
    const body = await response.json();
    if (!response.ok || body.error) {
      const error = new Error(
        `vk_api_rejected_${Number(body.error?.error_code) || response.status}`,
      );
      error.vkCode = Number(body.error?.error_code) || null;
      throw error; // Do not retain VK request_params: they may contain the access token.
    }
    return body.response;
  }
  async api(method, parameters = {}) {
    const accessToken = await this.accessToken();
    try {
      return await this.rawApi(method, parameters, accessToken);
    } catch (error) {
      if (error.vkCode !== 5) throw error;
      const renewed = await this.accessToken(true, accessToken);
      return this.rawApi(method, parameters, renewed); // Exactly one retry, only after explicit authentication rejection.
    }
  }
  target(type, id) {
    const numeric = Number(id);
    if (!['user', 'group'].includes(type) || !Number.isSafeInteger(numeric) || numeric <= 0)
      throw new Error('vk_invalid_target');
    if (type === 'user' && numeric !== this.store.get('token')?.userId)
      throw new Error('vk_user_target_must_be_self');
    return {
      ownerId: type === 'group' ? -numeric : numeric,
      groupId: type === 'group' ? numeric : null,
    };
  }
  async upload(urlString, filename, field, extensions) {
    const url = new URL(urlString);
    const domains = [
      'vk.com',
      'vk.ru',
      'userapi.com',
      'vkuserphoto.ru',
      'vkuser.net',
      'vk-cdn.net',
      'vkvideo.ru',
    ];
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !domains.some((d) => url.hostname === d || url.hostname.endsWith('.' + d))
    )
      throw new Error('vk_untrusted_upload_url');
    if (
      filename !== basename(filename) ||
      !extensions.some((ext) => filename.toLowerCase().endsWith(ext))
    )
      throw new Error('vk_invalid_media_filename');
    const root = await realpath(resolve(this.config.mediaDir));
    const path = await realpath(resolve(root, filename));
    if (
      !path.startsWith(root + sep) ||
      !(await stat(path)).isFile() ||
      (await stat(path)).size > 64 * 1024 * 1024
    )
      throw new Error('vk_invalid_media_file');
    const content = await readFile(path);
    const form = new FormData();
    form.append(field, new Blob([content]), filename);
    let response;
    try {
      response = await this.fetcher(url, {
        method: 'POST',
        body: form,
        redirect: 'error',
        signal: AbortSignal.timeout(180000),
      });
    } catch {
      throw new Error('vk_upload_transport_failure_no_retry');
    }
    if (!response.ok) throw new Error('vk_upload_http_failure');
    const body = await response.json();
    if (body.error) throw new Error('vk_upload_rejected');
    return body;
  }
  async uploadPhoto(type, id, filename) {
    const target = this.target(type, id);
    const parameters = target.groupId ? { group_id: target.groupId } : {};
    const server = await this.api('photos.getWallUploadServer', parameters);
    const result = await this.upload(server.upload_url, filename, 'photo', [
      '.jpg',
      '.jpeg',
      '.png',
    ]);
    const saved = await this.api('photos.saveWallPhoto', {
      ...parameters,
      server: result.server,
      photo: result.photo,
      hash: result.hash,
    });
    const photo = saved?.[0];
    if (!Number.isSafeInteger(photo?.owner_id) || !Number.isSafeInteger(photo?.id))
      throw new Error('vk_photo_save_invalid');
    return {
      attachment: `photo${photo.owner_id}_${photo.id}${photo.access_key ? '_' + photo.access_key : ''}`,
      ownerId: photo.owner_id,
      id: photo.id,
    };
  }
  async uploadVideo(type, id, filename, title = 'OAuth video test') {
    const target = this.target(type, id);
    const video = await this.api('video.save', {
      name: title,
      wallpost: 0,
      ...(target.groupId ? { group_id: target.groupId } : {}),
    });
    await this.upload(video.upload_url, filename, 'video_file', ['.mp4']);
    if (!Number.isSafeInteger(video.owner_id) || !Number.isSafeInteger(video.video_id))
      throw new Error('vk_video_save_invalid');
    return {
      attachment: `video${video.owner_id}_${video.video_id}${video.access_key ? '_' + video.access_key : ''}`,
      ownerId: video.owner_id,
      id: video.video_id,
      processingMayContinue: true,
    };
  }
  async publishPost(type, id, message, attachment, postGuid) {
    const { ownerId, groupId } = this.target(type, id);
    if (attachment && !/^(photo|video)-?\d+_\d+(?:_[\w-]+)?$/.test(attachment))
      throw new Error('vk_invalid_attachment');
    if (!postGuid || !/^[\w-]{16,64}$/.test(postGuid))
      throw new Error('vk_stable_post_guid_required');
    const key = 'post:' + postGuid;
    const prior = this.store.get(key);
    if (prior) {
      if (prior.ownerId !== ownerId || prior.message !== message || prior.attachment !== attachment)
        throw new Error('vk_post_guid_conflict');
      if (prior.result) return prior.result;
      throw new Error('vk_post_outcome_requires_manual_check');
    }
    this.store.set(key, { ownerId, message, attachment, status: 'dispatching' });
    const result = await this.api('wall.post', {
      owner_id: ownerId,
      message,
      attachments: attachment || '',
      guid: postGuid,
      ...(groupId ? { from_group: 1 } : {}),
    });
    if (!Number.isSafeInteger(result?.post_id)) throw new Error('vk_wall_post_invalid');
    const outcome = {
      postId: result.post_id,
      url: `https://vk.ru/wall${ownerId}_${result.post_id}`,
      attachmentVerified: false,
    };
    this.store.set(key, { ownerId, message, attachment, result: outcome });
    // Confirm that VK did not silently discard the uploaded media.
    try {
      const lookup = await this.api('wall.getById', { posts: `${ownerId}_${result.post_id}` });
      const post = Array.isArray(lookup) ? lookup[0] : lookup.items?.[0];
      outcome.attachmentVerified =
        !attachment ||
        Boolean(
          post?.attachments?.some(
            (a) =>
              `${a.type}${a[a.type]?.owner_id}_${a[a.type]?.id}` ===
              attachment.split('_').slice(0, 2).join('_'),
          ),
        );
    } catch {
      outcome.verificationError = 'vk_post_created_verification_failed';
    }
    this.store.set(key, { ownerId, message, attachment, result: outcome });
    return outcome;
  }
}
