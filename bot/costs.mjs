import { mkdir, open, readFile, writeFile, access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function initializeCosts(config, now = new Date()) {
  if (!config.costLedgerPath) return;
  await mkdir(dirname(config.costLedgerPath), { recursive: true });
  try {
    await writeFile(
      `${config.costLedgerPath}.meta.json`,
      JSON.stringify({ version: 1, trackingStartedAt: now.toISOString() }) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

export async function recordGenerationCost(
  config,
  {
    id,
    kind = 'text',
    model,
    usd,
    postId = config.generationPostId || null,
    outcome = 'completed',
    occurredAt = new Date().toISOString(),
  } = {},
) {
  if (!config.costLedgerPath) return;
  try {
    await initializeCosts(config);
    const event = {
      version: 1,
      id: `${kind}:${id || randomUUID()}`,
      projectId: config.projectId || null,
      postId,
      kind,
      model: model || config.openrouterModel || null,
      usd: typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? usd : null,
      outcome,
      occurredAt,
    };
    const file = await open(config.costLedgerPath, 'a', 0o600);
    try {
      await file.writeFile(JSON.stringify(event) + '\n');
      await file.datasync();
    } finally {
      await file.close();
    }
  } catch (error) {
    console.error('Generation cost could not be recorded; financial totals are incomplete.');
    const { reportRuntimeFailure } = await import('./core.mjs');
    await reportRuntimeFailure(
      { ...config, statePath: config.costLedgerPath },
      undefined,
      {
        reason: 'generation_cost_recording_failed',
        platform: 'vk',
        status: 'failed',
        postingContinues: true,
      },
      error,
    );
  }
}

export async function readGenerationCosts(config) {
  if (!config.costLedgerPath)
    return { events: [], trackingStartedAt: null, recordingFailure: false };
  let meta = null;
  let raw = '';
  try {
    meta = JSON.parse(await readFile(`${config.costLedgerPath}.meta.json`, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Invalid cost metadata', { cause: error });
  }
  try {
    raw = await readFile(config.costLedgerPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const events = new Map();
  for (const line of raw.split('\n').filter(Boolean)) {
    const event = JSON.parse(line);
    if (
      typeof event.id !== 'string' ||
      !Number.isFinite(Date.parse(event.occurredAt)) ||
      (event.usd !== null &&
        (typeof event.usd !== 'number' || !Number.isFinite(event.usd) || event.usd < 0))
    )
      throw new Error('Invalid cost ledger');
    events.set(event.id, event);
  }
  let recordingFailure = false;
  try {
    await access(`${config.costLedgerPath}.errors.json`);
    recordingFailure = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return {
    events: [...events.values()],
    trackingStartedAt: meta?.trackingStartedAt || null,
    recordingFailure,
  };
}
