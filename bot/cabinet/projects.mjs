import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bumpDataVersion, setMeta, withTransaction } from './db.mjs';
import { projectTitle } from './status.mjs';

export function configVersionHash(document) {
  return createHash('sha256').update(JSON.stringify(document)).digest('hex').slice(0, 16);
}

export function syncProjects(db, service, configVersion) {
  const now = new Date().toISOString();
  const statement = db.prepare(
    `INSERT INTO projects (
      project_id, title, enabled, timezone, format, config_version,
      schedule_json, destinations_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET
      title = excluded.title,
      enabled = excluded.enabled,
      timezone = excluded.timezone,
      format = excluded.format,
      config_version = excluded.config_version,
      schedule_json = excluded.schedule_json,
      destinations_json = excluded.destinations_json,
      updated_at = excluded.updated_at`,
  );
  for (const [projectId, project] of Object.entries(service.projects || {})) {
    statement.run(
      projectId,
      projectTitle(projectId, project),
      project.enabled ? 1 : 0,
      project.schedule?.timezone || 'Europe/Moscow',
      project.format || 'tip',
      configVersion,
      JSON.stringify(project.schedule || {}),
      JSON.stringify(project.delivery?.destinations || []),
      now,
    );
  }
}

export async function loadServiceForCabinet(env = process.env) {
  const configPath = resolve(env.BOT_CONFIG_PATH || 'bot/service.json');
  const raw = await readFile(configPath, 'utf8');
  const document = JSON.parse(raw);
  return { document, configPath, configRoot: resolve(configPath, '..') };
}

export function refreshServiceSnapshot(db, service) {
  const version = configVersionHash(service);
  withTransaction(db, () => {
    syncProjects(db, service, version);
    setMeta(db, 'service_config_version', version);
    bumpDataVersion(db);
  });
  return version;
}
