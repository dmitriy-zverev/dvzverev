import { mkdir, open, rename, stat, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquireLock } from './lock.mjs';

const MAX_BYTES = 5 * 1024 * 1024;
const ROTATIONS = 3;

export function redact(value, config = {}) {
  let text = String(value);
  const secrets = [
    config.token,
    config.vkToken,
    config.openrouterKey,
    config.vkPhotosToken,
    ...Object.entries(process.env)
      .filter(([key]) => /TOKEN|SECRET|PASSWORD|API_KEY|PROXY/i.test(key))
      .map(([, v]) => v),
  ].filter((secret) => typeof secret === 'string' && secret.length >= 4);
  for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
  return text
    .replace(/(?:Bearer\s+\S+|sk-or-v1-[\w-]+|vk[12]\.a\.[\w-]+|\d{6,}:[\w-]{20,})/gi, '[REDACTED]')
    .replace(/https?:\/\/[^\s<>"']+/g, '[URL REDACTED]')
    .slice(0, 5000);
}

export async function logError(config, event, error = null) {
  const record = {
    timestamp: new Date().toISOString(),
    level: 'error',
    id: randomUUID(),
    projectId: config.projectId || null,
  };
  for (const key of [
    'platform',
    'postId',
    'reason',
    'status',
    'model',
    'errorCode',
    'vkMethod',
    'vkSubcode',
    'attempts',
    'retryAt',
    'postingContinues',
  ]) {
    const value = event?.[key];
    if (value !== undefined)
      record[key] = typeof value === 'string' ? redact(value, config) : value;
  }
  if (error) {
    record.errorName = redact(error.name || 'Error', config);
    record.message = redact(error.message || String(error), config);
    record.stack = redact(error.stack || '', config);
  }
  const path = join(
    config.logDir ||
      process.env.BOT_LOG_DIR ||
      dirname(config.statePath || '/tmp/dvzverev-poster/state.json'),
    'errors.jsonl',
  );
  let release;
  try {
    await mkdir(dirname(path), { recursive: true });
    for (let attempt = 0; attempt < 20 && !release; attempt++) {
      release = await acquireLock(`${path}.lock`);
      if (!release) await sleep(25);
    }
    if (!release) throw new Error('Error journal is busy');
    let size = 0;
    try {
      size = (await stat(path)).size;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (size >= MAX_BYTES) {
      await rm(`${path}.${ROTATIONS}`, { force: true });
      for (let index = ROTATIONS - 1; index >= 0; index--) {
        try {
          await rename(index ? `${path}.${index}` : path, `${path}.${index + 1}`);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
    const file = await open(path, 'a', 0o600);
    try {
      await file.writeFile(JSON.stringify(record) + '\n');
      await file.datasync();
    } finally {
      await file.close();
    }
  } catch {
    // Docker's bounded stderr journal remains the fallback if the data disk fails.
    record.journalFallback = true;
  } finally {
    if (release) await release();
  }
  console.error(JSON.stringify(record));
  return record.id;
}
