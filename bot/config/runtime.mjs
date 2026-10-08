import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { cabinetDbPath, getMeta } from '../cabinet/db.mjs';
import { rubricService } from '../cabinet/rubrics.mjs';
import { DEFAULT_MODEL, DEFAULT_PROMPT } from '../openrouter.mjs';
import { DEFAULT_IMAGE_MODEL } from '../images.mjs';
import { readEnvValue, readOptionalEnvValue } from './env.mjs';
import { readPromptFile, resolveRelativeConfigPath } from './paths.mjs';

function destinationByPlatform(project, service, platform) {
  for (const destinationId of project.delivery.destinations) {
    const destination = service.destinations[destinationId];
    if (destination?.platform === platform) return { destinationId, destination };
  }
  return null;
}

function resolveProvider(service, providerId, env) {
  const provider = service.providers[providerId];
  const model =
    provider.model || (provider.modelEnv ? readEnvValue(env, provider.modelEnv) : DEFAULT_MODEL);
  return {
    providerId,
    adapter: provider.adapter,
    model,
    models: [model, ...(provider.fallbackModels || [])],
    apiKey: readEnvValue(env, provider.credentialEnv),
    baseUrl: provider.baseUrlEnv ? readEnvValue(env, provider.baseUrlEnv) : '',
  };
}

function activePrompts(projectId, env) {
  const path = cabinetDbPath(env);
  if (env.BOT_CABINET_ENABLED !== 'true' || !existsSync(path)) return {};
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.fromEntries(
      db
        .prepare(
          `SELECT role, version_id, content_hash, content_text FROM prompt_versions
       WHERE project_id = ? AND status = 'active' AND role IN ('editor', 'cover', 'video')`,
        )
        .all(projectId)
        .map((row) => [row.role, row]),
    );
  } finally {
    db.close();
  }
}

export async function runtimeConfigForProject(service, projectId, env, { configRoot }) {
  let rubricsManaged = false;
  if (env.BOT_CABINET_ENABLED === 'true' && existsSync(cabinetDbPath(env))) {
    const db = new DatabaseSync(cabinetDbPath(env), { readOnly: true });
    try {
      rubricsManaged = Boolean(getMeta(db, `rubrics_managed:${projectId}`));
      if (rubricsManaged) service = rubricService(db, service);
    } finally {
      db.close();
    }
  }
  const project = service.projects[projectId];
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  if (!project.enabled) throw new Error(`Project is disabled: ${projectId}`);

  const telegram = destinationByPlatform(project, service, 'telegram');
  const vk = destinationByPlatform(project, service, 'vk');
  const generation = resolveProvider(service, project.generation.provider, env);
  const prompts = activePrompts(projectId, env);
  const editorPrompt = await readPromptFile(configRoot, project.prompts.editor);
  const coverPrompt = project.prompts.cover
    ? await readPromptFile(configRoot, project.prompts.cover)
    : await readFile(new URL('../prompts/cover.md', import.meta.url), 'utf8');
  const postSource = project.postSource || 'openrouter';
  const queuePath = project.queuePath
    ? resolveRelativeConfigPath(configRoot, project.queuePath)
    : resolve(configRoot, `queues/${projectId}.json`);
  const statePath = project.statePath
    ? resolveRelativeConfigPath(configRoot, project.statePath)
    : resolve(configRoot, `state/${projectId}.json`);
  const alertChatId = service.service?.alertChatIdEnv
    ? readOptionalEnvValue(env, service.service.alertChatIdEnv)
    : env.BOT_ALERT_CHAT_ID || '';

  const token = telegram
    ? readEnvValue(env, telegram.destination.credentialEnv)
    : env.TELEGRAM_BOT_TOKEN || '';
  const chatId = telegram ? readEnvValue(env, telegram.destination.chatIdEnv) : '';
  const vkToken = vk ? readEnvValue(env, vk.destination.credentialEnv) : '';
  const vkGroupId = vk ? readEnvValue(env, vk.destination.groupIdEnv) : '';
  const vkAlbumId = vk?.destination.albumIdEnv
    ? readOptionalEnvValue(env, vk.destination.albumIdEnv) || ''
    : '';
  const telegramMedia = telegram?.destination.media?.enabled === true;
  const vkMedia = vk?.destination.media?.enabled === true;

  return {
    projectId,
    rubricsManaged,
    cabinetDbPath: cabinetDbPath(env),
    deliveryPolicy: project.delivery.policy || 'ordered-independent',
    destinationIds: [...project.delivery.destinations],
    telegramEnabled: Boolean(telegram),
    token,
    chatId,
    alertChatId,
    vkToken,
    vkGroupId,
    vkAlbumId,
    vkPhotosToken: vk?.destination.media?.photosCredentialEnv
      ? env[vk.destination.media.photosCredentialEnv] || ''
      : '',
    staticPhoto: vk?.destination.media?.uploadMode === 'photo',
    weeklyImages: vk?.destination.media?.scheduling === 'vk-weekly',
    imagesEnabled: telegramMedia,
    mediaTimes: vk?.destination.media?.times || telegram?.destination.media?.times || null,
    coverMode: vk?.destination.media?.kind || telegram?.destination.media?.kind || 'image',
    coverPrompt: prompts.cover?.content_text ?? coverPrompt,
    videoPrompt:
      prompts.video?.content_text ??
      (vk?.destination.media?.prompt
        ? await readPromptFile(configRoot, vk.destination.media.prompt)
        : ''),
    imageMaxAttempts:
      vk?.destination.media?.maxAttempts || telegram?.destination.media?.maxAttempts || 1,
    videoModel:
      (vk?.destination.media?.kind === 'video' && vk.destination.media.model) ||
      env.OPENROUTER_VIDEO_MODEL ||
      'bytedance/seedance-1-5-pro',
    vkImagesEnabled: vkMedia,
    imageModel:
      (vk?.destination.media?.kind === 'image' && vk.destination.media.model) ||
      env.OPENROUTER_IMAGE_MODEL ||
      DEFAULT_IMAGE_MODEL,
    vkEnabled: Boolean(vk),
    vkConfigError: Boolean(vk) && (!vkToken || !/^[1-9]\d*$/.test(vkGroupId)),
    maxAttempts: 3,
    postSource,
    contentMode: project.format,
    openrouterKey: generation.apiKey,
    openrouterModel: generation.model,
    openrouterModels: generation.models,
    reviewModel: project.generation.reviewModel || generation.models[1] || generation.model,
    openrouterPrompt: prompts.editor?.content_text ?? (editorPrompt.trim() || DEFAULT_PROMPT),
    promptVersions: Object.fromEntries(
      Object.entries(prompts).map(([role, row]) => [
        role,
        {
          versionId: row.version_id,
          contentHash: row.content_hash,
        },
      ]),
    ),
    times: [...new Set(project.schedule.times)].sort(),
    timezone: project.schedule.timezone,
    weekly: project.schedule.weekly || null,
    queuePath,
    statePath,
    metricsEnabled: project.metrics?.enabled === true,
    metricsIntervalMinutes: project.metrics?.intervalMinutes || 60,
    metricsPath: resolve(dirname(statePath), 'analytics.json'),
    costLedgerPath:
      project.metrics?.enabled === true
        ? resolve(dirname(statePath), 'generation-costs.jsonl')
        : null,
    budget: project.budget || null,
    generationProvider: generation.providerId,
  };
}
