import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAtomic } from './storage.mjs';

export function heartbeatPath(env = process.env) {
  return resolve(env.BOT_HEARTBEAT_PATH || '/app/data/heartbeat.json');
}

/** Freshness from shared heartbeat.json (no PID check — use in cabinet API). */
export function schedulerHeartbeatStatus(raw, now = Date.now()) {
  if (
    !Number.isFinite(raw?.updatedAt) ||
    now - raw.updatedAt > 600000 ||
    raw.updatedAt > now + 60000
  ) {
    return { ok: false, updatedAt: null, ageSeconds: null };
  }
  const ageSeconds = Math.round((now - raw.updatedAt) / 1000);
  return {
    ok: ageSeconds <= 600,
    updatedAt: new Date(raw.updatedAt).toISOString(),
    ageSeconds,
  };
}

export async function heartbeat(env = process.env) {
  const path = heartbeatPath(env);
  await mkdir(dirname(path), { recursive: true });
  await writeAtomic(path, { pid: process.pid, updatedAt: Date.now() });
}
export async function checkHealth(env = process.env, now = Date.now()) {
  const state = JSON.parse(await readFile(heartbeatPath(env), 'utf8'));
  const status = schedulerHeartbeatStatus(state, now);
  if (!status.ok) throw new Error('Scheduler heartbeat is stale');
  if (!Number.isInteger(state.pid)) throw new Error('Scheduler heartbeat is stale');
  process.kill(state.pid, 0);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await checkHealth();
  } catch {
    process.exitCode = 1;
  }
}
