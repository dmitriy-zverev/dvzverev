import { randomUUID } from 'node:crypto';
import { bumpDataVersion, getMeta, setMeta, withTransaction } from './db.mjs';
import { TIME_PATTERN } from './time.mjs';

function decode(row) {
  const pending = row.pending_json ? JSON.parse(row.pending_json) : null;
  return {
    ...JSON.parse(row.config_json),
    ...(pending?.config || {}),
    id: row.id,
    projectId: row.project_id,
    revision: row.revision,
    state: row.state,
    pending: Boolean(pending),
    pendingAction: pending?.remove ? 'delete' : pending ? 'edit' : null,
  };
}

export function listRubrics(db, projectId = null) {
  return db
    .prepare("SELECT * FROM schedule_rubrics WHERE state != 'deleted' ORDER BY created_at,id")
    .all()
    .filter((r) => !projectId || r.project_id === projectId)
    .map(decode);
}

export function validateRubric(input) {
  if (!input || !Array.isArray(input.days) || !Array.isArray(input.times))
    throw new Error('rubric_invalid');
  const name = String(input.name || '').trim();
  const days = [...new Set(input.days || [])].sort();
  const times = [...new Set(input.times || [])].sort();
  if (
    !name ||
    name.length > 80 ||
    !days.length ||
    days.some((d) => !Number.isInteger(d) || d < 1 || d > 7) ||
    !times.length ||
    times.length > 8 ||
    times.some((t) => !TIME_PATTERN.test(t)) ||
    !['text', 'image', 'video'].includes(input.media || 'text')
  )
    throw new Error('rubric_invalid');
  const textPrompt = String(input.textPrompt || '').trim();
  const mediaPrompt = String(input.mediaPrompt || '').trim();
  if (textPrompt.length > 6000 || mediaPrompt.length > 6000)
    throw new Error('rubric_prompt_too_long');
  return {
    name,
    days,
    times,
    media: input.media || 'text',
    textPrompt,
    mediaPrompt,
    enabled: input.enabled !== false,
    color: /^#[0-9a-f]{6}$/i.test(input.color || '') ? input.color : '#806bba',
  };
}

// Bootstrap only once per group: deleting its last rubric must never restore the old schedule.
export function ensureRubrics(db, service, now = new Date()) {
  withTransaction(db, () => {
    for (const [projectId, project] of Object.entries(service.projects || {})) {
      if (getMeta(db, `rubrics_managed:${projectId}`)) continue;
      const variants = new Map();
      for (let day = 1; day <= 7; day++) {
        const times = project.schedule.weekly
          ? project.schedule.weekly[day] || []
          : project.schedule.times;
        for (const time of times || []) {
          const dest = service.destinations?.[project.delivery.destinations[0]];
          const media = dest?.media?.times?.includes(time)
            ? dest.media.kind === 'video'
              ? 'video'
              : 'image'
            : 'text';
          const key = `${media}:${time}`;
          if (!variants.has(key)) variants.set(key, { time, media, days: [] });
          variants.get(key).days.push(day);
        }
      }
      for (const { time, media, days } of variants.values()) {
        const id = randomUUID();
        const config = validateRubric({
          name: `${media === 'text' ? 'Основная рубрика' : media === 'image' ? 'GIF' : 'Видеоистория'} · ${time}`,
          days,
          times: [time],
          media,
          color: media === 'text' ? '#806bba' : '#348579',
        });
        config.adoptLegacy = true;
        db.prepare(
          'INSERT INTO schedule_rubrics(id,project_id,config_json,created_at,updated_at) VALUES (?,?,?,?,?)',
        ).run(id, projectId, JSON.stringify(config), now.toISOString(), now.toISOString());
        const slots = db
          .prepare('SELECT plan_id,slot_key FROM schedule_slots WHERE project_id=?')
          .all(projectId);
        for (const slot of slots) {
          const date = slot.slot_key.slice(0, 10);
          const day = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
          if (slot.slot_key.includes(`@${time}[`) && days.includes(day))
            db.prepare('INSERT OR IGNORE INTO rubric_slots VALUES (?,?,?,?,1,0)').run(
              slot.plan_id,
              id,
              config.name,
              config.color,
            );
        }
      }
      setMeta(db, `rubrics_managed:${projectId}`, '1');
    }
  });
}

