import { dirname } from 'node:path';
import { isEntityId } from './ids.mjs';
import { assertNoInlineSecrets, isEnvVarName } from './env.mjs';
import { assertRelativePathInsideConfigRoot } from './paths.mjs';
import { scheduleConflicts, validateTimezone } from './schedule.mjs';

const PROVIDER_ADAPTERS = new Set(['openrouter']);
const PLATFORMS = new Set(['telegram', 'vk']);
const FORMATS = new Set(['tip', 'digest', 'literary', 'programming', 'lifestyle']);
const POST_SOURCES = new Set(['queue', 'openrouter']);
const DELIVERY_POLICIES = new Set(['ordered-independent']);
const MISSED_SLOTS = new Set(['skip']);

function push(errors, path, message) {
  errors.push({ path, message });
}

function requireObject(errors, value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    push(errors, path, 'must be an object');
    return false;
  }
  return true;
}

function requireEntityMap(errors, value, path) {
  if (!requireObject(errors, value, path)) return;
  for (const [id, nested] of Object.entries(value)) {
    if (!isEntityId(id)) push(errors, `${path}.${id}`, 'invalid id');
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
      push(errors, `${path}.${id}`, 'must be an object');
    }
  }
}

function validateEnvRef(errors, value, path) {
  if (!value || typeof value !== 'string') {
    push(errors, path, 'env reference is required');
    return;
  }
  if (!isEnvVarName(value)) push(errors, path, 'invalid environment variable name');
}

function validateProvider(errors, provider, path) {
  if (!PROVIDER_ADAPTERS.has(provider.adapter)) {
    push(errors, `${path}.adapter`, 'unsupported adapter');
  }
  if (
    provider.fallbackModels !== undefined &&
    (!Array.isArray(provider.fallbackModels) ||
      provider.fallbackModels.length > 2 ||
      provider.fallbackModels.some((model) => typeof model !== 'string' || !model.trim()) ||
      new Set(provider.fallbackModels).size !== provider.fallbackModels.length)
  )
    push(errors, `${path}.fallbackModels`, 'must contain at most two unique model IDs');
  validateEnvRef(errors, provider.credentialEnv, `${path}.credentialEnv`);
  if (provider.modelEnv) validateEnvRef(errors, provider.modelEnv, `${path}.modelEnv`);
  if (provider.baseUrlEnv) validateEnvRef(errors, provider.baseUrlEnv, `${path}.baseUrlEnv`);
  if (provider.adapter === 'openrouter' && !provider.model && !provider.modelEnv) {
    push(errors, path, 'openrouter provider requires model or modelEnv');
  }
  if (provider.baseUrl) {
    push(errors, `${path}.baseUrl`, 'use baseUrlEnv instead of inline baseUrl');
  }
  if (provider.adapter === 'openai-compatible') {
    if (!provider.baseUrlEnv) {
      push(errors, path, 'openai-compatible provider requires baseUrlEnv');
    }
    if (!provider.model && !provider.modelEnv) {
      push(errors, path, 'openai-compatible provider requires model or modelEnv');
    }
  }
}

function validateDestination(errors, destination, path) {
  if (!PLATFORMS.has(destination.platform)) {
    push(errors, `${path}.platform`, 'unsupported platform');
  }
  validateEnvRef(errors, destination.credentialEnv, `${path}.credentialEnv`);
  if (destination.platform === 'telegram') {
    validateEnvRef(errors, destination.chatIdEnv, `${path}.chatIdEnv`);
  }
  if (destination.platform === 'vk') {
    validateEnvRef(errors, destination.groupIdEnv, `${path}.groupIdEnv`);
    if (destination.albumIdEnv) validateEnvRef(errors, destination.albumIdEnv, `${path}.albumIdEnv`);
  }
  if (destination.media !== undefined) {
    if (!requireObject(errors, destination.media, `${path}.media`)) return;
    if (
      destination.media.uploadMode !== undefined &&
      !['photo', 'document'].includes(destination.media.uploadMode)
    )
      push(errors, `${path}.media.uploadMode`, 'must be photo or document');
    if (destination.media.uploadMode === 'photo') {
      if (destination.platform !== 'vk' || destination.media.kind !== 'image')
        push(errors, `${path}.media.uploadMode`, 'photo requires a VK image destination');
      validateEnvRef(
        errors,
        destination.media.photosCredentialEnv,
        `${path}.media.photosCredentialEnv`,
      );
    }
    if (
      destination.media.maxAttempts !== undefined &&
      (!Number.isInteger(destination.media.maxAttempts) ||
        destination.media.maxAttempts < 1 ||
        destination.media.maxAttempts > 3)
    )
      push(errors, `${path}.media.maxAttempts`, 'must be an integer between 1 and 3');
    if (
      destination.media.prompt !== undefined &&
      (typeof destination.media.prompt !== 'string' || !destination.media.prompt.trim())
    )
      push(errors, `${path}.media.prompt`, 'must be a prompt path');
    if (
      destination.media.kind !== undefined &&
      !['image', 'video'].includes(destination.media.kind)
    )
      push(errors, `${path}.media.kind`, 'must be image or video');
    if (
      destination.media.times !== undefined &&
      (!Array.isArray(destination.media.times) ||
        !destination.media.times.length ||
        destination.media.times.some(
          (time) => typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time),
        ))
    )
      push(errors, `${path}.media.times`, 'must contain valid HH:MM times');
    if (
      destination.media.model !== undefined &&
      (typeof destination.media.model !== 'string' || !destination.media.model.trim())
    )
      push(errors, `${path}.media.model`, 'must be a nonempty model');
    if (typeof destination.media.enabled !== 'boolean') {
      push(errors, `${path}.media.enabled`, 'must be boolean');
    }
  }
}

