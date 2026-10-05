import { escapeHtml, formatPost, formatVkPost, visibleTextLength } from './content.mjs';
import { generatePost, GenerationFailure, DEFAULT_MODEL, DEFAULT_PROMPT } from './openrouter.mjs';
export { formatPost, formatVkPost } from './content.mjs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireLock } from './lock.mjs';
import {
  generateCover,
  cachedCover,
  coverPath,
  uploadVkCover,
  ImageFailure,
  DEFAULT_IMAGE_MODEL,
} from './images.mjs';

export function configFromEnv(env = process.env) {
  const times = (env.BOT_TIMES || '10:00').split(',').map((time) => time.trim());
  if (times.some((time) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) {
    throw new Error('BOT_TIMES must contain HH:mm times separated by commas');
  }
  const timezone = env.BOT_TIMEZONE || 'Europe/Moscow';
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  const vkToken = env.VK_ACCESS_TOKEN || '';
  const vkGroupId = env.VK_GROUP_ID || '';
  const postSource = env.BOT_POST_SOURCE || 'queue';
  const contentMode = env.BOT_CONTENT_MODE || 'tip';
  if (!['tip', 'digest'].includes(contentMode)) throw new Error('Invalid BOT_CONTENT_MODE');
  if (!['queue', 'openrouter'].includes(postSource)) throw new Error('Invalid BOT_POST_SOURCE');
  return {
    token: env.TELEGRAM_BOT_TOKEN || '',
    chatId: env.TELEGRAM_CHAT_ID || '',
    alertChatId: env.BOT_ALERT_CHAT_ID || '',
    vkToken,
    vkGroupId,
    vkPhotosToken: env.VK_PHOTOS_ACCESS_TOKEN || '',
    imagesEnabled: env.BOT_IMAGES_ENABLED === 'true',
    vkImagesEnabled: env.VK_IMAGES_ENABLED === 'true',
    imageModel: env.OPENROUTER_IMAGE_MODEL || DEFAULT_IMAGE_MODEL,
    vkEnabled: Boolean(vkToken || vkGroupId),
    vkConfigError: Boolean(vkToken || vkGroupId) && (!vkToken || !/^[1-9]\d*$/.test(vkGroupId)),
    maxAttempts: 3,
    postSource,
    contentMode,
    openrouterKey: env.OPENROUTER_API_KEY || '',
    openrouterModel: env.OPENROUTER_MODEL || DEFAULT_MODEL,
    openrouterPrompt: env.BOT_PROMPT || DEFAULT_PROMPT,
    times: [...new Set(times)].sort(),
    timezone,
    queuePath: resolve(env.BOT_QUEUE_PATH || 'bot/content/posts.json'),
    statePath: resolve(env.BOT_STATE_PATH || 'bot/data/state.json'),
  };
}

export async function readQueue(path) {
  const posts = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(posts)) throw new Error('Queue must be a JSON array');
  const ids = new Set();
  for (const post of posts) {
    if (typeof post?.id !== 'string' || !post.id.trim()) throw new Error('Post ID is required');
    if (ids.has(post.id)) throw new Error(`Duplicate post ID: ${post.id}`);
    ids.add(post.id);
  }
  return posts;
}

// Future LLM integration can replace this provider while keeping delivery intact.
export async function nextQueuedPost(config, entries) {
  const blocked = new Set(
    entries
      .filter(
        (entry) =>
          entry.platform === 'vk' ||
          ['sending', 'sent', 'uncertain', 'retry_wait', 'failed', 'exhausted'].includes(
            entry.status,
          ),
      )
      .map((entry) => entry.postId),
  );
  return (await readQueue(config.queuePath)).find((post) => !blocked.has(post.id));
}

export function dueSlot(config, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: config.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map(({ type, value }) => [type, value]),
  );
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  // Five-minute window handles normal restarts; never catch up old missed slots.
  const time = config.times.findLast((time) => {
    const [h, m] = time.split(':').map(Number);
    const age = minute - (h * 60 + m);
    return age >= 0 && age < 5;
  });
  return time ? `${parts.year}-${parts.month}-${parts.day}@${time}[${config.timezone}]` : null;
}

