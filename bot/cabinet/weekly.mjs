import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { openCabinetDb, withTransaction, bumpDataVersion, getMeta, setMeta } from './db.mjs';
import { addDaysYmd, isoWeekStart, localSlotToUtc, zonedParts } from './time.mjs';
import { materializeScheduleSlots } from './sync.mjs';
import { loadAppConfig } from '../app-config.mjs';
import { generatePost } from '../openrouter.mjs';
import { generateCover, uploadVkPhoto } from '../images.mjs';
import { assertSlotCurrent, applyRubricConfig, ensureRubrics } from './rubrics.mjs';
import { formatVkPost } from '../content.mjs';
import { getWeeklyVkClient } from '../vk-oauth/legacy.mjs';
import { notifyWeeklyPrepareDigest } from './weekly-notify.mjs';

/** Cap slot retries so a broken token/API cannot hammer VK or spam alerts. */
export const WEEKLY_MAX_ATTEMPTS = 3;
/** Abort the rest of the job after this many consecutive slot failures. */
export const WEEKLY_MAX_CONSECUTIVE_FAILURES = 3;

const READY_STATUSES = new Set(['deferred', 'scheduled', 'sent']);
/** Rubric media `image` and legacy destination kind `gif` are the same wall GIF path. */
const WEEKLY_KINDS = new Set(['text', 'image', 'gif']);
const WEEKLY_KIND_SQL = "'text','image','gif'";

export function nextWeek(now = new Date()) {
  const p = zonedParts(now, 'Europe/Moscow');
  const start = addDaysYmd(isoWeekStart(`${p.year}-${p.month}-${p.day}`), 7);
  return {
    start,
    end: addDaysYmd(start, 6),
    from: localSlotToUtc(start, '00:00', 'Europe/Moscow').toISOString(),
    to: localSlotToUtc(addDaysYmd(start, 7), '00:00', 'Europe/Moscow').toISOString(),
  };
}

/** Current calendar week (Mon–Sun MSK), full bounds — past slots stay visible. */
export function currentWeek(now = new Date()) {
  const next = nextWeek(now);
  const start = addDaysYmd(next.start, -7);
  return {
    start,
    end: addDaysYmd(start, 6),
    from: localSlotToUtc(start, '00:00', 'Europe/Moscow').toISOString(),
    to: localSlotToUtc(addDaysYmd(start, 7), '00:00', 'Europe/Moscow').toISOString(),
  };
}

export function weekForScope(now = new Date(), scope = 'current') {
  return scope === 'next' ? nextWeek(now) : currentWeek(now);
}

export function isSundayWeeklyPrepareWindow(now = new Date()) {
  const p = zonedParts(now, 'Europe/Moscow');
  const dateYmd = `${p.year}-${p.month}-${p.day}`;
  const weekday = new Date(`${dateYmd}T12:00:00Z`).getUTCDay() || 7;
  return weekday === 7 && Number(p.hour) >= 20;
}

function publishedAlready(row) {
  return row.plan_status === 'sent' || row.delivery_status === 'sent';
}

