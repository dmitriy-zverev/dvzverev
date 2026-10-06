import { resolve, dirname } from 'node:path';
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

export async function runtimeConfigForProject(service, projectId, env, { configRoot }) {
  const project = service.projects[projectId];
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  if (!project.enabled) throw new Error(`Project is disabled: ${projectId}`);

  const telegram = destinationByPlatform(project, service, 'telegram');
  const vk = destinationByPlatform(project, service, 'vk');
  const generation = resolveProvider(service, project.generation.provider, env);
  const editorPrompt = await readPromptFile(configRoot, project.prompts.editor);
  const coverPrompt = project.prompts.cover
    ? await readPromptFile(configRoot, project.prompts.cover)
    : '';
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
  const telegramMedia = telegram?.destination.media?.enabled === true;
  const vkMedia = vk?.destination.media?.enabled === true;

  return {
    projectId,
    deliveryPolicy: project.delivery.policy || 'ordered-independent',
    destinationIds: [...project.delivery.destinations],
    telegramEnabled: Boolean(telegram),
    token,
    chatId,
    alertChatId,
    vkToken,
    vkGroupId,
    vkPhotosToken: '',
    imagesEnabled: telegramMedia,
    mediaTimes: vk?.destination.media?.times || telegram?.destination.media?.times || null,
    coverMode: vk?.destination.media?.kind || telegram?.destination.media?.kind || 'image',
    coverPrompt,
    videoPrompt: vk?.destination.media?.prompt
      ? await readPromptFile(configRoot, vk.destination.media.prompt)
      : '',
    imageMaxAttempts:
      vk?.destination.media?.maxAttempts || telegram?.destination.media?.maxAttempts || 1,
    videoModel: vk?.destination.media?.model || 'bytedance/seedance-1-5-pro',
    vkImagesEnabled: vkMedia,
    imageModel: env.OPENROUTER_IMAGE_MODEL || DEFAULT_IMAGE_MODEL,
    vkEnabled: Boolean(vk),
    vkConfigError: Boolean(vk) && (!vkToken || !/^[1-9]\d*$/.test(vkGroupId)),
    maxAttempts: 3,
    postSource,
    contentMode: project.format,
    openrouterKey: generation.apiKey,
    openrouterModel: generation.model,
    openrouterModels: generation.models,
    reviewModel: project.generation.reviewModel || generation.models[1] || generation.model,
    openrouterPrompt: editorPrompt.trim() || DEFAULT_PROMPT,
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
