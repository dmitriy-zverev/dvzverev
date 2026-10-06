import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAtomic } from './storage.mjs';

export function heartbeatPath(env = process.env) {
  return resolve(env.BOT_HEARTBEAT_PATH || '/app/data/heartbeat.json');
}
export async function heartbeat(env = process.env) {
  const path = heartbeatPath(env);
  await mkdir(dirname(path), { recursive: true });
  await writeAtomic(path, { pid: process.pid, updatedAt: Date.now() });
}
export async function checkHealth(env = process.env, now = Date.now()) {
  const state = JSON.parse(await readFile(heartbeatPath(env), 'utf8'));
  if (
    !Number.isInteger(state.pid) ||
    !Number.isFinite(state.updatedAt) ||
    now - state.updatedAt > 600000 ||
    state.updatedAt > now + 60000
  )
    throw new Error('Scheduler heartbeat is stale');
  process.kill(state.pid, 0);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await checkHealth();
  } catch {
    process.exitCode = 1;
  }
}
