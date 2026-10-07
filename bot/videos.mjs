import { writeAtomic } from './storage.mjs';
import { recordGenerationCost } from './costs.mjs';
import { readFile, open, mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chooseSceneSetting, generateVideoScene } from './video-scenes.mjs';
import { coverPath, cachedCover, ImageFailure, ImagePending } from './images.mjs';
const exec = promisify(execFile);
const API = 'https://openrouter.ai/api/v1/videos';
export const DEFAULT_VIDEO_MODEL = 'bytedance/seedance-1-5-pro';

async function store(path, value) {
  await writeAtomic(path, value);
}
export async function convertVideo(input, output) {
  try {
    const { stdout } = await exec(
      process.env.BOT_PYTHON || 'python3',
      [fileURLToPath(new URL('./video-to-gif.py', import.meta.url)), input, output],
      { timeout: 120000, maxBuffer: 10000 },
    );
    return JSON.parse(stdout);
  } catch (error) {
    const failure = new ImageFailure('video_conversion_failed');
    failure.message += `: ${String(error.stderr || error.message).slice(0, 3000)}`;
    throw failure;
  }
}
export async function generateVideoCover(
  config,
  entry,
  {
    fetchImpl = fetch,
    convert = convertVideo,
    now = Date.now(),
    pickSetting = chooseSceneSetting,
  } = {},
) {
  const cached = await cachedCover(config, entry.postId);
  if (cached) return cached;
  if (!config.openrouterKey || !config.coverPrompt)
    throw new ImageFailure('missing_video_configuration');
  const path = coverPath(config, entry.postId);
  await mkdir(dirname(path), { recursive: true });
  const receiptPath = `${path}.video.json`;
  let job;
  try {
    job = JSON.parse(await readFile(receiptPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new ImageFailure('invalid_video_receipt');
  }
  const headers = { Authorization: `Bearer ${config.openrouterKey}` };
  async function api(url, init = {}) {
    try {
      const response = await fetchImpl(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        headers: { ...headers, ...init.headers },
      });
      const body = await response.json();
      if (!response.ok || (body.error && !['failed', 'cancelled', 'expired'].includes(body.status)))
        throw new ImageFailure('video_api_rejected', Number(body.error?.code || response.status));
      return body;
    } catch (error) {
      if (error instanceof ImageFailure) throw error;
      throw new ImageFailure('video_network_failure');
    }
  }
  if (!job) {
    const setting = pickSetting(config, config.recentVideoScenes || []);
    job = { status: 'planning', attempts: 0, setting, previousJobs: [] };
    await store(receiptPath, job);
  }
  if (job.status === 'planning') {
    try {
      Object.assign(
        job,
        await generateVideoScene(
          config,
          entry,
          job.setting,
          config.recentVideoScenes || [],
          fetchImpl,
        ),
      );
    } catch (error) {
      if (error instanceof ImageFailure) throw error;
      throw new ImageFailure('video_scene_generation_failed');
    }
    job.sceneFamily = job.setting.family;
    job.status = 'scene_ready';
    await store(receiptPath, job);
  }
  if (job.status === 'scene_ready' || job.status === 'failed') {
    const attempts = (job.attempts || 0) + 1;
    if (attempts > (config.imageMaxAttempts || 3))
      throw new ImageFailure('video_attempts_exhausted');
    const previousJobs =
      job.status === 'failed'
        ? [
            ...(job.previousJobs || []),
            { id: job.id || null, cost: job.cost || null, reason: job.reason },
          ]
        : job.previousJobs || [];
    const scene = job?.scene;
    if (!scene) throw new ImageFailure('invalid_video_receipt');
    const sceneDescription = job.sceneLocation ? `Location: ${job.sceneLocation}. ${scene}` : scene;
    const direction = config.videoPrompt || config.coverPrompt;
    const prompt = direction.includes('[SCENE]')
      ? direction.replace('[SCENE]', sceneDescription)
      : `${direction}\nSCENE: ${sceneDescription}`;
    if ((config.videoModel || DEFAULT_VIDEO_MODEL) === DEFAULT_VIDEO_MODEL && prompt.length > 2000)
      throw new ImageFailure('video_prompt_too_long');
    job = {
      ...job,
      attempts,
      previousJobs,
      status: 'submitting',
      startedAt: now,
      model: config.videoModel || DEFAULT_VIDEO_MODEL,
      scene,
      prompt,
    };
    // If the POST response is lost, never submit a second paid generation.
    await store(receiptPath, job);
    try {
      const created = await api(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: job.model,
          prompt,
          duration: 4,
          resolution: '480p',
          aspect_ratio: '16:9',
          generate_audio: false,
        }),
      });
      if (!/^[A-Za-z0-9_-]+$/.test(created.id || '')) throw new ImageFailure('invalid_video_job');
      job.id = created.id;
      await recordGenerationCost(config, {
        id: job.id,
        kind: 'video',
        model: job.model,
        usd: created.usage?.cost,
        postId: entry.postId,
        outcome: 'pending',
        occurredAt: new Date(job.startedAt).toISOString(),
      });
      job.status = 'pending';
      await store(receiptPath, job);
    } catch (error) {
      const rejected =
        error.reason === 'video_api_rejected' &&
        error.code >= 400 &&
        error.code < 500 &&
        error.code !== 408;
      if (!rejected)
        await recordGenerationCost(config, {
          id: `submission-${entry.postId}-${job.attempts}`,
          kind: 'video',
          model: job.model,
          usd: null,
          postId: entry.postId,
          outcome: 'submission_uncertain',
          occurredAt: new Date(job.startedAt).toISOString(),
        });
      job.status = rejected ? 'failed' : 'uncertain';
      job.reason = error.reason;
      await store(receiptPath, job);
      if (rejected) throw error;
      throw new ImageFailure('video_submission_uncertain');
    }
    throw new ImagePending();
  }
  if (!job.id || ['uncertain', 'submitting'].includes(job.status))
    throw new ImageFailure('video_submission_uncertain');
  if (!/^[A-Za-z0-9_-]+$/.test(job.id) || !Number.isFinite(job.startedAt))
    throw new ImageFailure('invalid_video_receipt');
  if (now - job.startedAt > 15 * 60000) throw new ImageFailure('video_generation_timeout');
  let result;
  try {
    result = await api(`${API}/${job.id}`);
  } catch (error) {
    if (error.reason === 'video_network_failure' || [429, 500, 502, 503, 504].includes(error.code))
      throw new ImageFailure('video_poll_failed', error.code);
    throw error;
  }
  if (!['pending', 'in_progress', 'queued', 'processing'].includes(result.status))
    await recordGenerationCost(config, {
      id: job.id,
      kind: 'video',
      model: job.model,
      usd: result.usage?.cost,
      postId: entry.postId,
      outcome: result.status,
      occurredAt: new Date(job.startedAt).toISOString(),
    });
  if (['pending', 'in_progress', 'queued', 'processing'].includes(result.status))
    throw new ImagePending();
  if (result.status !== 'completed') {
    if (['failed', 'cancelled', 'expired'].includes(result.status)) {
      job.status = 'failed';
      job.reason = 'video_generation_failed';
      job.cost = typeof result.usage?.cost === 'number' ? result.usage.cost : null;
      await store(receiptPath, job);
    }
    const failure = new ImageFailure('video_generation_failed');
    const detail = typeof result.error === 'string' ? result.error : result.error?.message;
    if (detail) failure.message += `: ${String(detail).slice(0, 3000)}`;
    throw failure;
  }
  const raw = `${path}.mp4.tmp`;
  const output = `${path}.${randomUUID()}.tmp`;
  try {
    // Build the trusted endpoint ourselves; never forward credentials to returned URLs.
    const response = await fetchImpl(`${API}/${job.id}/content?index=0`, {
      redirect: 'error',
      signal: AbortSignal.timeout(60000),
      headers,
    });
    if (!response.ok || Number(response.headers?.get('content-length')) > 30_000_000)
      throw new ImageFailure('video_download_failed');
    let length = 0;
    const file = await open(raw, 'w', 0o600);
    try {
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 30_000_000) throw new ImageFailure('video_too_large');
        await file.writeFile(chunk);
      }
    } finally {
      await file.close();
    }
    const metadata = await convert(raw, output);
    await rename(output, path);
    job.status = 'completed';
    job.cost = typeof result.usage?.cost === 'number' ? result.usage.cost : null;
    job.gif = metadata;
    await store(receiptPath, job);
    return {
      ...(await cachedCover(config, entry.postId)),
      ...metadata,
      model: job.model,
      cost: job.cost,
      scene: job.scene,
      sceneLocation: job.sceneLocation,
      sceneFamily: job.sceneFamily,
    };
  } catch (error) {
    if (error instanceof ImageFailure) throw error;
    throw new ImageFailure('video_download_or_conversion_failed');
  } finally {
    await Promise.all([rm(raw, { force: true }), rm(output, { force: true })]);
  }
}
