import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireLock } from './lock.mjs';

export function configFromEnv(env = process.env) {
  const times = (env.BOT_TIMES || '10:00').split(',').map((time) => time.trim());
  if (times.some((time) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) {
    throw new Error('BOT_TIMES must contain HH:mm times separated by commas');
  }
  const timezone = env.BOT_TIMEZONE || 'Europe/Moscow';
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  return {
    token: env.TELEGRAM_BOT_TOKEN || '',
    chatId: env.TELEGRAM_CHAT_ID || '',
    alertChatId: env.BOT_ALERT_CHAT_ID || '',
    maxAttempts: 3,
    times: [...new Set(times)].sort(),
    timezone,
    queuePath: resolve(env.BOT_QUEUE_PATH || 'bot/content/posts.json'),
    statePath: resolve(env.BOT_STATE_PATH || 'bot/data/state.json'),
  };
}

const escapeHtml = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

export function formatPost(post) {
  for (const field of ['id', 'title', 'summary', 'why', 'url']) {
    if (typeof post?.[field] !== 'string' || !post[field].trim()) {
      throw new Error(`Post requires a nonempty ${field}`);
    }
  }
  const url = new URL(post.url);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Post URL must be HTTPS without credentials');
  }
  if (post.action !== undefined && typeof post.action !== 'string') {
    throw new Error('Post action must be a string');
  }
  const blocks = [
    '📚 <b>Что почитать вайбкодерам</b>',
    `<b>${escapeHtml(post.title)}</b>`,
    escapeHtml(post.summary),
    `<b>Зачем читать:</b> ${escapeHtml(post.why)}`,
  ];
  if (post.action?.trim()) blocks.push(`<b>Что попробовать:</b> ${escapeHtml(post.action)}`);
  blocks.push(`<a href="${escapeHtml(url.href)}">Читать оригинал ↗</a>`);
  const html = blocks.join('\n\n');
  // Count visible text in UTF-16 units, conservatively including surrogate pairs.
  const visible = [
    '📚 Что почитать вайбкодерам',
    post.title,
    post.summary,
    `Зачем читать: ${post.why}`,
    ...(post.action?.trim() ? [`Что попробовать: ${post.action}`] : []),
    'Читать оригинал ↗',
  ].join('\n\n');
  if (visible.length > 4096)
    throw new Error(`Post ${post.id} exceeds Telegram's 4096-character limit`);
  return html;
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
      .filter((entry) =>
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
    return { version: 1, chatId: config.chatId, entries: [] };
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

async function alert(config, state, event, notify) {
  if (!config.alertChatId || event.alertStatus) return;
  // Save before notification I/O to avoid repeated alerts on lost responses/restarts.
  event.alertStatus = 'sending';
  await saveState(config, state);
  const message =
    `<b>Сбой Telegram-постера</b>\nКанал: ${escapeHtml(config.chatId)}\n` +
    `Статус: ${escapeHtml(event.status || 'paused')}\n` +
    `Причина: ${escapeHtml(event.reason || 'delivery_failure')}\n` +
    `Пост: ${escapeHtml(String(event.postId || '—').slice(0, 120))}\n` +
    `Код: ${event.errorCode || '—'}; попыток: ${event.attempts || 0}`;
  try {
    await notify({ ...config, chatId: config.alertChatId }, message);
    event.alertStatus = 'sent';
  } catch {
    event.alertStatus = 'failed';
    console.error('Owner notification failed; inspect bot state. No automatic notification retry.');
  }
  await saveState(config, state);
}

export async function publish(
  config,
  {
    now = new Date(),
    manual = false,
    provider = nextQueuedPost,
    send = sendTelegram,
    notify = sendTelegram,
  } = {},
) {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(config.token) || !config.chatId.trim()) {
    throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in bot/.env');
  }
  await mkdir(dirname(config.statePath), { recursive: true });
  const release = await acquireLock(`${config.statePath}.lock`);
  if (!release) return { status: 'locked' };
  try {
    const state = await readState(config);
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
    if (state.paused) {
      await alert(config, state, state.paused, notify);
      return { status: 'paused', reason: state.paused.reason };
    }
    let entry = state.entries.find((entry) => entry.status === 'retry_wait');
    if (entry && Date.parse(entry.retryAt) > now.getTime())
      return { status: 'retry_wait', retryAt: entry.retryAt };
    if (!entry) {
      const slot = manual ? `manual:${randomUUID()}` : dueSlot(config, now);
      if (!slot) return { status: 'not_due' };
      if (state.entries.some((entry) => entry.slot === slot))
        return { status: 'already_processed' };
      let post;
      try {
        post = await provider(config, state.entries);
      } catch {
        state.paused = { reason: 'invalid_queue', since: now.toISOString() };
        await saveState(config, state);
        await alert(config, state, state.paused, notify);
        return { status: 'paused', reason: 'invalid_queue' };
      }
      entry = {
        slot,
        status: post ? 'sending' : 'empty',
        createdAt: now.toISOString(),
        attempts: 0,
      };
      if (post) {
        entry.postId = post.id;
        try {
          entry.html = formatPost(post);
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
    entry.status = 'sending';
    entry.attempts = (entry.attempts || 0) + 1;
    delete entry.retryAt;
    await saveState(config, state);
    const started = Date.now();
    try {
      entry.messageId = await send(config, entry.html);
      entry.status = 'sent';
      entry.sentAt = new Date().toISOString();
    } catch (error) {
      entry.errorCode = error instanceof TelegramRejection ? error.code : null;
      if (!(error instanceof TelegramRejection)) {
        entry.status = 'uncertain';
        entry.reason = 'unconfirmed_delivery';
      } else if (error.kind === 'configuration') {
        entry.status = 'failed';
        entry.reason = 'token_or_permissions';
        entry.alertStatus = 'covered_by_pause';
        state.paused = { reason: entry.reason, errorCode: error.code, since: now.toISOString() };
      } else if (error.kind === 'temporary') {
        entry.reason = error.code === 429 ? 'rate_limit' : 'telegram_unavailable';
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
      } else {
        entry.status = 'failed';
        entry.reason = 'telegram_rejected_post';
      }
    }
    await saveState(config, state);
    if (state.paused) await alert(config, state, state.paused, notify);
    else if (['uncertain', 'failed', 'exhausted'].includes(entry.status))
      await alert(config, state, entry, notify);
    return {
      status: entry.status,
      postId: entry.postId,
      messageId: entry.messageId,
      errorCode: entry.errorCode,
      reason: entry.reason,
      attempts: entry.attempts,
      retryAt: entry.retryAt,
    };
  } finally {
    await release();
  }
}

export async function resume(config) {
  await mkdir(dirname(config.statePath), { recursive: true });
  const release = await acquireLock(`${config.statePath}.lock`);
  if (!release) return { status: 'locked' };
  try {
    const state = await readState(config);
    for (const entry of state.entries.filter(
      (entry) => entry.status === 'failed' && entry.reason === 'token_or_permissions',
    )) {
      entry.status = 'rejected';
    }
    delete state.paused;
    await saveState(config, state);
    return { status: 'resumed' };
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
    const entries = state.entries.filter((entry) => entry.postId === postId);
    if (!entries.length || entries.some((entry) => entry.status === 'sent')) {
      throw new Error('Unknown or already sent post');
    }
    for (const entry of entries) {
      if (!['sending', 'uncertain', 'failed', 'exhausted'].includes(entry.status)) {
        throw new Error('Post is not waiting for operator review');
      }
      entry.status = messageId === null ? 'rejected' : 'sent';
      entry.resolvedAt = new Date().toISOString();
      if (messageId !== null) entry.messageId = messageId;
    }
    await saveState(config, state);
    return { status: messageId === null ? 'retry_enabled' : 'marked_sent', postId, messageId };
  } finally {
    await release();
  }
}
