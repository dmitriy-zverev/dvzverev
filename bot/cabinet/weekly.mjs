import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { openCabinetDb, withTransaction, bumpDataVersion } from './db.mjs';
import { addDaysYmd, isoWeekStart, localSlotToUtc, zonedParts } from './time.mjs';
import { materializeScheduleSlots } from './sync.mjs';
import { loadAppConfig } from '../app-config.mjs';
import { generatePost } from '../openrouter.mjs';
import { generateCover, uploadVkPhoto, ImagePending, coverPath } from '../images.mjs';
import { generateVideoCover } from '../videos.mjs';
import { assertSlotCurrent, applyRubricConfig } from './rubrics.mjs';
import { ensureRubrics } from './rubrics.mjs';
import { formatVkPost } from '../content.mjs';
import { getWeeklyVkClient } from '../vk-oauth/legacy.mjs';
import { reportOAuthError } from '../vk-oauth/routes.mjs';

/** Cap slot retries so a broken token/API cannot hammer VK or spam alerts. */
export const WEEKLY_MAX_ATTEMPTS = 3;
/** Abort the rest of the job after this many consecutive slot failures. */
export const WEEKLY_MAX_CONSECUTIVE_FAILURES = 3;

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

export function weeklySnapshot(db, now = new Date(), current = false) {
  db.prepare(
    `UPDATE vk_weekly_posts SET post_json=NULL WHERE plan_id IN
    (SELECT plan_id FROM schedule_slots WHERE slot_utc < ?)`,
  ).run(new Date(now.getTime() - 30 * 86400000).toISOString());
  const week = nextWeek(now);
  if (current) {
    week.start = addDaysYmd(week.start, -7);
    week.end = addDaysYmd(week.start, 6);
    week.from = now.toISOString();
    week.to = localSlotToUtc(addDaysYmd(week.start, 7), '00:00', 'Europe/Moscow').toISOString();
  }
  const job = db.prepare('SELECT * FROM vk_weekly_jobs WHERE week_start = ?').get(week.start);
  const running = job?.status === 'running' && job.lease_until > now.getTime();
  const rows = db
    .prepare(
      `SELECT s.plan_id, s.project_id, p.title, s.destination_id, s.slot_utc,
      s.topic, s.brief, s.expected_media, w.status, w.post_id, w.group_id, w.error, w.attempts
    FROM schedule_slots s JOIN projects p USING(project_id)
    LEFT JOIN vk_weekly_posts w USING(plan_id)
    WHERE s.slot_utc >= ? AND s.slot_utc < ? AND s.publication_kind IN ('image','video')
      AND s.plan_status != 'cancelled' AND p.enabled = 1
    ORDER BY s.slot_utc, s.project_id`,
    )
    .all(week.from, week.to);
  const posts = rows.map((r) => ({
    planId: r.plan_id,
    projectId: r.project_id,
    title: r.title,
    date: r.slot_utc,
    topic: r.topic,
    media: r.expected_media,
    status: r.status === 'posting' && !running ? 'uncertain' : r.status || 'pending',
    error: r.error,
    attempts: r.attempts || 0,
    url: r.post_id ? `https://vk.ru/wall-${r.group_id}_${r.post_id}` : null,
  }));
  const ready = posts.filter((p) => ['scheduled', 'sent'].includes(p.status)).length;
  const uncertain = posts.filter((p) => p.status === 'uncertain').length;
  const exhausted = posts.filter((p) => p.status === 'exhausted').length;
  const missing = posts.length - ready - uncertain - exhausted;
  return {
    week,
    posts,
    total: posts.length,
    ready,
    missing,
    uncertain,
    exhausted,
    running,
    complete: posts.length > 0 && ready === posts.length,
  };
}

export async function ensureWeeklySnapshot(db, env, now = new Date(), current = false) {
  const app = await loadAppConfig(env);
  if (app.mode !== 'multi') throw new Error('vk_weekly_multi_config_required');
  ensureRubrics(db, app.service, now);
  materializeScheduleSlots(db, app.service, env, now);
  return weeklySnapshot(db, now, current);
}

// A durable lease protects all HTTP requests and replicas, not just this process.
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

function safeError(error) {
  return /^vk_[a-z0-9_]+$/.test(error.message) ? error.message : 'vk_weekly_generation_failed';
}