export async function readState(config) {
  let state;
  try {
    state = JSON.parse(await readFile(config.statePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { version: 1, chatId: config.chatId, entries: [], pauses: {}, cooldowns: {} };
  }
  if (
    state.version !== 1 ||
    !Array.isArray(state.entries) ||
    state.chatId !== config.chatId ||
    (state.paused &&
      (typeof state.paused !== 'object' || typeof state.paused.reason !== 'string')) ||
    state.entries.some(
      (entry) =>
        !entry ||
        typeof entry.slot !== 'string' ||
        (entry.image &&
          (!['pending', 'generating', 'ready', 'failed'].includes(entry.image.status) ||
            typeof entry.image.text !== 'string' ||
            (entry.image.telegram &&
              !['sending', 'sent', 'failed', 'uncertain'].includes(entry.image.telegram.status)) ||
            (entry.image.vk &&
              (!['uploading', 'ready', 'failed'].includes(entry.image.vk.status) ||
                (entry.image.vk.attachment !== undefined &&
                  !/^photo-?\d+_\d+(?:_[A-Za-z0-9_-]+)?$/.test(entry.image.vk.attachment)))))) ||
        (entry.platform !== undefined && !['telegram', 'vk'].includes(entry.platform)) ||
        (entry.platform === 'vk' &&
          (!Number.isInteger(entry.messageId) ||
            typeof entry.vkText !== 'string' ||
            typeof entry.vkGroupId !== 'string')) ||
        ![
          'sending',
          'sent',
          'uncertain',
          'rejected',
          'empty',
          'retry_wait',
          'failed',
          'exhausted',
        ].includes(entry.status) ||
        (entry.status !== 'empty' && typeof entry.postId !== 'string') ||
        (entry.status === 'retry_wait' &&
          (!Number.isFinite(Date.parse(entry.retryAt)) ||
            !Number.isInteger(entry.attempts) ||
            typeof entry.html !== 'string')),
    )
  ) {
    throw new Error(
      'State is invalid or belongs to another channel; do not delete delivery history',
    );
  }
  if (
    state.pauses &&
    (typeof state.pauses !== 'object' ||
      Array.isArray(state.pauses) ||
      Object.entries(state.pauses).some(
        ([platform, pause]) =>
          !['telegram', 'vk', 'queue', 'openrouter'].includes(platform) ||
          !pause ||
          typeof pause.reason !== 'string',
      ))
  )
    throw new Error('Invalid service pauses');
  if (
    state.cooldowns &&
    Object.values(state.cooldowns).some((until) => !Number.isFinite(Date.parse(until)))
  )
    throw new Error('Invalid cooldown');
  state.pauses ||= {};
  state.cooldowns ||= {};
  if (
    state.pendingGeneration &&
    (typeof state.pendingGeneration.id !== 'string' ||
      typeof state.pendingGeneration.slot !== 'string' ||
      !Number.isInteger(state.pendingGeneration.attempts) ||
      !['generating', 'retry_wait', 'failed'].includes(state.pendingGeneration.status) ||
      (state.pendingGeneration.status === 'retry_wait' &&
        !Number.isFinite(Date.parse(state.pendingGeneration.retryAt))))
  )
    throw new Error('Invalid generation state');
  if (state.paused) {
    const platform =
      state.paused.reason === 'invalid_queue' ? 'queue' : state.paused.platform || 'telegram';
    state.pauses[platform] ||= { ...state.paused, platform };
    delete state.paused;
  }
  return state;
}

async function saveState(config, state) {
  const temporary = `${config.statePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, config.statePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class TelegramRejection extends Error {
  constructor(code, retryAfter = 0) {
    super(`Telegram rejected request (${code})`);
    this.code = Number(code);
    this.retryAfter = Number.isInteger(retryAfter) && retryAfter > 0 ? retryAfter : 0;
    this.kind =
      this.code === 429 || this.code >= 500
        ? 'temporary'
        : [401, 403].includes(this.code)
          ? 'configuration'
          : 'permanent';
  }
}

export async function sendTelegram(config, html, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: html,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      }),
    });
    const body = await response.json();
    if (body.ok === false && Number.isInteger(body.error_code)) {
      throw new TelegramRejection(body.error_code, body.parameters?.retry_after);
    }
    if (!response.ok || body.ok !== true || !Number.isInteger(body.result?.message_id)) {
      throw new Error('Unconfirmed response');
    }
    return body.result.message_id;
  } catch (error) {
    if (error instanceof TelegramRejection) throw error;
    // Original errors may contain the token-bearing URL. Do not attach a cause.
    // eslint-disable-next-line preserve-caught-error
    throw new Error('Telegram delivery is uncertain; check the channel before retrying');
  }
}

export async function sendTelegramPhoto(config, entry, caption = '', fetchImpl = fetch) {
  if (visibleTextLength(caption) > 1024) throw new TelegramRejection(400);
  const photo = await readFile(coverPath(config, entry.postId));
  const form = new FormData();
  form.set('chat_id', config.chatId);
  form.set('photo', new Blob([photo], { type: 'image/png' }), 'cover.png');
  if (caption) {
    form.set('caption', caption);
    form.set('parse_mode', 'HTML');
  }
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${config.token}/sendPhoto`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      body: form,
    });
    const body = await response.json();
    if (body.ok === false && Number.isInteger(body.error_code))
      throw new TelegramRejection(body.error_code, body.parameters?.retry_after);
    if (!response.ok || body.ok !== true || !Number.isInteger(body.result?.message_id))
      throw new Error('Unconfirmed photo response');
    return body.result.message_id;
  } catch (error) {
    if (error instanceof TelegramRejection) throw error;
    // eslint-disable-next-line preserve-caught-error
    throw new Error('Telegram photo delivery is uncertain; inspect the channel');
  }
}

