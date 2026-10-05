import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseVkOAuthRedirectUrl,
  saveVkPhotosToken,
  readStoredVkPhotosToken,
  buildVkOAuthAuthorizeUrl,
  isVkPhotosAuthFailure,
} from '../../bot/vk-photos-token.mjs';

test('parseVkOAuthRedirectUrl extracts access_token from full redirect URL', () => {
  const url =
    'https://oauth.vk.ru/blank.html#access_token=vk1.a.abc-def_123&expires_in=86400&user_id=42';
  const parsed = parseVkOAuthRedirectUrl(url);
  assert.equal(parsed.accessToken, 'vk1.a.abc-def_123');
  assert.equal(parsed.expiresIn, '86400');
  assert.equal(parsed.userId, '42');
});

test('isVkPhotosAuthFailure detects auth-related VK image errors', () => {
  assert.equal(isVkPhotosAuthFailure('vk_photo_token_required', 27), true);
  assert.equal(isVkPhotosAuthFailure('vk_photo_api_rejected', 5), true);
  assert.equal(isVkPhotosAuthFailure('vk_photo_upload_failed', 5), false);
});

test('saveVkPhotosToken writes file readable by readStoredVkPhotosToken', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'vk-token-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { statePath: join(dir, 'state.json') };
  await saveVkPhotosToken(config, 'vk1.a.test-token-value');
  const stored = await readStoredVkPhotosToken(config);
  assert.equal(stored, 'vk1.a.test-token-value');
  const raw = await readFile(join(dir, 'vk-photos.token'), 'utf8');
  assert.equal(raw.trim(), 'vk1.a.test-token-value');
});

test('buildVkOAuthAuthorizeUrl includes client id and scopes', () => {
  const url = buildVkOAuthAuthorizeUrl('54805806');
  assert.match(url, /client_id=54805806/);
  assert.match(url, /scope=wall%2Cphotos%2Cgroups/);
});
