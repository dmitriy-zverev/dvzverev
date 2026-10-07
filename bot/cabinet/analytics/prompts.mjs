import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bumpDataVersion, withTransaction } from '../db.mjs';
import { resolveRelativeConfigPath } from '../../config/paths.mjs';

export function contentHash(text) {
  return createHash('sha256').update(String(text || '')).digest('hex');
}

export function listPromptVersions(db, {
  projectId,
  role = null,
  status = null,
  includeContent = false,
} = {}) {
  const params = [];
  let sql = 'SELECT * FROM prompt_versions WHERE 1=1';
  if (projectId) {
    sql += ' AND project_id = ?';
    params.push(projectId);
  }
  if (role) {
    sql += ' AND role = ?';
    params.push(role);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params).map((row) => serializeVersion(row, { includeContent }));
}

export function getActivePromptVersion(db, projectId, role) {
  const row = db
    .prepare(
      `SELECT * FROM prompt_versions
       WHERE project_id = ? AND role = ? AND status = 'active'
       ORDER BY activated_at DESC LIMIT 1`,
    )
    .get(projectId, role);
  return row || null;
}

export function registerPromptVersion(db, input, { inTransaction = false } = {}) {
  const run = () => insertPromptVersion(db, input);
  if (inTransaction) return run();
  try {
    return withTransaction(db, () => {
      const result = run();
      if (!result.error) bumpDataVersion(db);
      return result;
    });
  } catch (error) {
    if (String(error.message || '').includes('UNIQUE')) {
      return { error: 'version_exists', status: 409 };
    }
    throw error;
  }
}

function insertPromptVersion(db, {
  projectId,
  role,
  versionLabel,
  contentText,
  source = 'manual',
  parentVersionId = null,
  actor = 'owner',
  now = new Date(),
}) {
  if (!projectId || !role || !versionLabel || contentText == null) {
    return { error: 'invalid_body', status: 400 };
  }
  const versionId = randomUUID();
  const hash = contentHash(contentText);
  try {
    db.prepare(
      `INSERT INTO prompt_versions (
        version_id, project_id, role, version_label, content_hash, content_text,
        source, status, parent_version_id, created_at, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
    ).run(
      versionId,
      projectId,
      role,
      versionLabel,
      hash,
      contentText,
      source,
      parentVersionId,
      now.toISOString(),
      actor,
    );
  } catch (error) {
    if (String(error.message || '').includes('UNIQUE')) {
      return { error: 'version_exists', status: 409 };
    }
    throw error;
  }
  return { version: getPromptVersion(db, versionId) };
}

export function getPromptVersion(db, versionId) {
  const row = db.prepare('SELECT * FROM prompt_versions WHERE version_id = ?').get(versionId);
  return row ? serializeVersion(row, { includeContent: true }) : null;
}

export function activatePromptVersion(db, versionId, { actor = 'owner', now = new Date(), inTransaction = false } = {}) {
  const run = () => activatePromptVersionInner(db, versionId, { actor, now });
  if (inTransaction) return run();
  return withTransaction(db, () => {
    const result = run();
    if (!result.error) bumpDataVersion(db);
    return result;
  });
}

function activatePromptVersionInner(db, versionId, { actor, now }) {
  const version = db.prepare('SELECT * FROM prompt_versions WHERE version_id = ?').get(versionId);
  if (!version) return { error: 'not_found', status: 404 };
  if (version.status === 'active') {
    return { version: serializeVersion(version, { includeContent: true }), alreadyActive: true };
  }

  db.prepare(
    `UPDATE prompt_versions SET status = 'retired', deactivated_at = ?
     WHERE project_id = ? AND role = ? AND status = 'active' AND version_id != ?`,
  ).run(now.toISOString(), version.project_id, version.role, versionId);

  db.prepare(
    `UPDATE prompt_versions SET status = 'active', activated_at = ?, deactivated_at = NULL
     WHERE version_id = ?`,
  ).run(now.toISOString(), versionId);

  db.prepare(
    `INSERT INTO audit_log (audit_id, actor, action, plan_id, payload_json, created_at)
     VALUES (?, ?, 'prompt_version_activate', NULL, ?, ?)`,
  ).run(
    randomUUID(),
    actor,
    JSON.stringify({
      versionId,
      projectId: version.project_id,
      role: version.role,
      versionLabel: version.version_label,
      contentHash: version.content_hash,
    }),
    now.toISOString(),
  );

  return { version: getPromptVersion(db, versionId) };
}

export function rollbackPromptVersion(db, versionId, { actor = 'owner', now = new Date() } = {}) {
  const version = db.prepare('SELECT * FROM prompt_versions WHERE version_id = ?').get(versionId);
  if (!version) return { error: 'not_found', status: 404 };
  const parentId = version.parent_version_id;
  if (!parentId) return { error: 'no_parent', status: 400 };
  const parent = db.prepare('SELECT * FROM prompt_versions WHERE version_id = ?').get(parentId);
  if (!parent) return { error: 'parent_missing', status: 404 };
  return activatePromptVersion(db, parentId, { actor, now });
}

export async function snapshotPromptFiles(db, service, env = process.env, now = new Date()) {
  const configRoot = resolve(env.BOT_CONFIG_PATH || 'bot/service.json', '..');
  const created = [];
  for (const [projectId, project] of Object.entries(service.projects || {})) {
    if (!project.enabled) continue;
    const roles = [];
    if (project.prompts?.editor) roles.push({ role: 'editor', path: project.prompts.editor });
    if (project.prompts?.cover) roles.push({ role: 'cover', path: project.prompts.cover });
    for (const destId of project.delivery?.destinations || []) {
      const dest = service.destinations?.[destId];
      if (dest?.media?.prompt) roles.push({ role: 'video', path: dest.media.prompt });
    }
    for (const { role, path } of roles) {
      const abs = resolveRelativeConfigPath(configRoot, path);
      let text;
      try {
        text = await readFile(abs, 'utf8');
      } catch {
        continue;
      }
      const hash = contentHash(text);
      const existing = getActivePromptVersion(db, projectId, role);
      if (existing && existing.content_hash === hash) continue;
      const label = `file-${hash.slice(0, 8)}`;
      const result = registerPromptVersion(db, {
        projectId,
        role,
        versionLabel: label,
        contentText: text,
        source: 'file_snapshot',
        parentVersionId: existing?.version_id || null,
        now,
      });
      if (result.version) {
        activatePromptVersion(db, result.version.versionId, { actor: 'system', now });
        created.push(result.version);
      }
    }
  }
  return created;
}

export function promptHashesForEdition(db, projectId) {
  const roles = ['editor', 'reviewer', 'scene', 'video', 'cover'];
  const hashes = {};
  for (const role of roles) {
    const active = getActivePromptVersion(db, projectId, role);
    hashes[role] = active ? active.content_hash : 'unknown';
  }
  return hashes;
}

function serializeVersion(row, { includeContent = false } = {}) {
  return {
    versionId: row.version_id,
    projectId: row.project_id,
    role: row.role,
    versionLabel: row.version_label,
    contentHash: row.content_hash,
    contentText: includeContent ? row.content_text : undefined,
    source: row.source,
    status: row.status,
    activatedAt: row.activated_at,
    deactivatedAt: row.deactivated_at,
    parentVersionId: row.parent_version_id,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}
