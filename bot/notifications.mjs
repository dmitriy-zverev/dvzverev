import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { acquireLock } from './lock.mjs';
import { writeAtomic } from './storage.mjs';

// All projects using the same Telegram bot share its notification rate limit.
export async function sendNotification(config, notify, message, delayForError) {
  const root = config.logDir || process.env.BOT_LOG_DIR || dirname(config.statePath);
  const key = createHash('sha256')
    .update(config.token || '')
    .digest('hex')
    .slice(0, 20);
  const path = join(root, `telegram-${key}.json`);
  await mkdir(root, { recursive: true });
  const release = await acquireLock(`${path}.lock`);
  if (!release) return { deferredUntil: Date.now() + 1000 };
  try {
    let gate;
    try {
      gate = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (gate && !Number.isFinite(gate.until)) throw new Error('Invalid notification cooldown');
    if (gate?.until > Date.now()) return { deferredUntil: gate.until };
    try {
      await notify({ ...config, chatId: config.alertChatId }, message);
      return { sent: true };
    } catch (error) {
      if (error.kind === 'temporary')
        await writeAtomic(path, { until: Date.now() + delayForError(error) * 1000 });
      throw error;
    }
  } finally {
    await release();
  }
}
