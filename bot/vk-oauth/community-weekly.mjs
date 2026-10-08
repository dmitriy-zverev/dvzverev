import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readOptionalEnvValue } from '../config/env.mjs';
import { uploadVkCover } from '../images.mjs';

/** All VK destinations with group + community token env — not only vk-weekly media. */
export function listWeeklyCommunityTargets(env) {
  const configPath = resolve(env.BOT_CONFIG_PATH || 'bot/service.json');
  const document = JSON.parse(readFileSync(configPath, 'utf8'));
  const targets = [];
  for (const [destinationId, destination] of Object.entries(document.destinations || {})) {
    if (destination.platform !== 'vk') continue;
    const credentialEnv = destination.credentialEnv;
    const groupIdEnv = destination.groupIdEnv;
    if (!credentialEnv || !groupIdEnv) continue;
    targets.push({
      destinationId,
      credentialEnv,
      groupIdEnv,
      groupId: readOptionalEnvValue(env, groupIdEnv) || '',
      token: readOptionalEnvValue(env, credentialEnv) || '',
    });
  }
  return targets;
}

export class CommunityWeeklyPublisher {
  constructor(env, targets, fetcher = fetch, uploadDocument = uploadVkCover) {
    this.env = env;
    this.targets = targets;
    this.byGroup = new Map(
      targets.filter((t) => t.token && t.groupId).map((t) => [String(t.groupId), t.token]),
    );
    this._groupId = null;
    this.fetcher = fetcher;
    this.uploadDocument = uploadDocument;
    this.mode = 'community';
  }

  status() {
    const required = this.targets.length;
    const configured = this.byGroup.size;
    const ready = required > 0 && configured === required;
    return {
      mode: 'community',
      available: required > 0,
      connected: ready,
      canPrepare: ready,
      canVideo: false,
      refreshAvailable: false,
      grantedScope: 'community',
      groups: this.targets.map((t) => ({
        destinationId: t.destinationId,
        groupId: t.groupId || null,
        configured: Boolean(t.token && t.groupId),
      })),
      missingCredentials: this.targets
        .filter((t) => !t.token || !t.groupId)
        .map((t) => t.credentialEnv),
    };
  }

  bindGroup(groupId) {
    const key = String(groupId);
    if (!this.byGroup.has(key)) throw new Error('vk_community_group_not_configured');
    this._groupId = key;
  }

  accessToken() {
    if (!this._groupId) throw new Error('vk_community_group_not_selected');
    const token = this.byGroup.get(this._groupId);
    if (!token) throw new Error('vk_community_token_missing');
    return token;
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
      const vkCode = Number(body.error?.error_code) || null;
      const error = new Error(`vk_api_rejected_${vkCode || response.status}`);
      if (vkCode) error.vkCode = vkCode;
      throw error;
    }
    return body.response;
  }

  async api(method, parameters = {}) {
    return this.rawApi(method, parameters, this.accessToken());
  }

  async uploadVideo() {
    throw new Error('vk_video_permission_required');
  }

  async uploadWeeklyImage(config, entry) {
    // Community token cannot call photos.*; wall image = GIF document (type 3).
    return this.uploadDocument(
      {
        ...config,
        vkToken: this.accessToken(),
        staticPhoto: false,
        vkPhotosToken: '',
      },
      entry,
    );
  }
}

let communityBroker;
let communityBrokerKey = '';

function communityBrokerFingerprint(env) {
  return listWeeklyCommunityTargets(env)
    .map((t) => `${t.destinationId}:${t.groupId}:${t.token ? '1' : '0'}`)
    .join('|');
}

export function getCommunityWeeklyPublisher(env) {
  const key = communityBrokerFingerprint(env);
  if (!communityBroker || communityBrokerKey !== key) {
    communityBroker = new CommunityWeeklyPublisher(env, listWeeklyCommunityTargets(env));
    communityBrokerKey = key;
  }
  return communityBroker;
}