async function prepareImages(config, state, entry, { generateImage, uploadImage, notify }) {
  if (!entry.image) return;
  const image = entry.image;
  const failure = async (target, reason, code = null) => {
    const event = {
      platform: target,
      postId: entry.postId,
      status: 'failed',
      reason,
      errorCode: code,
    };
    (entry.errors ||= []).push(event);
    await saveState(config, state);
    await alert(config, state, event, notify);
  };
  if (image.status === 'generating') {
    const cached = await cachedCover(config, entry.postId);
    image.status = cached ? 'ready' : 'failed';
    if (!cached) await failure('openrouter', 'interrupted_image_generation');
  }
  if (image.status === 'pending') {
    image.status = 'generating';
    await saveState(config, state);
    try {
      Object.assign(image, await generateImage(config, entry));
      image.status = 'ready';
    } catch (error) {
      if (!(error instanceof ImageFailure)) throw error;
      image.status = 'failed';
      await failure('openrouter', error.reason, error.code);
    }
    await saveState(config, state);
  }
  if (image.status !== 'ready') return;
  // Preserve old interrupted releases without re-sending their separate cover.
  if (image.telegram?.status === 'sending') {
    image.telegram.status = 'uncertain';
    await failure('telegram', 'interrupted_photo_delivery');
  }
  if (config.vkImagesEnabled && entry.platform === 'vk' && !image.vk) {
    image.vk = { status: 'uploading' };
    await saveState(config, state);
  }
  if (config.vkImagesEnabled && entry.platform === 'vk' && image.vk.status === 'uploading') {
    try {
      image.vk.attachment = await uploadImage(config, entry);
      image.vk.status = 'ready';
    } catch (error) {
      if (!(error instanceof ImageFailure)) throw error;
      image.vk.status = 'failed';
      await failure('vk', error.reason, error.code);
    }
    await saveState(config, state);
  }
}

export class VkRejection extends Error {
  constructor(code) {
    super(`VK rejected request (${code})`);
    this.code = code;
    this.retryAfter = [9, 29].includes(code) ? 60 : 0;
    this.kind = [6, 9, 10, 29].includes(code)
      ? 'temporary'
      : [5, 7, 14, 15, 17, 20, 27, 203, 214].includes(code)
        ? 'configuration'
        : 'permanent';
  }
}