export function rubricService(db, service) {
  const result = structuredClone(service);
  for (const [id, project] of Object.entries(result.projects || {})) {
    if (!getMeta(db, `rubrics_managed:${id}`)) continue;
    const rubrics = listRubrics(db, id).filter((r) => r.state === 'active' && r.enabled);
    project.schedule.weekly = Object.fromEntries(
      Array.from({ length: 7 }, (_, index) => {
        const day = index + 1;
        return [
          day,
          [...new Set(rubrics.filter((r) => r.days.includes(day)).flatMap((r) => r.times))].sort(),
        ];
      }),
    );
    project.schedule.times = [...new Set(rubrics.flatMap((r) => r.times))].sort();
  }
  return result;
}

export function rubricForDate(db, projectId, date, time) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
  return listRubrics(db, projectId).find(
    (r) => r.state === 'active' && r.enabled && r.days.includes(day) && r.times.includes(time),
  );
}

export function bindRubricSlot(db, planId, rubric) {
  if (!rubric) return;
  db.prepare(
    `INSERT INTO rubric_slots VALUES (?,?,?,?,?,0)
    ON CONFLICT(plan_id) DO UPDATE SET rubric_id=excluded.rubric_id,label=excluded.label,color=excluded.color,revision=excluded.revision,hidden=0`,
  ).run(planId, rubric.id, rubric.name, rubric.color, rubric.revision);
}

export function applyRubricConfig(config, rubric) {
  if (!rubric) return config;
  if (config.rubricId === rubric.id && config.rubricRevision === rubric.revision) return config;
  const base = config.rubricBase || {
    openrouterPrompt: config.openrouterPrompt,
    coverPrompt: config.coverPrompt,
    videoPrompt: config.videoPrompt,
  };
  return {
    ...config,
    rubricBase: base,
    rubricId: rubric.id,
    rubricRevision: rubric.revision,
    openrouterPrompt: `${base.openrouterPrompt}\n\nРубрика «${rubric.name}». Дополнительное задание (сохраняй системные требования группы):\n${rubric.textPrompt}`,
    coverPrompt: [base.coverPrompt, rubric.mediaPrompt]
      .filter(Boolean)
      .join('\n\nДополнительные требования рубрики:\n'),
    videoPrompt: [base.videoPrompt, rubric.mediaPrompt].filter(Boolean).join('\n\n'),
    weeklyImages: rubric.media !== 'text',
    imagesEnabled: rubric.media !== 'text',
    vkImagesEnabled: rubric.media !== 'text',
    mediaTimes: rubric.media !== 'text' ? rubric.times : [],
    staticPhoto: rubric.media === 'image',
    coverMode: rubric.media === 'video' ? 'video' : 'image',
  };
}

export function slotRubric(db, planId) {
  const row = db
    .prepare(
      'SELECT r.*,rs.hidden,rs.revision AS slot_revision FROM rubric_slots rs JOIN schedule_rubrics r ON r.id=rs.rubric_id WHERE rs.plan_id=?',
    )
    .get(planId);
  if (!row) return null;
  return { ...decode(row), hidden: Boolean(row.hidden), slotRevision: row.slot_revision };
}

export function assertSlotCurrent(db, slot) {
  const current = db
    .prepare('SELECT version,plan_status FROM schedule_slots WHERE plan_id=?')
    .get(slot.plan_id);
  const rubric = slotRubric(db, slot.plan_id);
  if (
    !current ||
    current.plan_status === 'cancelled' ||
    current.version !== slot.version ||
    (rubric &&
      (rubric.hidden ||
        rubric.state !== 'active' ||
        !rubric.enabled ||
        rubric.revision !== rubric.slotRevision))
  )
    throw new Error('rubric_slot_cancelled');
  return rubric;
}