export function weeklySnapshot(db, now = new Date(), scope = 'current') {
  const current = scope === true || scope === 'current';
  const scopeKey = current ? 'current' : scope === 'next' || scope === false ? 'next' : 'current';
  db.prepare(
    `UPDATE vk_weekly_posts SET post_json=NULL WHERE plan_id IN
    (SELECT plan_id FROM schedule_slots WHERE slot_utc < ?)`,
  ).run(new Date(now.getTime() - 30 * 86400000).toISOString());
  const week = weekForScope(now, scopeKey);
  const job = db.prepare('SELECT * FROM vk_weekly_jobs WHERE week_start = ?').get(week.start);
  const running = job?.status === 'running' && job.lease_until > now.getTime();
  const rows = db
    .prepare(
      `SELECT s.plan_id, s.project_id, p.title, s.destination_id, s.slot_utc, s.plan_status,
      s.topic, s.brief, s.expected_media, s.publication_kind, w.status, w.post_id, w.group_id, w.error, w.attempts,
      (SELECT d.status FROM deliveries d
        WHERE d.edition_id = s.edition_id AND d.platform = 'vk'
        ORDER BY d.updated_at DESC LIMIT 1) AS delivery_status
    FROM schedule_slots s JOIN projects p USING(project_id)
    LEFT JOIN vk_weekly_posts w USING(plan_id)
    WHERE s.slot_utc >= ? AND s.slot_utc < ? AND s.publication_kind IN (${WEEKLY_KIND_SQL})
      AND s.plan_status != 'cancelled' AND p.enabled = 1
    ORDER BY s.slot_utc, s.project_id`,
    )
    .all(week.from, week.to);
  const nowMs = now.getTime();
  const posts = rows.map((r) => {
    let status = r.status === 'posting' && !running ? 'uncertain' : r.status || 'pending';
    if (publishedAlready(r)) status = 'sent';
    return {
      planId: r.plan_id,
      projectId: r.project_id,
      title: r.title,
      date: r.slot_utc,
      topic: r.topic,
      media: r.expected_media || r.publication_kind,
      status,
      error: r.error,
      attempts: r.attempts || 0,
      url: r.post_id ? `https://vk.ru/wall-${r.group_id}_${r.post_id}` : null,
      past: Date.parse(r.slot_utc) <= nowMs,
    };
  });
  // Prepare only future holes; past + already published never inflate missing.
  const actionable = posts.filter((p) => !p.past && !READY_STATUSES.has(p.status));
  const ready = posts.filter((p) => READY_STATUSES.has(p.status)).length;
  const uncertain = actionable.filter((p) => p.status === 'uncertain').length;
  const exhausted = actionable.filter((p) => p.status === 'exhausted').length;
  const missing = actionable.filter(
    (p) => p.status !== 'uncertain' && p.status !== 'exhausted',
  ).length;
  return {
    scope: scopeKey,
    week,
    posts,
    total: posts.length,
    ready,
    missing,
    uncertain,
    exhausted,
    running,
    complete: posts.length > 0 && actionable.length === 0,
  };
}

export async function ensureWeeklySnapshot(db, env, now = new Date(), scope = 'current') {
  const app = await loadAppConfig(env);
  if (app.mode !== 'multi') throw new Error('vk_weekly_multi_config_required');
  ensureRubrics(db, app.service, now);
  materializeScheduleSlots(db, app.service, env, now);
  return weeklySnapshot(db, now, scope);
}

export function claimWeeklyJob(db, week, now = new Date()) {
  return withTransaction(db, () => {
    const existing = db.prepare('SELECT * FROM vk_weekly_jobs WHERE week_start = ?').get(week);
    if (existing?.status === 'running' && existing.lease_until > now.getTime()) return null;
    db.prepare(
      "UPDATE vk_weekly_posts SET status = 'uncertain', error = 'vk_post_outcome_requires_manual_check' WHERE week_start = ? AND status = 'posting'",
    ).run(week);
    const owner = randomUUID();
    db.prepare(
      `INSERT INTO vk_weekly_jobs VALUES (?, ?, 'running', ?, ?)
      ON CONFLICT(week_start) DO UPDATE SET owner=excluded.owner, status='running', lease_until=excluded.lease_until, updated_at=excluded.updated_at`,
    ).run(week, owner, now.getTime() + 120000, now.toISOString());
    return owner;
  });
}