export async function sendVk(config, entry, fetchImpl = fetch) {
  if (
    !config.vkToken ||
    !/^[1-9]\d*$/.test(config.vkGroupId) ||
    entry.vkGroupId !== config.vkGroupId
  )
    throw new VkRejection(27);
  try {
    const response = await fetchImpl('https://api.vk.com/method/wall.post', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      body: new URLSearchParams({
        access_token: config.vkToken,
        v: '5.199',
        owner_id: `-${entry.vkGroupId}`,
        from_group: '1',
        message: entry.vkText,
        guid: entry.slot,
        ...(config.vkImagesEnabled && entry.image?.vk?.attachment
          ? { attachments: entry.image.vk.attachment }
          : {}),
      }),
    });
    const body = await response.json();
    if (Number.isInteger(body.error?.error_code)) throw new VkRejection(body.error.error_code);
    if (!response.ok || !Number.isInteger(body.response?.post_id) || body.response.post_id < 1)
      throw new Error('Unconfirmed response');
    return body.response.post_id;
  } catch (error) {
    if (error instanceof VkRejection) throw error;
    // Do not expose request bodies, credentials, or arbitrary API descriptions.
    // eslint-disable-next-line preserve-caught-error
    throw new Error('VK delivery is uncertain; check the community before retrying');
  }
}

async function alert(config, state, event, notify) {
  if (!config.alertChatId || (event.alertStatus && event.alertStatus !== 'retry_wait')) return;
  if (event.alertStatus === 'retry_wait' && Date.parse(event.alertRetryAt) > Date.now()) return;
  // Save before notification I/O to avoid repeated alerts on lost responses/restarts.
  event.alertStatus = 'sending';
  event.alertAttempts = (event.alertAttempts || 0) + 1;
  delete event.alertRetryAt;
  await saveState(config, state);
  const message =
    `<b>Сбой автопостера</b>\nПлощадка: ${escapeHtml(event.platform || 'telegram')}\n` +
    `Получатель: ${escapeHtml(event.platform === 'vk' ? `club${config.vkGroupId}` : config.chatId)}\n` +
    `Статус: ${escapeHtml(event.status || 'paused')}\n` +
    `Причина: ${escapeHtml(event.reason || 'delivery_failure')}\n` +
    `Пост: ${escapeHtml(String(event.postId || '—').slice(0, 120))}\n` +
    `Код: ${event.errorCode || '—'}; попыток: ${event.attempts || 0}`;
  try {
    await notify({ ...config, chatId: config.alertChatId }, message);
    event.alertStatus = 'sent';
  } catch (error) {
    if (
      error instanceof TelegramRejection &&
      error.kind === 'temporary' &&
      event.alertAttempts < 3
    ) {
      event.alertStatus = 'retry_wait';
      event.alertRetryAt = new Date(
        Date.now() + Math.max(error.retryAfter, 30 * 2 ** (event.alertAttempts - 1)) * 1000,
      ).toISOString();
    } else {
      event.alertStatus = 'failed';
    }
    console.error(
      'Owner notification failed; inspect bot state. Only confirmed temporary rejections can retry.',
    );
  }
  await saveState(config, state);
}

async function generateForSlot(config, state, slot, now, generate, notify) {
  const job = (state.pendingGeneration ||= {
    id: `llm-${randomUUID()}`,
    slot,
    attempts: 0,
    errors: [],
  });
  const limitReached = job.attempts >= config.maxAttempts;
  job.status = 'generating';
  if (!limitReached) job.attempts++;
  await saveState(config, state);
  const started = Date.now();
  let post;
  let failure;
  if (limitReached) failure = new GenerationFailure('interrupted_generation_limit');
  else {
    try {
      post = await generate(config, {
        id: job.id,
        history: state.entries
          .filter((entry) => entry.generation)
          .map((entry) => entry.generation.title),
        feedback: job.reason,
        excludeUrls: state.entries.slice(-28).flatMap((entry) => entry.generation?.urls || []),
      });
    } catch (error) {
      if (!(error instanceof GenerationFailure)) throw error;
      failure = error;
    }
  }
  if (post) return post;
  const event = {
    platform: 'openrouter',
    postId: job.id,
    reason: failure.reason,
    errorCode: failure.code,
    attempts: job.attempts,
    status: 'retry_wait',
  };
  job.reason = failure.reason;
  job.errors.push(event);
  if (failure.kind === 'configuration') {
    job.status = 'failed';
    event.status = 'paused';
    state.pauses.openrouter = event;
  } else if (job.attempts >= config.maxAttempts) {
    event.status = 'exhausted';
    state.entries.push({
      slot: job.slot,
      postId: job.id,
      platform: 'telegram',
      status: 'exhausted',
      reason: 'generation_exhausted',
      attempts: 0,
      alertStatus: 'covered_by_generation',
      errors: job.errors,
    });
    delete state.pendingGeneration;
  } else {
    job.status = 'retry_wait';
    job.retryAt = new Date(
      now.getTime() +
        Date.now() -
        started +
        Math.max(failure.retryAfter, 15 * 2 ** (job.attempts - 1)) * 1000,
    ).toISOString();
  }
  await saveState(config, state);
  await alert(config, state, event, notify);
  return null;
}

