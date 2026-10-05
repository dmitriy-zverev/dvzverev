import { configFromEnv } from './core.mjs';
import { dualConfigWarnings } from './config/legacy.mjs';
import { loadServiceDocument, listDestinations, listProjects } from './config/load.mjs';
import { runtimeConfigForProject } from './config/runtime.mjs';
import { validateServiceDocument } from './config/validate.mjs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveConfigPath, resolveRelativeConfigPath } from './config/paths.mjs';
import { readOptionalEnvValue } from './config/env.mjs';

export function failureAlertConfig(app, projectId, env = process.env) {
  if (app.mode !== 'multi') {
    return {
      token: env.TELEGRAM_BOT_TOKEN || '',
      chatId: env.TELEGRAM_CHAT_ID || '',
      alertChatId: env.BOT_ALERT_CHAT_ID || '',
      statePath: env.BOT_STATE_PATH || 'bot/data/state.json',
    };
  }
  const project = app.service.projects[projectId];
  const alertEnv = app.service.service?.alertChatIdEnv;
  const statePath = project?.statePath
    ? resolveRelativeConfigPath(app.configRoot, project.statePath)
    : resolve(app.configRoot, `state/${projectId}.json`);
  return {
    projectId,
    token: env.TELEGRAM_BOT_TOKEN || '',
    chatId: '',
    alertChatId: alertEnv ? readOptionalEnvValue(env, alertEnv) : env.BOT_ALERT_CHAT_ID || '',
    statePath,
  };
}

export async function loadAppConfig(env = process.env) {
  const warnings = dualConfigWarnings(env);
  const loaded = await loadServiceDocument(null, env);
  if (!loaded) {
    return {
      mode: 'legacy',
      warnings,
      legacyConfig: configFromEnv(env),
      listProjects: () => [],
      listDestinations: () => [],
      enabledProjectIds: () => [],
      resolveProjectConfig: async () => {
        throw new Error('Multi-project config is not enabled');
      },
    };
  }
  const { document, configPath, configRoot } = loaded;
  return {
    mode: 'multi',
    warnings,
    configPath,
    configRoot,
    service: document,
    listProjects: () => listProjects(document),
    listDestinations: () => listDestinations(document),
    enabledProjectIds: () =>
      Object.entries(document.projects)
        .filter(([, project]) => project.enabled)
        .map(([id]) => id)
        .sort(),
    resolveProjectConfig: (projectId) =>
      runtimeConfigForProject(document, projectId, env, { configRoot }),
  };
}

export async function validateConfigFile(configPath, env = process.env) {
  const resolved = resolveConfigPath(configPath, env);
  if (!resolved) throw new Error('Config path is required');
  let document;
  try {
    const raw = await readFile(resolved, 'utf8');
    document = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SyntaxError(`${resolved} is not valid JSON`);
    }
    throw error;
  }
  const validation = validateServiceDocument(document, { configPath: resolved });
  return {
    configPath: resolved,
    ok: validation.ok,
    errors: validation.errors,
    projects: validation.ok ? listProjects(document) : [],
    destinations: validation.ok ? listDestinations(document) : [],
    warnings: dualConfigWarnings(env),
  };
}