/** Poster tick: Sunday ≥20:00 MSK starts next-week prepare once. */
export async function maybeStartSundayWeeklyPrepare(env, now = new Date(), dependencies = {}) {
  if (!isSundayWeeklyPrepareWindow(now)) return { skipped: 'not_sunday_window' };
  const week = nextWeek(now);
  const metaKey = `weekly_auto_prepare:${week.start}`;
  const db = openCabinetDb(env);
  try {
    if (getMeta(db, metaKey)) return { skipped: 'already_started', week: week.start };
    const client = dependencies.client || getWeeklyVkClient(env);
    if (!client?.status().canPrepare) return { skipped: 'vk_community_not_ready', week: week.start };
    if (dependencies.ensure !== false) await ensureWeeklySnapshot(db, env, now, 'next');
    const snapshot = weeklySnapshot(db, now, 'next');
    if (snapshot.running) return { skipped: 'already_running', week: week.start };
    // `missing` excludes uncertain; those still need verify-only recovery.
    if (snapshot.missing <= 0 && snapshot.uncertain <= 0) {
      // Stamp so Sunday ticks stop re-running expensive ensure/materialize.
      setMeta(db, metaKey, now.toISOString());
      return { skipped: 'nothing_missing', week: week.start };
    }
    const owner = claimWeeklyJob(db, week.start, now);
    if (!owner) return { skipped: 'lease_busy', week: week.start };
    setMeta(db, metaKey, now.toISOString());
    const prepare = dependencies.prepare || prepareWeeklyPosts;
    void prepare(env, week.start, owner, { ...dependencies, source: 'schedule' });
    return {
      started: true,
      week: week.start,
      missing: snapshot.missing,
      uncertain: snapshot.uncertain,
    };
  } finally {
    db.close();
  }
}

function safeError(error) {
  return /^vk_[a-z0-9_]+$/.test(error.message) ? error.message : 'vk_weekly_generation_failed';
}

function slotGuid(planId) {
  return (
    'weekly-' +
    createHash('sha256').update(String(planId)).digest('hex').slice(0, 32)
  );
}

function attachmentMatches(saved, attachment, kind) {
  if (!attachment) return true;
  const wantKind = kind === 'video' ? 'video' : /^doc/.test(attachment) ? 'doc' : 'photo';
  return Boolean(
    saved?.attachments?.some((a) => {
      if (a.type !== wantKind) return false;
      const item = a[wantKind];
      return (
        `${wantKind}${item?.owner_id}_${item?.id}` === attachment.split('_').slice(0, 2).join('_')
      );
    }),
  );
}

function isPostponedReceipt(saved, { postId, groupId, publishDate, attachment, media }) {
  if (!saved) return false;
  if (saved.id !== postId) return false;
  if (saved.owner_id !== -Number(groupId)) return false;
  if (saved.date !== publishDate) return false;
  const postponed = saved.post_type === 'postponed' || saved.post_type === 'postpone';
  if (!postponed) return false;
  if (media === 'text') return true;
  return attachmentMatches(saved, attachment, media);
}

function markDeferred(db, slot, config, message, postId, stamp) {
  withTransaction(db, () => {
    db.prepare(
      "UPDATE vk_weekly_posts SET status='deferred',post_id=?,error=NULL,updated_at=? WHERE plan_id=?",
    ).run(postId, new Date().toISOString(), slot.plan_id);
    const editionId = createHash('sha256')
      .update(`${slot.project_id}\0${slot.slot_key}`)
      .digest('hex')
      .slice(0, 32);
    db.prepare(
      `INSERT INTO editions(edition_id,project_id,slot_key,plan_id,format,topic,brief,body_text,aggregate_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'deferred',?,?)
       ON CONFLICT(edition_id) DO UPDATE SET body_text=excluded.body_text,topic=excluded.topic,brief=excluded.brief,aggregate_status='deferred',updated_at=excluded.updated_at`,
    ).run(
      editionId,
      slot.project_id,
      slot.slot_key,
      slot.plan_id,
      config.contentMode,
      slot.topic,
      slot.brief,
      message,
      stamp,
      stamp,
    );
    db.prepare(
      "UPDATE schedule_slots SET edition_id=?,plan_status='ready',updated_at=? WHERE plan_id=?",
    ).run(editionId, stamp, slot.plan_id);
    db.prepare(
      `INSERT INTO deliveries(delivery_id,edition_id,project_id,destination_id,platform,status,post_id,external_id,vk_group_id,created_at,updated_at) VALUES (?,?,?,?,'vk','deferred',?,?,?,?,?)
       ON CONFLICT(delivery_id) DO UPDATE SET edition_id=excluded.edition_id,status='deferred',post_id=excluded.post_id,external_id=excluded.external_id,updated_at=excluded.updated_at`,
    ).run(
      `${slot.slot_key}:${slot.destination_id}:vk`,
      editionId,
      slot.project_id,
      slot.destination_id,
      String(postId),
      String(postId),
      config.vkGroupId,
      stamp,
      stamp,
    );
    bumpDataVersion(db);
  });
}

