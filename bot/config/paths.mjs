import { readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

export function resolveConfigPath(configPath, env = process.env) {
  const raw = configPath || env.BOT_CONFIG_PATH || '';
  if (!raw.trim()) return null;
  return resolve(raw);
}

export function assertRelativePathInsideConfigRoot(configRoot, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('Prompt path is required');
  }
  if (relativePath.includes('\0')) throw new Error('Prompt path contains invalid characters');
  const normalized = relativePath.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`Prompt path must be relative: ${relativePath}`);
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..' || segment === '' || segment === '.')) {
    throw new Error(`Prompt path must stay inside config directory: ${relativePath}`);
  }
  const resolved = resolve(configRoot, ...segments);
  const rootWithSep = configRoot.endsWith(sep) ? configRoot : `${configRoot}${sep}`;
  if (!resolved.startsWith(rootWithSep) && resolved !== configRoot) {
    throw new Error(`Prompt path escapes config directory: ${relativePath}`);
  }
  return resolved;
}

export function resolveRelativeConfigPath(configRoot, relativePath) {
  return assertRelativePathInsideConfigRoot(configRoot, relativePath);
}

export async function readPromptFile(configRoot, relativePath) {
  const resolved = assertRelativePathInsideConfigRoot(configRoot, relativePath);
  return readFile(resolved, 'utf8');
}

/** @deprecated use assertRelativePathInsideConfigRoot */
export const assertPromptInsideConfigRoot = assertRelativePathInsideConfigRoot;
