import { readdir, stat, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readState } from './core.mjs';
import { coverPath } from './images.mjs';

const lastRun = new Map();
export async function maintainMedia(config, now = Date.now()) {
  if (now - (lastRun.get(config.statePath) || 0) < 3600000) return;
  lastRun.set(config.statePath, now);
  const state = await readState(config);
  for (const entry of state.entries) {
    if (
      entry.status !== 'sent' ||
      !entry.image ||
      !Number.isFinite(Date.parse(entry.sentAt || entry.createdAt)) ||
      Date.parse(entry.sentAt || entry.createdAt) >= now - 30 * 86400000
    )
      continue;
    const path = coverPath(config, entry.postId);
    await rm(path, { force: true });
    await rm(`${path}.video.json`, { force: true });
  }
  const directory = join(dirname(config.statePath), 'images');
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    names = [];
  }
  for (const name of names.filter((name) => name.endsWith('.tmp') || name.endsWith('.raw'))) {
    const path = join(directory, name);
    const info = await stat(path);
    if (info.isFile() && info.mtimeMs < now - 86400000) await rm(path, { force: true });
  }
  lastRun.set(config.statePath, now);
}