function validateBudget(errors, budget, path) {
  if (!requireObject(errors, budget, path)) return;
  for (const key of ['dailyUsd', 'monthlyUsd']) {
    if (budget[key] === undefined) continue;
    if (typeof budget[key] !== 'number' || !Number.isFinite(budget[key]) || budget[key] <= 0) {
      push(errors, `${path}.${key}`, 'must be a positive number');
    }
  }
  if (
    budget.dailyUsd !== undefined &&
    budget.monthlyUsd !== undefined &&
    budget.monthlyUsd < budget.dailyUsd
  ) {
    push(errors, path, 'monthlyUsd must be greater than or equal to dailyUsd');
  }
}

function validateProject(errors, project, path, service, configRoot) {
  if (typeof project.enabled !== 'boolean') push(errors, `${path}.enabled`, 'must be boolean');
  if (!FORMATS.has(project.format)) push(errors, `${path}.format`, 'unsupported format');
  if (typeof project.language !== 'string' || !project.language.trim()) {
    push(errors, `${path}.language`, 'language is required');
  }
  const postSource = project.postSource || 'openrouter';
  if (!POST_SOURCES.has(postSource)) push(errors, `${path}.postSource`, 'unsupported postSource');
  if (postSource === 'queue' && !project.queuePath) {
    push(errors, `${path}.queuePath`, 'queuePath is required for queue postSource');
  }
  if (project.queuePath) {
    try {
      assertRelativePathInsideConfigRoot(configRoot, project.queuePath);
    } catch (error) {
      push(errors, `${path}.queuePath`, error.message);
    }
  }
  if (project.statePath) {
    try {
      assertRelativePathInsideConfigRoot(configRoot, project.statePath);
    } catch (error) {
      push(errors, `${path}.statePath`, error.message);
    }
  }
  if (!project.generation?.provider) {
    push(errors, `${path}.generation.provider`, 'provider is required');
  } else if (!service.providers?.[project.generation.provider]) {
    push(errors, `${path}.generation.provider`, 'unknown provider');
  }
  if (project.generation?.fallbackProviders?.length)
    push(
      errors,
      `${path}.generation.fallbackProviders`,
      'provider fallback is not implemented; use fallbackModels',
    );
  if (
    project.generation?.reviewModel !== undefined &&
    (typeof project.generation.reviewModel !== 'string' || !project.generation.reviewModel.trim())
  ) {
    push(errors, `${path}.generation.reviewModel`, 'must be a nonempty model id');
  }
  if (!project.prompts?.editor) push(errors, `${path}.prompts.editor`, 'editor prompt is required');
  else {
    try {
      assertRelativePathInsideConfigRoot(configRoot, project.prompts.editor);
    } catch (error) {
      push(errors, `${path}.prompts.editor`, error.message);
    }
  }
  if (project.prompts?.cover) {
    try {
      assertRelativePathInsideConfigRoot(configRoot, project.prompts.cover);
    } catch (error) {
      push(errors, `${path}.prompts.cover`, error.message);
    }
  }
  if (!project.schedule?.timezone)
    push(errors, `${path}.schedule.timezone`, 'timezone is required');
  else {
    try {
      validateTimezone(project.schedule.timezone);
    } catch {
      push(errors, `${path}.schedule.timezone`, 'invalid timezone');
    }
  }
  if (!Array.isArray(project.schedule?.times) || project.schedule.times.length === 0) {
    push(errors, `${path}.schedule.times`, 'at least one schedule time is required');
  }
  if (project.schedule?.weekly !== undefined) {
    const weekly = project.schedule.weekly;
    if (
      !weekly ||
      typeof weekly !== 'object' ||
      Array.isArray(weekly) ||
      !Object.keys(weekly).length
    ) {
      push(errors, `${path}.schedule.weekly`, 'must map ISO weekdays to scheduled times');
    } else
      for (const [day, times] of Object.entries(weekly)) {
        if (
          !/^[1-7]$/.test(day) ||
          !Array.isArray(times) ||
          !times.length ||
          new Set(times).size !== times.length ||
          times.some((time) => !project.schedule.times?.includes(time))
        )
          push(
            errors,
            `${path}.schedule.weekly.${day}`,
            'must contain unique times from schedule.times',
          );
      }
  }
  const missedSlots = project.schedule?.missedSlots || 'skip';
  if (!MISSED_SLOTS.has(missedSlots)) {
    push(errors, `${path}.schedule.missedSlots`, 'unsupported missedSlots policy');
  }
  const policy = project.delivery?.policy || 'ordered-independent';
  if (!DELIVERY_POLICIES.has(policy)) {
    push(errors, `${path}.delivery.policy`, 'unsupported delivery policy');
  }
  const destinations = project.delivery?.destinations;
  if (!Array.isArray(destinations) || destinations.length === 0) {
    push(errors, `${path}.delivery.destinations`, 'at least one destination is required');
  } else {
    const platforms = new Set();
    for (const destinationId of destinations) {
      const destination = service.destinations?.[destinationId];
      if (destination) {
        if (platforms.has(destination.platform))
          push(
            errors,
            `${path}.delivery.destinations`,
            'only one destination per platform is supported per project',
          );
        platforms.add(destination.platform);
      }
      if (!service.destinations?.[destinationId]) {
        push(errors, `${path}.delivery.destinations`, `unknown destination: ${destinationId}`);
      }
    }
  }
  if (project.budget) validateBudget(errors, project.budget, `${path}.budget`);
  if (project.metrics !== undefined) {
    if (!project.metrics || typeof project.metrics.enabled !== 'boolean')
      push(errors, `${path}.metrics.enabled`, 'must be boolean');
    if (
      project.metrics?.intervalMinutes !== undefined &&
      (!Number.isInteger(project.metrics.intervalMinutes) ||
        project.metrics.intervalMinutes < 15 ||
        project.metrics.intervalMinutes > 1440)
    )
      push(errors, `${path}.metrics.intervalMinutes`, 'must be an integer between 15 and 1440');
  }
}