export function createRubric(db, service, projectId, input, now = new Date()) {
  if (!service.projects?.[projectId]) throw new Error('rubric_project_invalid');
  const config = validateRubric(input);
  checkConflicts(db, projectId, config);
  const id = randomUUID();
  db.prepare(
    'INSERT INTO schedule_rubrics(id,project_id,config_json,created_at,updated_at) VALUES (?,?,?,?,?)',
  ).run(id, projectId, JSON.stringify(config), now.toISOString(), now.toISOString());
  bumpDataVersion(db);
  return listRubrics(db, projectId).find((r) => r.id === id);
}

function checkConflicts(db, projectId, config, ignoreId = null) {
  if (!config.enabled) return;
  if (
    listRubrics(db, projectId).some(
      (r) =>
        r.id !== ignoreId &&
        r.state !== 'deleted' &&
        r.enabled &&
        r.days.some((day) => config.days.includes(day)) &&
        r.times.some((time) => config.times.includes(time)),
    )
  )
    throw new Error('rubric_schedule_conflict');
}

// Persist cancellation intent before any network call. A failure keeps the rubric stopped;
// repeating this operation finishes cancellation without creating replacement posts.
async function performChangeRubric(
  db,
  id,
  input,
  { remove = false, client = null, now = new Date(), assertLease = () => {} } = {},
) {
  let row = db.prepare('SELECT * FROM schedule_rubrics WHERE id=?').get(id);
  if (!row || row.state === 'deleted') throw new Error('rubric_not_found');
  if (Number(input.revision) !== row.revision) throw new Error('rubric_version_conflict');
  const config = remove ? null : validateRubric(input);
  if (config) checkConflicts(db, row.project_id, config, id);
  const stamp = now.toISOString();
  const targets = db
    .prepare(
      `SELECT s.*,w.status AS weekly_status,w.post_id,w.group_id,w.week_start FROM schedule_slots s
    JOIN rubric_slots rs USING(plan_id) LEFT JOIN vk_weekly_posts w USING(plan_id)
    WHERE rs.rubric_id=? AND s.slot_utc>? AND s.plan_status!='sent'
    AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.edition_id=s.edition_id AND d.status='sent')`,
    )
    .all(id, stamp);
  if (
    targets.some(
      (s) =>
        (['posting', 'uncertain'].includes(s.weekly_status) && !s.post_id) ||
        (['preparing', 'posting'].includes(s.weekly_status) &&
          db
            .prepare(
              "SELECT 1 FROM vk_weekly_jobs WHERE week_start=? AND status='running' AND lease_until>?",
            )
            .get(s.week_start, Date.now())),
    )
  )
    throw new Error('rubric_preparation_busy');
  if (
    targets.some(
      (s) =>
        ['generating', 'sending', 'uncertain'].includes(s.plan_status) ||
        (s.edition_id &&
          db
            .prepare(
              "SELECT 1 FROM deliveries WHERE edition_id=? AND status IN ('sending','uncertain')",
            )
            .get(s.edition_id)),
    )
  )
    throw new Error('rubric_preparation_busy');
  if (
    targets.some((s) => s.post_id && s.weekly_status !== 'cancelled') &&
    !client?.status().canPrepare
  )
    throw new Error('vk_login_required');
  if (!row.pending_json)
    withTransaction(db, () => {
      db.prepare('UPDATE schedule_rubrics SET state=?,pending_json=?,updated_at=? WHERE id=?').run(
        remove ? 'deleting' : 'updating',
        JSON.stringify({ remove, config }),
        stamp,
        id,
      );
      for (const slot of targets)
        db.prepare(
          "UPDATE schedule_slots SET plan_status='cancelled',version=version+1 WHERE plan_id=?",
        ).run(slot.plan_id);
      bumpDataVersion(db);
    });
  row = db.prepare('SELECT * FROM schedule_rubrics WHERE id=?').get(id);
  const pending = JSON.parse(row.pending_json);
  const published = new Set();
  for (const slot of targets) {
    assertLease();
    if (!slot.post_id || slot.weekly_status === 'cancelled') continue;
    if (client.bindGroup) client.bindGroup(slot.group_id);
    const found = await client.api('wall.getById', { posts: `-${slot.group_id}_${slot.post_id}` });
    const saved = Array.isArray(found) ? found[0] : found.items?.[0];
    assertLease();
    if (saved && !saved.is_deleted) {
      if (saved.id !== slot.post_id || saved.owner_id !== -Number(slot.group_id))
        throw new Error('rubric_cancel_unconfirmed');
      if (saved.date <= Math.floor(now.getTime() / 1000) || saved.post_type === 'post') {
        published.add(slot.plan_id);
        withTransaction(db, () => {
          db.prepare("UPDATE vk_weekly_posts SET status='sent' WHERE plan_id=?").run(slot.plan_id);
          db.prepare("UPDATE schedule_slots SET plan_status='sent' WHERE plan_id=?").run(
            slot.plan_id,
          );
          if (slot.edition_id) {
            db.prepare("UPDATE editions SET aggregate_status='sent' WHERE edition_id=?").run(
              slot.edition_id,
            );
            db.prepare("UPDATE deliveries SET status='sent',sent_at=? WHERE edition_id=?").run(
              new Date(saved.date * 1000).toISOString(),
              slot.edition_id,
            );
          }
        });
        continue;
      }
      const result = await client.api('wall.delete', {
        owner_id: -Number(slot.group_id),
        post_id: slot.post_id,
      });
      assertLease();
      if (result !== 1) throw new Error('rubric_cancel_unconfirmed');
    }
    db.prepare("UPDATE vk_weekly_posts SET status='cancelled',error=NULL WHERE plan_id=?").run(
      slot.plan_id,
    );
  }
  withTransaction(db, () => {
    assertLease();
    for (const slot of targets) {
      if (published.has(slot.plan_id)) continue;
      db.prepare('UPDATE rubric_slots SET hidden=1 WHERE plan_id=?').run(slot.plan_id);
      db.prepare('DELETE FROM vk_weekly_posts WHERE plan_id=?').run(slot.plan_id);
      if (slot.edition_id)
        db.prepare("UPDATE editions SET aggregate_status='cancelled' WHERE edition_id=?").run(
          slot.edition_id,
        );
      db.prepare('UPDATE schedule_slots SET edition_id=NULL WHERE plan_id=?').run(slot.plan_id);
    }
    if (pending.remove) db.prepare('UPDATE rubric_slots SET hidden=1 WHERE rubric_id=?').run(id);
    db.prepare(
      'UPDATE schedule_rubrics SET config_json=?,state=?,revision=revision+1,pending_json=NULL,updated_at=? WHERE id=?',
    ).run(
      pending.config ? JSON.stringify(pending.config) : row.config_json,
      pending.remove ? 'deleted' : 'active',
      stamp,
      id,
    );
    bumpDataVersion(db);
  });
  return { removed: pending.remove, affected: targets.length };
}

