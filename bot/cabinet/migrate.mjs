import { fileURLToPath } from 'node:url';
import { openCabinetDb } from './db.mjs';
import { loadServiceForCabinet, refreshServiceSnapshot } from './projects.mjs';
import { cabinetTick } from './sync.mjs';

export async function migrateCabinet(env = process.env) {
  const db = openCabinetDb(env);
  const { document } = await loadServiceForCabinet(env);
  refreshServiceSnapshot(db, document);
  await cabinetTick(db, document, env);
  db.close();
  return { ok: true, path: env.BOT_CABINET_DB_PATH || 'bot/data/cabinet.sqlite' };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  migrateCabinet()
    .then((result) => {
      console.log(JSON.stringify(result));
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
