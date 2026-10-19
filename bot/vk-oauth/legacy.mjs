import { resolve, dirname } from 'node:path';
import { OAuthStore } from './store.mjs';
import { VkOAuthClient, oauthConfig } from './client.mjs';
import { getCommunityWeeklyPublisher } from './community-weekly.mjs';

export const VK_RIGHT_BITS = {
  photos: 4,
  video: 16,
  wall: 8192,
  offline: 65536,
  groups: 262144,
};

const REQUIRED_PHOTO_RIGHTS = ['wall', 'photos', 'groups'];

export function describeVkPermissions(mask) {
  const value = Number.isSafeInteger(Number(mask)) ? Number(mask) : 0;
  const rights = Object.fromEntries(
    Object.entries(VK_RIGHT_BITS).map(([name, bit]) => [name, (value & bit) === bit]),
  );
  const missing = REQUIRED_PHOTO_RIGHTS.filter((name) => !rights[name]);
  return {
    mask: value,
    rights,
    missing,
    canPhoto: missing.length === 0,
    canVideo: rights.video === true,
  };
}

function ownerStatusFields(connected, permissions, extra = {}) {
  const described = describeVkPermissions(permissions);
  return {
    ...extra,
    mode: 'owner',
    available: true,
    connected,
    canPrepare: connected && described.canPhoto,
    canPhoto: connected && described.canPhoto,
    canVideo: connected && described.canVideo,
    permissions: described.mask,
    rights: described.rights,
    missingRights: described.missing,
  };
}

// Server-issued VK ID tokens for the publishing app. Weekly GIF posts stay on community keys.
export class WeeklyVkClient extends VkOAuthClient {
  async tokenRequest(parameters) {
    const token = await super.tokenRequest(parameters);
    let permissions = 0;
    try {
      const raw = Number(await this.rawApi('account.getAppPermissions', {}, token.access_token));
      if (Number.isSafeInteger(raw)) permissions = raw;
    } catch (error) {
      // VK ID apps often deny this method (15/1051); keep identity token and show missing rights.
      if (![15, 1051].includes(error.vkCode)) throw error;
    }
    return { ...token, permissions };
  }
  status() {
    const status = super.status();
    const permissions = this.store.get('token')?.permissions || 0;
    return ownerStatusFields(status.connected, permissions, status);
  }
}

let ownerBroker;
let ownerBrokerKey = '';

function ownerBrokerFingerprint(env) {
  return [
    env.VK_WEEKLY_OAUTH_ENABLED === 'true' ? `weekly:${env.VK_WEEKLY_CLIENT_ID}` : '',
    env.VK_OAUTH_STORE_PATH || '',
  ].join('|');
}

/** VK ID PKCE for scope checks. Not used for weekly GIF posts. */
export function getOwnerVkClient(env) {
  if (env.VK_WEEKLY_OAUTH_ENABLED !== 'true') return null;
  const key = ownerBrokerFingerprint(env);
  if (!ownerBroker || ownerBrokerKey !== key) {
    const path =
      env.VK_OAUTH_STORE_PATH ||
      resolve(dirname(env.BOT_CABINET_DB_PATH || 'bot/data/cabinet.sqlite'), 'vk-oauth.sqlite');
    const config = oauthConfig({ ...env, VK_OAUTH_CLIENT_ID: env.VK_WEEKLY_CLIENT_ID });
    ownerBroker = new WeeklyVkClient(
      new OAuthStore(`${path}.weekly-${config.clientId}`, env.VK_OAUTH_ENCRYPTION_KEY),
      config,
    );
    ownerBrokerKey = key;
  }
  return ownerBroker;
}

/** Weekly prepare/publish always uses community tokens (text + GIF docs). */
export function getWeeklyVkClient(env) {
  return getCommunityWeeklyPublisher(env);
}

export function weeklyVkStatus(env) {
  const community = getWeeklyVkClient(env).status();
  const owner = getOwnerVkClient(env);
  const ownerStatus = owner?.status?.() || null;
  return {
    ...community,
    ownerOAuth: owner
      ? {
          ...ownerStatus,
          available: true,
          clientId: owner.config?.clientId || null,
        }
      : { available: false, connected: false, canPhoto: false },
  };
}

