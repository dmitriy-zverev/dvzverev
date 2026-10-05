import { readFile } from 'node:fs/promises';
import { resolveConfigPath } from './paths.mjs';
import { validateServiceDocument } from './validate.mjs';

export async function loadServiceDocument(configPath, env = process.env) {
  const resolved = resolveConfigPath(configPath, env);
  if (!resolved) return null;
  const raw = await readFile(resolved, 'utf8');
  const document = JSON.parse(raw);
  const validation = validateServiceDocument(document, { configPath: resolved });
  if (!validation.ok) {
    const details = validation.errors.map((error) => `${error.path}: ${error.message}`).join('; ');
    throw new Error(`Invalid service config: ${details}`);
  }
  return { document, configPath: resolved, configRoot: validation.configRoot };
}

export function listProjects(service) {
  return Object.entries(service.projects).map(([id, project]) => ({
    id,
    enabled: project.enabled,
    format: project.format,
    postSource: project.postSource || 'openrouter',
    timezone: project.schedule.timezone,
    times: project.schedule.times,
    destinations: project.delivery.destinations,
    deliveryPolicy: project.delivery.policy || 'ordered-independent',
  }));
}

export function listDestinations(service) {
  return Object.entries(service.destinations).map(([id, destination]) => ({
    id,
    platform: destination.platform,
    media: destination.media?.enabled === true,
  }));
}