export async function prepareWeeklyPosts(env, week, owner, dependencies = {}) {
  const db = openCabinetDb(env);
  const client = dependencies.client || getWeeklyVkClient(env);
  const generate = dependencies.generate || generatePost;
  const cover = dependencies.cover || generateCover;
  const upload = dependencies.upload || uploadVkPhoto;
  const pause = dependencies.pause || sleep;
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
        `SELECT s.* FROM schedule_slots s JOIN projects p USING(project_id)
      LEFT JOIN vk_weekly_posts w USING(plan_id) WHERE s.slot_utc>=? AND s.slot_utc<?
      AND s.publication_kind IN ('image','video') AND s.plan_status!='cancelled' AND p.enabled=1
      AND (w.status IS NULL OR w.status NOT IN ('scheduled','sent','uncertain','posting','exhausted'))
      AND COALESCE(w.attempts, 0) < ?
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
      db.prepare(
        `INSERT INTO vk_weekly_posts(plan_id,week_start,status,attempts,updated_at) VALUES (?,?,'preparing',1,?)
        ON CONFLICT(plan_id) DO UPDATE SET status='preparing',error=NULL,attempts=attempts+1,updated_at=excluded.updated_at`,
      ).run(slot.plan_id, week, stamp);
      bumpDataVersion(db);
      try {
        const rubric = assertSlotCurrent(db, slot);
        const video = slot.expected_media === 'video';
        if (video && !client.status?.().canVideo) throw new Error('vk_video_permission_required');
        const config = {
          ...applyRubricConfig(await app.resolveProjectConfig(slot.project_id), rubric),
          staticPhoto: !video,
          videoOutput: video,
          coverMode: video ? 'video' : 'image',
          editorialPlan: { topic: slot.topic || '', brief: slot.brief || '' },
        };
        if (client.bindGroup) client.bindGroup(config.vkGroupId);
        const token = await client.accessToken();
        config.vkPhotosToken = token;
        config.openrouterPrompt += `\nРедакторский план имеет приоритет в рамках достоверности и обязательного формата: ${JSON.stringify(config.editorialPlan)}`;
        let stored = db.prepare('SELECT * FROM vk_weekly_posts WHERE plan_id=?').get(slot.plan_id);
        const id =
          'weekly-' +
          createHash('sha256')
            .update(`${slot.plan_id}:${rubric?.revision || 1}`)
            .digest('hex')
            .slice(0, 32);
        const recent = db
          .prepare(
            'SELECT post_json FROM vk_weekly_posts WHERE post_json IS NOT NULL AND plan_id IN (SELECT plan_id FROM schedule_slots WHERE project_id=?) ORDER BY updated_at DESC LIMIT 30',
          )
          .all(slot.project_id)
          .map((r) => JSON.parse(r.post_json));
        const post = stored.post_json
          ? JSON.parse(stored.post_json)
          : await generate(config, {
              id,
              now: new Date(),
              history: recent.map((p) => p.title).filter(Boolean),
              excludeQuoteIds: recent
                .map((p) => p.quoteId || p.generation?.quoteId)
                .filter(Boolean),
            });
        const message = formatVkPost(post);
        db.prepare('UPDATE vk_weekly_posts SET post_json=?,group_id=? WHERE plan_id=?').run(
          JSON.stringify(post),
          config.vkGroupId,
          slot.plan_id,
        );
        let attachment = stored.attachment;
        if (!attachment) {
          let image;
          if (video) {
            for (let attempt = 0; attempt < 90; attempt++) {
              assertSlotCurrent(db, slot);
              if (!owned()) throw new Error('vk_weekly_lease_lost');
              try {
                image = await (dependencies.video || generateVideoCover)(config, {
                  postId: id,
                  image: { text: message },
                });
                break;
              } catch (error) {
                if (!(error instanceof ImagePending)) throw error;
                await pause(10000);
              }
            }
            if (!image) throw new Error('vk_video_generation_timeout');
          } else image = await cover(config, { postId: id, image: { text: message } });
          const uploaded = video
            ? await client.uploadVideo(
                'group',
                config.vkGroupId,
                image.path || coverPath(config, id),
                rubric?.name || 'Видеоистория',
              )
            : client.uploadWeeklyImage
              ? await client.uploadWeeklyImage(config, {
                  postId: id,
                  vkGroupId: config.vkGroupId,
                  image,
                })
              : await upload(config, { postId: id, vkGroupId: config.vkGroupId, image });
          attachment = typeof uploaded === 'string' ? uploaded : uploaded.attachment;
          const attachmentValid = video
            ? /^video-?\d+_\d+(?:_[\w-]+)?$/.test(attachment || '')
            : /^(?:photo|doc)-?\d+_\d+(?:_[\w-]+)?$/.test(attachment || '');
          if (!attachmentValid) throw new Error('vk_photo_save_invalid');
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
        const result = await client.api('wall.post', {
          owner_id: -Number(config.vkGroupId),
          from_group: 1,
          message,
          attachments: attachment,
          guid: id,
          publish_date: Math.floor(Date.parse(slot.slot_utc) / 1000),
        });
        if (!Number.isSafeInteger(result?.post_id)) throw new Error('vk_wall_post_invalid');
        created = true;
        // Persist the receipt before read-back: failure to verify cannot justify another write.
        db.prepare(
          "UPDATE vk_weekly_posts SET status='uncertain',post_id=?,updated_at=? WHERE plan_id=?",
        ).run(result.post_id, new Date().toISOString(), slot.plan_id);
        const lookup = await client.api('wall.getById', {
          posts: `-${config.vkGroupId}_${result.post_id}`,
        });
        const saved = Array.isArray(lookup) ? lookup[0] : lookup.items?.[0];
        if (
          saved?.id !== result.post_id ||
          saved.owner_id !== -Number(config.vkGroupId) ||
          saved.date !== Math.floor(Date.parse(slot.slot_utc) / 1000) ||
          !saved.attachments?.some((a) => {
            const kind = video ? 'video' : /^doc/.test(attachment || '') ? 'doc' : 'photo';
            if (a.type !== kind) return false;
            const item = a[kind];
            return `${kind}${item?.owner_id}_${item?.id}` === attachment.split('_').slice(0, 2).join('_');
          })
        )
          throw new Error('vk_weekly_post_verification_failed');
        withTransaction(db, () => {
          db.prepare(
            "UPDATE vk_weekly_posts SET status='scheduled',post_id=?,error=NULL,updated_at=? WHERE plan_id=?",
          ).run(result.post_id, new Date().toISOString(), slot.plan_id);
          const editionId = createHash('sha256')
            .update(`${slot.project_id}\0${slot.slot_key}`)
            .digest('hex')
            .slice(0, 32);
          db.prepare(
            `INSERT INTO editions(edition_id,project_id,slot_key,plan_id,format,topic,brief,body_text,aggregate_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'ready',?,?)
             ON CONFLICT(edition_id) DO UPDATE SET body_text=excluded.body_text,topic=excluded.topic,brief=excluded.brief,aggregate_status='ready',updated_at=excluded.updated_at`,
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
            `INSERT INTO deliveries(delivery_id,edition_id,project_id,destination_id,platform,status,post_id,external_id,vk_group_id,created_at,updated_at) VALUES (?,?,?,?,'vk','planned',?,?,?,?,?)
             ON CONFLICT(delivery_id) DO UPDATE SET edition_id=excluded.edition_id,status='planned',post_id=excluded.post_id,external_id=excluded.external_id,updated_at=excluded.updated_at`,
          ).run(
            `${slot.slot_key}:${slot.destination_id}:vk`,
            editionId,
            slot.project_id,
            slot.destination_id,
            String(result.post_id),
            String(result.post_id),
            config.vkGroupId,
            stamp,
            stamp,
          );
          bumpDataVersion(db);
        });
        consecutiveFailures = 0;
      } catch (error) {
        // Only an explicit API rejection proves the write did not happen.
        const uncertain = created || (dispatching && !error.vkCode);
        const attempts =
          db.prepare('SELECT attempts FROM vk_weekly_posts WHERE plan_id=?').get(slot.plan_id)
            ?.attempts || 0;
        const terminal =
          !uncertain &&
          (attempts >= WEEKLY_MAX_ATTEMPTS ||
            /login_required|wrong_user|lease_lost/.test(error.message) ||
            error.vkCode === 5);
        db.prepare('UPDATE vk_weekly_posts SET status=?,error=?,updated_at=? WHERE plan_id=?').run(
          uncertain ? 'uncertain' : terminal ? 'exhausted' : 'failed',
          safeError(error),
          new Date().toISOString(),
          slot.plan_id,
        );
        bumpDataVersion(db);
        consecutiveFailures += 1;
        await (dependencies.report || reportOAuthError)(env, error);
        if (
          /login_required|wrong_user|lease_lost/.test(error.message) ||
          error.vkCode === 5 ||
          consecutiveFailures >= WEEKLY_MAX_CONSECUTIVE_FAILURES
        )
          break;
        await pause(error.vkCode === 6 || error.vkCode === 9 ? 60000 : 3000);
      }
      await pause(1200);
    }
    db.prepare(
      "UPDATE vk_weekly_jobs SET status='finished',lease_until=0,updated_at=? WHERE week_start=? AND owner=?",
    ).run(new Date().toISOString(), week, owner);
  } catch (error) {
    db.prepare(
      "UPDATE vk_weekly_jobs SET status='failed',lease_until=0,updated_at=? WHERE week_start=? AND owner=?",
    ).run(new Date().toISOString(), week, owner);
    await (dependencies.report || reportOAuthError)(env, error);
  } finally {
    clearInterval(heartbeat);
    db.close();
  }
}
