import { openCabinetDb } from './db.mjs';
import { loadServiceForCabinet, refreshServiceSnapshot } from './projects.mjs';
import { cabinetTick } from './sync.mjs';

let syncQueue = Promise.resolve();

export function cabinetEnabled(env = process.env) {
  return env.BOT_CABINET_ENABLED === 'true';
}

export function queueCabinetSync(env = process.env) {
  if (!cabinetEnabled(env)) return syncQueue;
  syncQueue = syncQueue
    .then(() => runCabinetSync(env))
    .catch((error) => {
      console.error(`Cabinet sync failed: ${error.message}`);
    });
  return syncQueue;
}

export async function runCabinetSync(env = process.env) {
  const db = openCabinetDb(env);
  try {
    const { document } = await loadServiceForCabinet(env);
    refreshServiceSnapshot(db, document);
    await cabinetTick(db, document, env);
  } finally {
    db.close();
  }
}
