import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATION_SQL, MIGRATION_V2_SQL, SCHEMA_VERSION } from './schema.mjs';
import { applyMigrationV3 } from './migrate-steps.mjs';

export function cabinetDbPath(env = process.env) {
  return env.BOT_CABINET_DB_PATH || 'bot/data/cabinet.sqlite';
}

export function openCabinetDb(env = process.env, options = undefined) {
  const readonly = options?.readonly === true;
  const path = cabinetDbPath(env);
  if (!readonly) mkdirSync(dirname(path), { recursive: true });
  const db = readonly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  if (!readonly) migrate(db);
  return db;
}

function migrate(db) {
  db.exec(MIGRATION_SQL);
  const row = db.prepare('SELECT value FROM cabinet_meta WHERE key = ?').get('schema_version');
  const currentVersion = row ? Number(row.value) : 0;
  if (currentVersion < 2) {
    db.exec(MIGRATION_V2_SQL);
  }
  if (currentVersion < 3) {
    applyMigrationV3(db);
  }
  if (!row) {
    db.prepare('INSERT INTO cabinet_meta (key, value) VALUES (?, ?)').run(
      'schema_version',
      String(SCHEMA_VERSION),
    );
    db.prepare('INSERT INTO cabinet_meta (key, value) VALUES (?, ?)').run('data_version', '0');
  } else if (currentVersion < SCHEMA_VERSION) {
    db.prepare('UPDATE cabinet_meta SET value = ? WHERE key = ?').run(
      String(SCHEMA_VERSION),
      'schema_version',
    );
  } else if (currentVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported cabinet schema version: ${row.value}`);
  }
}

export function getMeta(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM cabinet_meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setMeta(db, key, value) {
  db.prepare(
    `INSERT INTO cabinet_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, String(value));
}

export function bumpDataVersion(db) {
  const next = Number(getMeta(db, 'data_version', '0')) + 1;
  setMeta(db, 'data_version', next);
  setMeta(db, 'as_of', new Date().toISOString());
  return next;
}

export function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