export async function publish(
  config,
  {
    now = new Date(),
    manual = false,
    provider = nextQueuedPost,
    send = sendTelegram,
    sendVK = sendVk,
    notify = sendTelegram,
    generate = generatePost,
    generateImage = generateCover,
    sendPhoto = sendTelegramPhoto,
    uploadImage = uploadVkCover,
  } = {},
) {
  await mkdir(dirname(config.statePath), { recursive: true });
  const release = await acquireLock(`${config.statePath}.lock`);
  if (!release) return { status: 'locked' };
  try {
    const state = await readState(config);
    if (
      (!/^\d+:[A-Za-z0-9_-]+$/.test(config.token) || !config.chatId.trim()) &&
      !state.pauses.telegram
    ) {
      state.pauses.telegram = {
        platform: 'telegram',
        reason: 'invalid_configuration',
        since: now.toISOString(),
      };
      await saveState(config, state);
    }
    if (config.vkConfigError && !state.pauses.vk) {
      state.pauses.vk = {
        platform: 'vk',
        reason: 'invalid_configuration',
        since: now.toISOString(),
      };
      await saveState(config, state);
    }
    // A kernel lock is held: no other sender is active. Old sending records came
    // from a crash and must never be resent without checking the channel.
    for (const entry of state.entries.filter((entry) => entry.status === 'sending')) {
      entry.status = 'uncertain';
      entry.reason = 'interrupted_delivery';
      await saveState(config, state);
    }
    for (const entry of state.entries.filter((entry) =>
      ['uncertain', 'failed', 'exhausted'].includes(entry.status),
    )) {
      await alert(config, state, entry, notify);
    }
    for (const entry of state.entries) {
      for (const event of entry.errors || []) await alert(config, state, event, notify);
    }
    for (const event of state.pendingGeneration?.errors || [])
      await alert(config, state, event, notify);
    for (const pause of Object.values(state.pauses)) await alert(config, state, pause, notify);
    const available = (platform) =>
      !state.pauses[platform] && !(Date.parse(state.cooldowns[platform]) > now.getTime());
    const pending = state.entries.filter(
      (entry) =>
        entry.status === 'retry_wait' || (entry.platform === 'vk' && entry.status === 'rejected'),
    );
    const ready = (entry) =>
      available(entry.platform || 'telegram') && !(Date.parse(entry.retryAt) > now.getTime());
    const telegramPending = pending.find((entry) => entry.platform !== 'vk');
    let entry = telegramPending && ready(telegramPending) ? telegramPending : null;
    let sourceFailure = null;
    const useLlm = config.postSource === 'openrouter' && provider === nextQueuedPost;
    const job = useLlm ? state.pendingGeneration : null;
    const sourceAvailable = useLlm
      ? available('openrouter') && (!job || !(Date.parse(job.retryAt) > now.getTime()))
      : !state.pauses.queue;
    if (!entry && !telegramPending && available('telegram') && sourceAvailable) {
      const slot = job?.slot || (manual ? `manual:${randomUUID()}` : dueSlot(config, now));
      if (slot && !state.entries.some((entry) => entry.slot === slot)) {
        let post;
        try {
          post = useLlm
            ? await generateForSlot(config, state, slot, now, generate, notify)
            : await provider(config, state.entries);
          if (useLlm && !post)
            sourceFailure = state.pendingGeneration
              ? {
                  status: state.pendingGeneration.status === 'failed' ? 'paused' : 'retry_wait',
                  platform: 'openrouter',
                  reason: state.pendingGeneration.reason,
                  retryAt: state.pendingGeneration.retryAt,
                }
              : { status: 'exhausted', platform: 'openrouter', reason: 'generation_exhausted' };
        } catch {
          if (useLlm) throw new Error('Generation state could not be persisted');
          state.pauses.queue = {
            platform: 'queue',
            reason: 'invalid_queue',
            since: now.toISOString(),
          };
          await saveState(config, state);
          await alert(config, state, state.pauses.queue, notify);
        }
        if ((useLlm && post) || (!useLlm && !state.pauses.queue)) {
          entry = {
            slot,
            status: post ? (useLlm || config.imagesEnabled ? 'retry_wait' : 'sending') : 'empty',
            createdAt: now.toISOString(),
            attempts: 0,
            platform: 'telegram',
          };
          if (post) {
            entry.postId = post.id;
            if (post.generation) entry.generation = post.generation;
            if (useLlm) {
              entry.retryAt = now.toISOString();
              entry.errors = state.pendingGeneration.errors;
              entry.generation = post.generation;
              delete state.pendingGeneration;
            }
            try {
              entry.html = formatPost(post);
              if (config.imagesEnabled) {
                if (visibleTextLength(entry.html) > 1024) throw new Error('Photo caption too long');
                entry.retryAt = now.toISOString();
                entry.image = { status: 'pending', text: formatVkPost(post) };
              }
              if (config.vkEnabled || config.vkToken) {
                entry.vkText = formatVkPost(post);
                entry.vkGroupId = config.vkGroupId;
              }
            } catch {
              entry.status = 'failed';
              entry.reason = 'invalid_post';
            }
          }
          state.entries.push(entry);
          await saveState(config, state);
          if (entry.status === 'empty') return { status: 'empty' };
          if (entry.status === 'failed') {
            await alert(config, state, entry, notify);
            return { status: 'failed', postId: entry.postId, reason: entry.reason };
          }
        }
      }
    }
    // VK's delayed or paused backlog never prevents a new Telegram slot.
    if (!entry) entry = pending.find((entry) => entry.platform === 'vk' && ready(entry));
    if (!entry) {
      if (sourceFailure) return sourceFailure;
      const waiting = pending.find((entry) => !state.pauses[entry.platform || 'telegram']);
      if (waiting)
        return {
          status: 'retry_wait',
          platform: waiting.platform || 'telegram',
          retryAt: waiting.retryAt || state.cooldowns[waiting.platform],
        };
      if (state.pendingGeneration?.status === 'retry_wait')
        return {
          status: 'retry_wait',
          platform: 'openrouter',
          retryAt: state.pendingGeneration.retryAt,
        };
      const pause =
        state.pauses.telegram || state.pauses.queue || state.pauses.vk || state.pauses.openrouter;
      if (pause) return { status: 'paused', platform: pause.platform, reason: pause.reason };
      const slot = manual ? null : dueSlot(config, now);
      return {
        status:
          slot && state.entries.some((entry) => entry.slot === slot)
            ? 'already_processed'
            : 'not_due',
      };
    }
    // Commit the Telegram receipt and the pending VK stage atomically before VK I/O.
    // A restart can continue this stage without publishing Telegram again.
    for (;;) {
      if (entry.platform === 'vk' && !available('vk'))
        return {
          status: 'pending_vk',
          postId: entry.postId,
          messageId: entry.messageId,
          platform: 'vk',
          retryAt: state.cooldowns.vk,
        };
      await prepareImages(config, state, entry, { generateImage, uploadImage, notify });
      if (entry.platform !== 'vk' && !available('telegram'))
        return {
          status: 'retry_wait',
          platform: 'telegram',
          postId: entry.postId,
          retryAt: entry.retryAt || state.cooldowns.telegram,
        };
      entry.status = 'sending';
      entry.attempts = (entry.attempts || 0) + 1;
      delete entry.retryAt;
      await saveState(config, state);
      const started = Date.now();
      try {
        if (entry.platform === 'vk') {
          entry.vkPostId = await sendVK(config, entry);
          entry.vkSentAt = new Date().toISOString();
        } else {
          entry.messageId =
            entry.image?.status === 'ready' && !entry.image.telegram
              ? await sendPhoto(config, entry, entry.html)
              : await send(config, entry.html);
          entry.telegramSentAt = new Date().toISOString();
          if (entry.vkText) {
            entry.telegramAttempts = entry.attempts;
            entry.platform = 'vk';
            entry.status = 'rejected';
            entry.attempts = 0;
            delete entry.reason;
            delete entry.errorCode;
          }
        }
        if (entry.status !== 'rejected') {
          entry.status = 'sent';
          entry.sentAt = new Date().toISOString();
        }
      } catch (error) {
        const rejection = error instanceof TelegramRejection || error instanceof VkRejection;
        entry.errorCode = rejection ? error.code : null;
        if (!rejection) {
          entry.status = 'uncertain';
          entry.reason = 'unconfirmed_delivery';
        } else if (error.kind === 'configuration') {
          entry.status = 'failed';
          entry.reason = 'token_or_permissions';
          entry.alertStatus = 'covered_by_pause';
          state.pauses[entry.platform || 'telegram'] = {
            reason: entry.reason,
            platform: entry.platform,
            postId: entry.postId,
            errorCode: error.code,
            since: now.toISOString(),
          };
        } else if (error.kind === 'temporary') {
          entry.reason = [429, 6, 9, 29].includes(error.code)
            ? 'rate_limit'
            : `${entry.platform || 'telegram'}_unavailable`;
          if (entry.attempts >= config.maxAttempts) {
            entry.status = 'exhausted';
          } else {
            const delay = Math.max(
              error.retryAfter,
              10 * 2 ** (entry.attempts - 1) + Math.floor(Math.random() * 5),
            );
            entry.status = 'retry_wait';
            entry.retryAt = new Date(
              now.getTime() + (Date.now() - started) + delay * 1000,
            ).toISOString();
          }
          // Apply rate limits to the whole affected service, including later posts.
          const delay = Math.max(error.retryAfter, 10 * 2 ** (entry.attempts - 1));
          state.cooldowns[entry.platform || 'telegram'] =
            entry.retryAt ||
            new Date(now.getTime() + (Date.now() - started) + delay * 1000).toISOString();
        } else {
          entry.status = 'failed';
          entry.reason = `${entry.platform || 'telegram'}_rejected_post`;
        }
      }
      await saveState(config, state);
      if (entry.status === 'rejected') {
        if (pending.some((older) => older.platform === 'vk' && older !== entry))
          return {
            status: 'pending_vk',
            postId: entry.postId,
            messageId: entry.messageId,
            platform: 'vk',
          };
        continue;
      }
      if (entry.status === 'retry_wait') {
        const event = {
          platform: entry.platform,
          status: entry.status,
          reason: entry.reason,
          postId: entry.postId,
          errorCode: entry.errorCode,
          attempts: entry.attempts,
        };
        (entry.errors ||= []).push(event);
        await alert(config, state, event, notify);
      }
      if (state.pauses[entry.platform || 'telegram'])
        await alert(config, state, state.pauses[entry.platform || 'telegram'], notify);
      else if (['uncertain', 'failed', 'exhausted'].includes(entry.status))
        await alert(config, state, entry, notify);
      return {
        status: entry.status,
        postId: entry.postId,
        messageId: entry.messageId,
        platform: entry.platform || 'telegram',
        vkPostId: entry.vkPostId,
        errorCode: entry.errorCode,
        reason: entry.reason,
        attempts: entry.attempts,
        retryAt: entry.retryAt,
      };
    }
  } finally {
    await release();
  }
}

