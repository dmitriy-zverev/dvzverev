import { dirname } from 'node:path';
import { isEntityId } from './ids.mjs';
import { assertNoInlineSecrets, isEnvVarName } from './env.mjs';
import { assertRelativePathInsideConfigRoot } from './paths.mjs';
import { scheduleConflicts, validateTimezone } from './schedule.mjs';

const PROVIDER_ADAPTERS = new Set(['openrouter', 'openai-compatible']);
const PLATFORMS = new Set(['telegram', 'vk']);
const FORMATS = new Set(['tip', 'digest']);
const POST_SOURCES = new Set(['queue', 'openrouter']);
const DELIVERY_POLICIES = new Set(['ordered-independent', 'ordered-continue', 'ordered-strict']);
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
  }
  if (destination.media !== undefined) {
    if (!requireObject(errors, destination.media, `${path}.media`)) return;
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
  } else if (!service.providers[project.generation.provider]) {
    push(errors, `${path}.generation.provider`, 'unknown provider');
  }
  for (const fallbackId of project.generation?.fallbackProviders || []) {
    if (!service.providers[fallbackId]) {
      push(errors, `${path}.generation.fallbackProviders`, `unknown provider: ${fallbackId}`);
    }
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
  if (!project.schedule?.timezone) push(errors, `${path}.schedule.timezone`, 'timezone is required');
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
    for (const destinationId of destinations) {
      if (!service.destinations[destinationId]) {
        push(errors, `${path}.delivery.destinations`, `unknown destination: ${destinationId}`);
      }
    }
  }
  if (project.budget) validateBudget(errors, project.budget, `${path}.budget`);
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
    validateProvider(errors, provider, `providers.${id}`);
  }
  for (const [id, destination] of Object.entries(document.destinations || {})) {
    validateDestination(errors, destination, `destinations.${id}`);
  }
  for (const [id, project] of Object.entries(document.projects || {})) {
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
  const scheduleIssues = scheduleConflicts(document, minInterval);
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
