import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const TOKEN_PATTERN = /^vk1\.a\.[A-Za-z0-9_.-]+$/;

export function vkPhotosTokenPath(config) {
  const fromEnv = process.env.BOT_VK_PHOTOS_TOKEN_PATH;
  if (fromEnv?.trim()) return resolve(fromEnv.trim());
  return resolve(dirname(config.statePath), 'vk-photos.token');
}

export function envFilePath() {
  const fromEnv = process.env.BOT_ENV_FILE;
  if (fromEnv?.trim()) return resolve(fromEnv.trim());
  return resolve(dirname(resolve(process.env.BOT_STATE_PATH || 'bot/data/state.json')), '../.env');
}

export function parseVkOAuthRedirectUrl(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Empty VK OAuth redirect');
  }
  const trimmed = text.trim();
  let fragment = '';
  const urlMatch = trimmed.match(/https?:\/\/oauth\.vk\.(?:ru|com)\/blank\.html#([^\s]+)/i);
  if (urlMatch) fragment = urlMatch[1];
  else if (trimmed.includes('access_token=')) fragment = trimmed.replace(/^[^#]*#/, '');
  else throw new Error('Expected oauth.vk.ru/blank.html#access_token=... URL');

  const params = new URLSearchParams(fragment);
  const accessToken = params.get('access_token');
  if (!accessToken || !TOKEN_PATTERN.test(accessToken)) {
    throw new Error('Invalid access_token in VK OAuth redirect');
  }
  return {
    accessToken,
    expiresIn: params.get('expires_in'),
    userId: params.get('user_id'),
  };
}

export function isVkPhotosAuthFailure(reason, errorCode) {
  if (reason === 'vk_photo_token_required') return true;
  if (reason === 'vk_photo_api_rejected' && [5, 27].includes(Number(errorCode))) return true;
  return false;
}

export function buildVkOAuthAuthorizeUrl(clientId) {
  const id = String(clientId || '').trim();
  if (!/^\d+$/.test(id)) throw new Error('VK_OAUTH_CLIENT_ID must be a numeric app id');
  const query = new URLSearchParams({
    client_id: id,
    display: 'page',
    redirect_uri: 'https://oauth.vk.ru/blank.html',
    scope: 'wall,photos,groups',
    response_type: 'token',
    v: '5.199',
  });
  return `https://oauth.vk.ru/authorize?${query}`;
}

export async function readStoredVkPhotosToken(config) {
  try {
    const token = (await readFile(vkPhotosTokenPath(config), 'utf8')).trim();
    return TOKEN_PATTERN.test(token) ? token : '';
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

export async function attachVkPhotosToken(config) {
  const stored = await readStoredVkPhotosToken(config);
  if (stored) config.vkPhotosToken = stored;
  else if (process.env.VK_PHOTOS_ACCESS_TOKEN?.trim()) {
    config.vkPhotosToken = process.env.VK_PHOTOS_ACCESS_TOKEN.trim();
  }
  return config;
}

async function writeAtomic(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, contents, { mode: 0o600 });
  await rename(temp, path);
}

export async function updateEnvVkPhotosToken(token) {
  const path = envFilePath();
  let body;
  try {
    body = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  const line = `VK_PHOTOS_ACCESS_TOKEN=${token}`;
  const pattern = /^VK_PHOTOS_ACCESS_TOKEN=.*$/m;
  const next = pattern.test(body)
    ? body.replace(pattern, line)
    : `${body.trimEnd()}\n${line}\n`;
  await writeAtomic(path, next);
  return true;
}

export async function saveVkPhotosToken(config, accessToken) {
  if (!TOKEN_PATTERN.test(accessToken)) throw new Error('Invalid VK photos access token format');
  await writeAtomic(vkPhotosTokenPath(config), `${accessToken}\n`);
  process.env.VK_PHOTOS_ACCESS_TOKEN = accessToken;
  config.vkPhotosToken = accessToken;
  try {
    await updateEnvVkPhotosToken(accessToken);
  } catch {
    // .env may be read-only inside Docker; token file is enough for runtime.
  }
  return { tokenPath: vkPhotosTokenPath(config) };
}