export async function changeRubric(db, id, input, options = {}) {
  const owner = randomUUID();
  withTransaction(db, () => {
    const lock = db.prepare('SELECT * FROM rubric_mutation_locks WHERE rubric_id=?').get(id);
    if (lock?.lease_until > Date.now()) throw new Error('rubric_preparation_busy');
    db.prepare(
      'INSERT INTO rubric_mutation_locks VALUES (?,?,?) ON CONFLICT(rubric_id) DO UPDATE SET owner=excluded.owner,lease_until=excluded.lease_until',
    ).run(id, owner, Date.now() + 120000);
  });
  const heartbeat = setInterval(
    () =>
      db
        .prepare('UPDATE rubric_mutation_locks SET lease_until=? WHERE rubric_id=? AND owner=?')
        .run(Date.now() + 120000, id, owner),
    20000,
  );
  heartbeat.unref();
  const assertLease = () => {
    const lock = db
      .prepare('SELECT owner,lease_until FROM rubric_mutation_locks WHERE rubric_id=?')
      .get(id);
    if (lock?.owner !== owner || lock.lease_until <= Date.now())
      throw new Error('rubric_preparation_busy');
  };
  try {
    return await performChangeRubric(db, id, input, { ...options, assertLease });
  } finally {
    clearInterval(heartbeat);
    db.prepare('DELETE FROM rubric_mutation_locks WHERE rubric_id=? AND owner=?').run(id, owner);
  }
}