export async function resume(config, platform = null) {
  if (platform !== null && !['telegram', 'vk', 'queue', 'openrouter'].includes(platform))
    throw new Error('Invalid platform');
  await mkdir(dirname(config.statePath), { recursive: true });
  const release = await acquireLock(`${config.statePath}.lock`);
  if (!release) return { status: 'locked' };
  try {
    const state = await readState(config);
    for (const entry of state.entries.filter(
      (entry) =>
        entry.status === 'failed' &&
        entry.reason === 'token_or_permissions' &&
        (!platform || (entry.platform || 'telegram') === platform),
    )) {
      entry.status = 'retry_wait';
      entry.retryAt = new Date().toISOString();
      entry.attempts = 0;
      delete entry.alertStatus;
    }
    for (const target of platform ? [platform] : ['telegram', 'vk', 'queue', 'openrouter']) {
      delete state.pauses[target];
      delete state.cooldowns[target];
    }
    if ((!platform || platform === 'openrouter') && state.pendingGeneration?.status === 'failed') {
      state.pendingGeneration.status = 'retry_wait';
      state.pendingGeneration.attempts = 0;
      state.pendingGeneration.retryAt = new Date().toISOString();
    }
    if ((!platform || platform === 'vk') && /^[1-9]\d*$/.test(config.vkGroupId)) {
      for (const entry of state.entries.filter(
        (entry) =>
          entry.platform === 'vk' && !/^[1-9]\d*$/.test(entry.vkGroupId) && entry.status !== 'sent',
      ))
        entry.vkGroupId = config.vkGroupId;
    }
    await saveState(config, state);
    return { status: 'resumed' };
  } finally {
    await release();
  }
}

