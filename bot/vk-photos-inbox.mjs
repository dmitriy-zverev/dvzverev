import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { escapeHtml } from './content.mjs';
import {
  buildVkOAuthAuthorizeUrl,
  isVkPhotosAuthFailure,
  parseVkOAuthRedirectUrl,
  saveVkPhotosToken,
} from './vk-photos-token.mjs';

const INBOX_NAME = 'vk-photos-inbox.json';
const REFRESH_COOLDOWN_MS = 60 * 60 * 1000;

function inboxPath(config) {
  return `${dirname(config.statePath)}/${INBOX_NAME}`;
}

async function readInbox(config) {
  try {
    return JSON.parse(await readFile(inboxPath(config), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { updateOffset: 0, refresh: null };
    }
    throw error;
  }
}

async function writeInbox(config, inbox) {
  const path = inboxPath(config);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(inbox, null, 2), { mode: 0o600 });
  await rename(temp, path);
}

function operatorUserId(config) {
  const raw = process.env.BOT_OPERATOR_USER_ID || '';
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

async function sendOperatorHtml(config, html, fetchImpl = fetch) {
  if (!config.alertChatId?.trim() || !config.token) return false;
  const response = await fetchImpl(`https://api.telegram.org/bot${config.token}/sendMessage`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.alertChatId,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    }),
  });
  const body = await response.json();
  return response.ok && body.ok === true;
}

export async function noteVkPhotosAuthFailure(config, errorCode, reason = 'vk_photo_api_rejected') {
  if (!config.vkImagesEnabled || !isVkPhotosAuthFailure(reason, errorCode)) return;
  await queueVkPhotosTokenRefresh(config, reason, errorCode);
}

async function queueVkPhotosTokenRefresh(config, reason, errorCode, { force = false } = {}) {
  const inbox = await readInbox(config);
  const now = Date.now();
  if (
    !force &&
    inbox.refresh?.alertSentAt &&
    now - Date.parse(inbox.refresh.alertSentAt) < REFRESH_COOLDOWN_MS
  ) {
    return false;
  }
  inbox.refresh = {
    reason,
    errorCode: errorCode ?? null,
    requestedAt: new Date(now).toISOString(),
    alertSentAt: null,
  };
  await writeInbox(config, inbox);
  return true;
}

export async function sendVkPhotosTokenRefreshRequest(config, { fetchImpl = fetch } = {}) {
  if (!config.vkImagesEnabled) throw new Error('VK_IMAGES_ENABLED is false');
  const queued = await queueVkPhotosTokenRefresh(config, 'operator_request', null, { force: true });
  if (!queued) return { sent: false, reason: 'cooldown' };
  const inbox = await readInbox(config);
  await sendRefreshInstructions(config, inbox, fetchImpl);
  const poll = await processVkPhotosInbox(config, { fetchImpl });
  const authorizeUrl = process.env.VK_OAUTH_CLIENT_ID
    ? buildVkOAuthAuthorizeUrl(process.env.VK_OAUTH_CLIENT_ID)
    : null;
  return { sent: true, authorizeUrl, poll };
}

async function sendRefreshInstructions(config, inbox, fetchImpl) {
  const clientId = process.env.VK_OAUTH_CLIENT_ID;
  if (!clientId?.trim()) {
    console.error('VK_OAUTH_CLIENT_ID is not set; cannot build VK OAuth link for operator.');
    return;
  }
  const authorizeUrl = buildVkOAuthAuthorizeUrl(clientId);
  const html =
    `<b>VK: нужен новый токен для фото</b>\n` +
    `Причина: ${escapeHtml(inbox.refresh?.reason || 'auth_failure')} (код ${inbox.refresh?.errorCode ?? '—'})\n\n` +
    `1. Открой ссылку и разреши доступ:\n${escapeHtml(authorizeUrl)}\n\n` +
    `2. После редиректа скопируй <b>весь</b> адрес из строки браузера ` +
    `(oauth.vk.ru/blank.html#access_token=...)\n\n` +
    `3. Отправь его сюда одним сообщением.\n\n` +
    `Токен сохранится в data/vk-photos.token` +
    (process.env.BOT_ENV_FILE || ' и в bot/.env, если файл доступен для записи') +
    `.`;
  const sent = await sendOperatorHtml(config, html, fetchImpl);
  if (sent) {
    inbox.refresh.alertSentAt = new Date().toISOString();
    await writeInbox(config, inbox);
  }
}

async function handleOperatorText(config, text, fetchImpl) {
  const parsed = parseVkOAuthRedirectUrl(text);
  await saveVkPhotosToken(config, parsed.accessToken);
  const inbox = await readInbox(config);
  inbox.refresh = null;
  await writeInbox(config, inbox);
  await sendOperatorHtml(
    config,
    `<b>VK photos token обновлён</b>\n` +
      `user_id: ${escapeHtml(String(parsed.userId || '—'))}\n` +
      `expires_in: ${escapeHtml(String(parsed.expiresIn || '—'))} с\n` +
      `Следующие публикации с обложкой в VK попробуют загрузку снова.`,
    fetchImpl,
  );
  return true;
}

export async function processVkPhotosInbox(config, { fetchImpl = fetch } = {}) {
  if (!config.vkImagesEnabled || !config.token) return { processed: 0 };
  const operatorId = operatorUserId(config);
  if (!operatorId) return { processed: 0 };

  const inbox = await readInbox(config);
  if (inbox.refresh && !inbox.refresh.alertSentAt) {
    await sendRefreshInstructions(config, inbox, fetchImpl);
  }

  const response = await fetchImpl(
    `https://api.telegram.org/bot${config.token}/getUpdates?timeout=0&offset=${inbox.updateOffset || 0}`,
    { signal: AbortSignal.timeout(15_000) },
  );
  const body = await response.json();
  if (!response.ok || body.ok !== true || !Array.isArray(body.result)) {
    return { processed: 0 };
  }

  let processed = 0;
  for (const update of body.result) {
    inbox.updateOffset = Math.max(inbox.updateOffset || 0, update.update_id + 1);
    const message = update.message;
    if (!message?.from || message.from.id !== operatorId) continue;
    const text = message.text || message.caption || '';
    if (!text.includes('access_token=') && !text.includes('oauth.vk.')) continue;
    try {
      await handleOperatorText(config, text, fetchImpl);
      processed += 1;
    } catch (error) {
      await sendOperatorHtml(
        config,
        `<b>Не удалось разобрать ссылку VK</b>\n${escapeHtml(error.message)}\n` +
          `Пришли полный URL после авторизации.`,
        fetchImpl,
      );
    }
  }
  await writeInbox(config, inbox);
  return { processed };
}