export async function prepareWeeklyPosts(env, week, owner, dependencies = {}) {
  const db = openCabinetDb(env);
  const client = dependencies.client || getWeeklyVkClient(env);
  const generate = dependencies.generate || generatePost;
  const cover = dependencies.cover || generateCover;
  const upload = dependencies.upload || uploadVkPhoto;
  const pause = dependencies.pause || sleep;
  const source = dependencies.source || 'button';
  const owned = () =>
    db
      .prepare(
        "SELECT 1 FROM vk_weekly_jobs WHERE week_start=? AND owner=? AND status='running' AND lease_until>?",
      )
      .get(week, owner, Date.now());
  const heartbeat = setInterval(
    () =>
      db
        .prepare(
          "UPDATE vk_weekly_jobs SET lease_until=?,updated_at=? WHERE week_start=? AND owner=? AND status='running'",
        )
        .run(Date.now() + 120000, new Date().toISOString(), week, owner),
    20000,
  );
  heartbeat.unref();
  try {
    const app = dependencies.app || (await loadAppConfig(env));
    const rows = db
      .prepare(
        `SELECT s.*, w.status AS weekly_status, w.post_id AS weekly_post_id, w.attempts AS weekly_attempts
      FROM schedule_slots s JOIN projects p USING(project_id)
      LEFT JOIN vk_weekly_posts w USING(plan_id) WHERE s.slot_utc>=? AND s.slot_utc<?
      AND s.publication_kind IN (${WEEKLY_KIND_SQL})
      AND s.plan_status NOT IN ('cancelled','sent') AND p.enabled=1
      AND NOT EXISTS (
        SELECT 1 FROM deliveries d
        WHERE d.edition_id = s.edition_id AND d.platform = 'vk' AND d.status = 'sent'
      )
      AND (
        w.status IS NULL
        OR w.status IN ('failed','preparing')
        OR (w.status='uncertain' AND w.post_id IS NOT NULL)
      )
      AND (
        COALESCE(w.attempts, 0) < ?
        OR (w.status='uncertain' AND w.post_id IS NOT NULL)
      )
      ORDER BY s.slot_utc,s.project_id`,
      )
      .all(
        localSlotToUtc(week, '00:00', 'Europe/Moscow').toISOString(),
        localSlotToUtc(addDaysYmd(week, 7), '00:00', 'Europe/Moscow').toISOString(),
        WEEKLY_MAX_ATTEMPTS,
      );
    let consecutiveFailures = 0;
    for (const slot of rows) {
      if (Date.parse(slot.slot_utc) <= Date.now()) continue;
      if (!owned()) throw new Error('vk_weekly_lease_lost');
      let dispatching = false;
      let created = false;
      const stamp = new Date().toISOString();
      const media = slot.publication_kind === 'text' ? 'text' : 'image';
      const verifyOnly = slot.weekly_status === 'uncertain' && slot.weekly_post_id;
      if (!verifyOnly) {
        db.prepare(
          `INSERT INTO vk_weekly_posts(plan_id,week_start,status,attempts,updated_at) VALUES (?,?,'preparing',1,?)
          ON CONFLICT(plan_id) DO UPDATE SET status='preparing',error=NULL,attempts=attempts+1,updated_at=excluded.updated_at`,
        ).run(slot.plan_id, week, stamp);
        bumpDataVersion(db);
      }
      try {
        const rubric = assertSlotCurrent(db, slot);
        const config = {
          ...applyRubricConfig(await app.resolveProjectConfig(slot.project_id), rubric),
          staticPhoto: false,
          videoOutput: false,
          coverMode: 'image',
          editorialPlan: { topic: slot.topic || '', brief: slot.brief || '' },
        };
        if (client.bindGroup) client.bindGroup(config.vkGroupId);
        const token = await client.accessToken();
        config.vkPhotosToken = token;
        config.vkToken = token;
        config.openrouterPrompt += `\nРедакторский план имеет приоритет в рамках достоверности и обязательного формата: ${JSON.stringify(config.editorialPlan)}`;
        let stored = db.prepare('SELECT * FROM vk_weekly_posts WHERE plan_id=?').get(slot.plan_id);
        const id = slotGuid(slot.plan_id);
        const publishDate = Math.floor(Date.parse(slot.slot_utc) / 1000);

        if (stored?.post_id) {
          const lookup = await client.api('wall.getById', {
            posts: `-${config.vkGroupId}_${stored.post_id}`,
          });
          const saved = Array.isArray(lookup) ? lookup[0] : lookup.items?.[0];
          let message = '';
          if (stored.post_json) {
            try {
              message = formatVkPost(JSON.parse(stored.post_json));
            } catch {
              message = '';
            }
          }
          if (
            isPostponedReceipt(saved, {
              postId: stored.post_id,
              groupId: config.vkGroupId,
              publishDate,
              attachment: stored.attachment,
              media,
            })
          ) {
            markDeferred(db, slot, config, message, stored.post_id, stamp);
            consecutiveFailures = 0;
            await pause(1200);
            continue;
          }
          // Any existing post_id: never wall.post again (duplicate risk). Soft skip.
          await pause(3000);
          continue;
        }

        const recent = db
          .prepare(
            'SELECT post_json FROM vk_weekly_posts WHERE post_json IS NOT NULL AND plan_id IN (SELECT plan_id FROM schedule_slots WHERE project_id=?) ORDER BY updated_at DESC LIMIT 30',
          )
          .all(slot.project_id)
          .flatMap((r) => {
            try {
              return [JSON.parse(r.post_json)];
            } catch {
              return [];
            }
          });
        let post = null;
        if (stored.post_json) {
          try {
            post = JSON.parse(stored.post_json);
          } catch {
            post = null;
          }
        }
        if (!post) {
          post = await generate(config, {
            id,
            now: new Date(),
            history: recent.map((p) => p.title).filter(Boolean),
            excludeQuoteIds: recent
              .map((p) => p.quoteId || p.generation?.quoteId)
              .filter(Boolean),
          });
        }
        const message = formatVkPost(post);
        db.prepare('UPDATE vk_weekly_posts SET post_json=?,group_id=? WHERE plan_id=?').run(
          JSON.stringify(post),
          config.vkGroupId,
          slot.plan_id,
        );

        let attachment = stored.attachment || null;
        if (media === 'image' && !attachment) {
          const image = await cover(config, { postId: id, image: { text: message } });
          const uploaded = client.uploadWeeklyImage
            ? await client.uploadWeeklyImage(config, {
                postId: id,
                vkGroupId: config.vkGroupId,
                image,
              })
            : await upload(config, { postId: id, vkGroupId: config.vkGroupId, image });
          attachment = typeof uploaded === 'string' ? uploaded : uploaded.attachment;
          if (!/^(?:photo|doc)-?\d+_\d+(?:_[\w-]+)?$/.test(attachment || ''))
            throw new Error('vk_photo_save_invalid');
          db.prepare('UPDATE vk_weekly_posts SET attachment=? WHERE plan_id=?').run(
            attachment,
            slot.plan_id,
          );
        }

        await client.accessToken();
        if (!owned()) throw new Error('vk_weekly_lease_lost');
        assertSlotCurrent(db, slot);
        if (Date.parse(slot.slot_utc) <= Date.now() + 60000)
          throw new Error('vk_weekly_slot_too_late');

        db.prepare("UPDATE vk_weekly_posts SET status='posting',updated_at=? WHERE plan_id=?").run(
          new Date().toISOString(),
          slot.plan_id,
        );
        dispatching = true;
        const wallParams = {
          owner_id: -Number(config.vkGroupId),
          from_group: 1,
          message,
          guid: id,
          publish_date: publishDate,
        };
        if (attachment) wallParams.attachments = attachment;
        const result = await client.api('wall.post', wallParams);
        if (!Number.isSafeInteger(result?.post_id)) throw new Error('vk_wall_post_invalid');
        created = true;
        db.prepare(
          "UPDATE vk_weekly_posts SET status='uncertain',post_id=?,updated_at=? WHERE plan_id=?",
        ).run(result.post_id, new Date().toISOString(), slot.plan_id);

        const lookup = await client.api('wall.getById', {
          posts: `-${config.vkGroupId}_${result.post_id}`,
        });
        const saved = Array.isArray(lookup) ? lookup[0] : lookup.items?.[0];
        if (
          !isPostponedReceipt(saved, {
            postId: result.post_id,
            groupId: config.vkGroupId,
            publishDate,
            attachment,
            media,
          })
        )
          throw new Error('vk_weekly_post_verification_failed');

        markDeferred(db, slot, config, message, result.post_id, stamp);
        consecutiveFailures = 0;
      } catch (error) {
        const uncertain = created || (dispatching && !error.vkCode);
        const attempts =
          db.prepare('SELECT attempts FROM vk_weekly_posts WHERE plan_id=?').get(slot.plan_id)
            ?.attempts || 0;
        const terminal =
          !uncertain &&
          (attempts >= WEEKLY_MAX_ATTEMPTS ||
            /login_required|wrong_user|lease_lost|community_/.test(error.message) ||
            error.vkCode === 5);
        db.prepare('UPDATE vk_weekly_posts SET status=?,error=?,updated_at=? WHERE plan_id=?').run(
          uncertain ? 'uncertain' : terminal ? 'exhausted' : 'failed',
          safeError(error),
          new Date().toISOString(),
          slot.plan_id,
        );
        bumpDataVersion(db);
        consecutiveFailures += 1;
        if (
          /login_required|wrong_user|lease_lost|community_/.test(error.message) ||
          error.vkCode === 5 ||
          consecutiveFailures >= WEEKLY_MAX_CONSECUTIVE_FAILURES
        )
          break;
        const attemptPause =
          error.vkCode === 6 || error.vkCode === 9
            ? 60000
            : Math.min(30000, 3000 * Math.max(1, attempts));
        await pause(attemptPause);
      }
      await pause(1200);
    }
    db.prepare(
      "UPDATE vk_weekly_jobs SET status='finished',lease_until=0,updated_at=? WHERE week_start=? AND owner=?",
    ).run(new Date().toISOString(), week, owner);
    await (dependencies.notify || notifyWeeklyPrepareDigest)(db, {
      weekStart: week,
      source,
      env,
    });
  } catch (error) {
    console.error(`weekly prepare failed week=${week}: ${error.message || error}`);
    db.prepare(
      "UPDATE vk_weekly_jobs SET status='failed',lease_until=0,updated_at=? WHERE week_start=? AND owner=?",
    ).run(new Date().toISOString(), week, owner);
    await (dependencies.notify || notifyWeeklyPrepareDigest)(db, {
      weekStart: week,
      source,
      env,
    });
  } finally {
    clearInterval(heartbeat);
    db.close();
  }
}

export { READY_STATUSES, WEEKLY_KINDS };