// A separate incident file remains usable even if delivery history is corrupt.
export async function reportRuntimeFailure(config, notify = sendTelegram, failureEvent = null) {
  const incidentConfig = { ...config, statePath: `${config.statePath}.errors.json` };
  const event = failureEvent || {
    reason: 'runtime_or_state_failure',
    platform: 'system',
    status: 'paused',
  };
  let release;
  try {
    await mkdir(dirname(config.statePath), { recursive: true });
    release = await acquireLock(`${incidentConfig.statePath}.lock`);
    if (!release) return;
    let incident;
    try {
      incident = JSON.parse(await readFile(incidentConfig.statePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      incident = { event };
    }
    await alert(incidentConfig, incident, incident.event, notify);
  } catch {
    // If the disk itself is unavailable, the daemon limits this fallback to once
    // per process until a successful scheduler check.
    if (config.alertChatId) {
      try {
        await notify(
          { ...config, chatId: config.alertChatId },
          '<b>Сбой автопостера</b>\nНе удалось прочитать или сохранить состояние. Публикации остановлены; проверьте журнал Docker.',
        );
      } catch {
        console.error('Runtime failure notification could not be delivered.');
      }
    }
  } finally {
    if (release) await release();
  }
}

export async function clearRuntimeFailure(config) {
  const release = await acquireLock(`${config.statePath}.errors.json.lock`);
  if (!release) return;
  try {
    await rm(`${config.statePath}.errors.json`, { force: true });
  } finally {
    await release();
  }
}

export async function resolvePost(config, postId, messageId = null) {
  if (messageId !== null && (!Number.isInteger(messageId) || messageId < 1)) {
    throw new Error('Message ID must be a positive integer');
  }
  const release = await acquireLock(`${config.statePath}.lock`);
  if (!release) return { status: 'locked' };
  try {
    const state = await readState(config);
    const history = state.entries.filter((entry) => entry.postId === postId);
    if (!history.length || history.some((entry) => entry.status === 'sent')) {
      throw new Error('Unknown or already sent post');
    }
    // Earlier rejected attempts remain in history and must not prevent resolving
    // a later failed retry or be resurrected alongside it.
    for (const entry of [history.at(-1)]) {
      if (!['sending', 'uncertain', 'failed', 'exhausted'].includes(entry.status)) {
        throw new Error('Post is not waiting for operator review');
      }
      if (messageId === null && entry.platform === 'vk') {
        entry.status = 'retry_wait';
        entry.retryAt = new Date().toISOString();
        entry.attempts = 0;
      } else {
        entry.status = messageId === null ? 'rejected' : 'sent';
      }
      delete entry.alertStatus;
      entry.resolvedAt = new Date().toISOString();
      if (messageId !== null) {
        if (entry.platform === 'vk') entry.vkPostId = messageId;
        else if (entry.vkText) {
          entry.messageId = messageId;
          entry.platform = 'vk';
          entry.status = 'rejected';
          entry.attempts = 0;
        } else entry.messageId = messageId;
      }
    }
    await saveState(config, state);
    return { status: messageId === null ? 'retry_enabled' : 'marked_sent', postId, messageId };
  } finally {
    await release();
  }
}