export function validateServiceDocument(document, { configPath }) {
  const errors = [];
  const configRoot = dirname(configPath);
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { ok: false, errors: [{ path: '', message: 'config must be a JSON object' }] };
  }
  if (document.version !== 1) push(errors, 'version', 'must be 1');
  try {
    assertNoInlineSecrets(document, '');
  } catch (error) {
    push(errors, '', error.message);
  }
  requireEntityMap(errors, document.providers, 'providers');
  requireEntityMap(errors, document.destinations, 'destinations');
  requireEntityMap(errors, document.projects, 'projects');
  if (!document.projects || Object.keys(document.projects).length === 0) {
    push(errors, 'projects', 'at least one project is required');
  }
  for (const [id, provider] of Object.entries(document.providers || {})) {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) continue;
    validateProvider(errors, provider, `providers.${id}`);
  }
  for (const [id, destination] of Object.entries(document.destinations || {})) {
    if (!destination || typeof destination !== 'object' || Array.isArray(destination)) continue;
    if (destination.media?.prompt) {
      try {
        assertRelativePathInsideConfigRoot(configRoot, destination.media.prompt);
      } catch (error) {
        push(errors, `destinations.${id}.media.prompt`, error.message);
      }
    }
    validateDestination(errors, destination, `destinations.${id}`);
  }
  const statePaths = new Set();
  for (const [id, project] of Object.entries(document.projects || {})) {
    if (!project || typeof project !== 'object' || Array.isArray(project)) continue;
    const statePath = project.statePath || `state/${id}.json`;
    if (statePaths.has(statePath))
      push(errors, `projects.${id}.statePath`, 'state path must be unique per project');
    statePaths.add(statePath);
    validateProject(errors, project, `projects.${id}`, document, configRoot);
  }
  if (document.service?.alertChatIdEnv) {
    validateEnvRef(errors, document.service.alertChatIdEnv, 'service.alertChatIdEnv');
  }
  const minInterval = document.service?.minDestinationIntervalMinutes ?? 0;
  if (
    minInterval !== undefined &&
    (typeof minInterval !== 'number' || !Number.isInteger(minInterval) || minInterval < 0)
  ) {
    push(errors, 'service.minDestinationIntervalMinutes', 'must be a non-negative integer');
  }
  const scheduleIssues = errors.length ? [] : scheduleConflicts(document, minInterval);
  for (const issue of scheduleIssues) {
    if (issue.kind === 'destination_interval') {
      push(
        errors,
        `destinations.${issue.destinationId}`,
        `scheduled slots on this destination are closer than ${issue.minIntervalMinutes} minutes`,
      );
    } else {
      push(errors, `projects.${issue.projectId}`, issue.kind);
    }
  }
  return { ok: errors.length === 0, errors, configRoot };
}
