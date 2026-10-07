import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bumpDataVersion, setMeta, withTransaction } from './db.mjs';
import { aggregateEditionStatus, mapEntryStatus, publicationKind } from './status.mjs';
import {
  addDaysYmd,
  formatDateYmd,
  localSlotToUtc,
  scheduledTimesForDay,
  slotKey,
  zonedParts,
} from './time.mjs';
import { resolveRelativeConfigPath } from '../config/paths.mjs';
import { bootstrapRedisSchedule } from '../redis/bootstrap.mjs';
import { materializeBatches } from './batches.mjs';
import { runReportWorker } from './reports/worker.mjs';
import { upsertPostFeatures, inferMediaActual } from './analytics/features.mjs';
import { runAnalyticsCleanup } from './analytics/ttl.mjs';
import { runEditorialScheduler } from './editorial/scheduler.mjs';
import { syncEditorialMemory } from './editorial/memory.mjs';

const MATERIALIZE_DAYS_FORWARD = 14;
const MATERIALIZE_DAYS_BACK = 7;
const SLOT_WINDOW_MINUTES = 5;

export function materializeScheduleSlots(db, service, env, now = new Date()) {
  const configVersion = db
    .prepare('SELECT value FROM cabinet_meta WHERE key = ?')
    .get('service_config_version')?.value;
  if (!configVersion) throw new Error('Service snapshot missing; run cabinet migrate first');

  return withTransaction(db, () => {
    let inserted = 0;
    for (const [projectId, project] of Object.entries(service.projects || {})) {
      if (!project.enabled) continue;
      const timezone = project.schedule?.timezone || 'Europe/Moscow';
      const todayParts = zonedParts(now, timezone);
      const todayYmd = formatDateYmd({
        year: Number(todayParts.year),
        month: Number(todayParts.month),
        day: Number(todayParts.day),
      });
      for (let offset = -MATERIALIZE_DAYS_BACK; offset < MATERIALIZE_DAYS_FORWARD; offset += 1) {
        const dateYmd = addDaysYmd(todayYmd, offset, timezone);
        const times = scheduledTimesForDay(project.schedule, dateYmd, timezone);
        for (const destinationId of project.delivery?.destinations || []) {
          const destination = service.destinations?.[destinationId];
          if (!destination) continue;
          for (const time of times) {
            const key = slotKey(dateYmd, time, timezone);
            const slotUtc = localSlotToUtc(dateYmd, time, timezone).toISOString();
            const publication = publicationKind(
              { mediaTimes: destination.media?.times, coverMode: destination.media?.kind },
              key,
              destination,
            );
            const existing = db
              .prepare(
                'SELECT plan_id, plan_status, edition_id, config_version FROM schedule_slots WHERE project_id = ? AND destination_id = ? AND slot_utc = ?',
              )
              .get(projectId, destinationId, slotUtc);
            if (existing?.edition_id) continue;
            if (
              existing &&
              !['planned', 'missed'].includes(existing.plan_status) &&
              existing.config_version === configVersion
            )
              continue;

            let planStatus = 'planned';
            const slotAgeMinutes =
              (now.getTime() - localSlotToUtc(dateYmd, time, timezone).getTime()) / 60000;
            if (
              slotAgeMinutes > SLOT_WINDOW_MINUTES &&
              (project.schedule?.missedSlots || 'skip') === 'skip' &&
              !existing?.edition_id
            ) {
              planStatus = existing?.plan_status === 'missed' ? 'missed' : 'missed';
            } else if (
              existing?.plan_status === 'missed' &&
              slotAgeMinutes <= SLOT_WINDOW_MINUTES
            ) {
              planStatus = 'planned';
            } else if (existing) {
              planStatus = existing.plan_status;
            }

            if (existing) {
              db.prepare(
                `UPDATE schedule_slots SET
                  slot_key = ?, publication_kind = ?, expected_media = ?, plan_status = ?,
                  config_version = ?, updated_at = ?
                 WHERE plan_id = ? AND edition_id IS NULL AND plan_status IN ('planned', 'missed')`,
              ).run(
                key,
                publication.kind,
                publication.media,
                planStatus,
                configVersion,
                now.toISOString(),
                existing.plan_id,
              );
              continue;
            }

            db.prepare(
              `INSERT INTO schedule_slots (
                plan_id, project_id, destination_id, slot_utc, slot_key, publication_kind,
                expected_media, topic_state, plan_status, config_version, version, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?, 1, ?, ?)`,
            ).run(
              randomUUID(),
              projectId,
              destinationId,
              slotUtc,
              key,
              publication.kind,
              publication.media,
              planStatus,
              configVersion,
              now.toISOString(),
              now.toISOString(),
            );
            inserted += 1;
          }
        }
      }
    }
    bumpDataVersion(db);
    return inserted;
  });
}

function deliveryIdFor(entry, destinationId) {
  return `${entry.slot}:${destinationId}:${entry.platform || 'vk'}`;
}

function editionIdFor(projectId, entry) {
  return createHash('sha256').update(`${projectId}\0${entry.slot}`).digest('hex').slice(0, 32);
}

export async function syncProjectState(db, service, projectId, env, now = new Date()) {
  const project = service.projects?.[projectId];
  if (!project) return { editions: 0, deliveries: 0 };
  const configRoot = resolveConfigRoot(env);
  const promptVersion = db
    .prepare('SELECT value FROM cabinet_meta WHERE key = ?')
    .get('service_config_version')?.value;
  const statePath = project.statePath
    ? resolveRelativeConfigPath(configRoot, project.statePath)
    : resolve(configRoot, `state/${projectId}.json`);
  const raw = JSON.parse(await readFile(statePath, 'utf8'));
  const destinationId = project.delivery?.destinations?.[0];

  return withTransaction(db, () => {
    let editions = 0;
    let deliveries = 0;
    for (const entry of raw.entries || []) {
      if (!entry.slot || entry.generationRecovered) continue;
      const editionId = editionIdFor(projectId, entry);
      const deliveryId = deliveryIdFor(entry, destinationId);
      const status = mapEntryStatus(entry);
      const body =
        typeof entry.vkText === 'string'
          ? entry.vkText
          : typeof entry.html === 'string'
            ? entry.html.replace(/<[^>]+>/g, '')
            : null;
      const models = entry.generation
        ? { text: entry.generation.model, review: entry.generation.reviewModel }
        : null;
      const existingEdition = db
        .prepare('SELECT edition_id FROM editions WHERE edition_id = ?')
        .get(editionId);
      if (!existingEdition) {
        db.prepare(
          `INSERT INTO editions (
            edition_id, project_id, slot_key, format, topic, brief, body_text,
            prompt_version, models_json, cost_usd, aggregate_status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          editionId,
          projectId,
          entry.slot,
          project.format,
          entry.generation?.title || entry.generation?.quoteId || null,
          null,
          body,
          entry.generation?.promptVersions?.editor?.versionId || promptVersion || null,
          models ? JSON.stringify(models) : null,
          entry.generation?.cost ?? null,
          status,
          entry.createdAt || now.toISOString(),
          now.toISOString(),
        );
        editions += 1;
      } else {
        db.prepare(
          `UPDATE editions SET
            body_text = COALESCE(?, body_text),
            models_json = COALESCE(?, models_json),
            cost_usd = COALESCE(?, cost_usd),
            prompt_version = COALESCE(prompt_version, ?),
            aggregate_status = ?,
            updated_at = ?
           WHERE edition_id = ?`,
        ).run(
          body,
          models ? JSON.stringify(models) : null,
          entry.generation?.cost ?? null,
          entry.generation?.promptVersions?.editor?.versionId || promptVersion || null,
          status,
          now.toISOString(),
          editionId,
        );
      }

      const mediaActual = inferMediaActual(entry);
      const mediaPlanned = entry.expectedMedia || entry.image?.plannedKind || null;
      upsertPostFeatures(db, {
        editionId,
        projectId,
        format: project.format,
        topic: entry.generation?.title || entry.generation?.quoteId || null,
        bodyText: body,
        mediaPlanned,
        mediaActual,
        slotKey: entry.slot,
        models,
        experimentVariant: entry.experimentVariant || null,
        promptVersionId: entry.generation?.promptVersions?.editor?.versionId || null,
        publishedAt: entry.sentAt || entry.vkSentAt || null,
        now,
      });

      const plan = destinationId
        ? db
            .prepare(
              'SELECT plan_id FROM schedule_slots WHERE project_id = ? AND destination_id = ? AND slot_key = ? LIMIT 1',
            )
            .get(projectId, destinationId, entry.slot)
        : null;
      if (plan) {
        db.prepare(
          `UPDATE schedule_slots SET edition_id = ?, plan_status = ?, updated_at = ? WHERE plan_id = ?`,
        ).run(
          editionId,
          ['sent', 'failed', 'exhausted', 'uncertain'].includes(status) ? status : 'generating',
          now.toISOString(),
          plan.plan_id,
        );
      }

      const externalId =
        entry.vkPostId != null
          ? String(entry.vkPostId)
          : entry.messageId != null
            ? String(entry.messageId)
            : null;
      const existingDelivery = db
        .prepare('SELECT delivery_id FROM deliveries WHERE delivery_id = ?')
        .get(deliveryId);
      const deliveryRow = {
        deliveryId,
        editionId,
        projectId,
        destinationId,
        platform: entry.platform || 'vk',
        status,
        postId: entry.postId || null,
        externalId,
        vkGroupId: entry.vkGroupId || null,
        retryAt: entry.retryAt || null,
        failureReason: entry.reason || null,
        attempts: entry.attempts || 0,
        sentAt: entry.sentAt || entry.vkSentAt || null,
        createdAt: entry.createdAt || now.toISOString(),
      };
      if (!existingDelivery) {
        db.prepare(
          `INSERT INTO deliveries (
            delivery_id, edition_id, project_id, destination_id, platform, status,
            post_id, external_id, vk_group_id, retry_at, failure_reason, attempts,
            sent_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          deliveryRow.deliveryId,
          deliveryRow.editionId,
          deliveryRow.projectId,
          deliveryRow.destinationId,
          deliveryRow.platform,
          deliveryRow.status,
          deliveryRow.postId,
          deliveryRow.externalId,
          deliveryRow.vkGroupId,
          deliveryRow.retryAt,
          deliveryRow.failureReason,
          deliveryRow.attempts,
          deliveryRow.sentAt,
          deliveryRow.createdAt,
          now.toISOString(),
        );
        deliveries += 1;
      } else {
        db.prepare(
          `UPDATE deliveries SET
            status = ?, post_id = ?, external_id = ?, vk_group_id = COALESCE(?, vk_group_id), retry_at = ?, failure_reason = ?,
            attempts = ?, sent_at = ?, updated_at = ?
           WHERE delivery_id = ?`,
        ).run(
          deliveryRow.status,
          deliveryRow.postId,
          deliveryRow.externalId,
          deliveryRow.vkGroupId,
          deliveryRow.retryAt,
          deliveryRow.failureReason,
          deliveryRow.attempts,
          deliveryRow.sentAt,
          now.toISOString(),
          deliveryRow.deliveryId,
        );
      }

      for (const event of entry.errors || []) {
        recordEvent(db, projectId, editionId, deliveryId, event, now);
        recordIncident(db, projectId, editionId, destinationId, event, now);
      }

      const deliveryRows = db
        .prepare('SELECT status, failure_reason FROM deliveries WHERE edition_id = ?')
        .all(editionId);
      const hasDelivery = deliveryRows.some((row) => row.failure_reason !== 'generation_exhausted');
      const deliveryStatuses = deliveryRows
        .filter((row) => !hasDelivery || row.failure_reason !== 'generation_exhausted')
        .map((row) => row.status);
      const aggregate = aggregateEditionStatus(
        deliveryStatuses.length ? deliveryStatuses : [status],
      );
      db.prepare(
        'UPDATE editions SET aggregate_status = ?, updated_at = ? WHERE edition_id = ?',
      ).run(aggregate, now.toISOString(), editionId);
    }

    setSchedulerMeta(db, raw, now);
    bumpDataVersion(db);
    return { editions, deliveries };
  });
}

function resolveConfigRoot(env) {
  return resolve(env.BOT_CONFIG_PATH || 'bot/service.json', '..');
}

function setSchedulerMeta(db, state, now) {
  setMeta(db, 'scheduler_last_seen_at', now.toISOString());
  const pauses = Object.keys(state.pauses || {});
  const cooldowns = Object.entries(state.cooldowns || {})
    .filter(([, until]) => Number.isFinite(Date.parse(until)))
    .map(([platform, until]) => ({ platform, until }));
  setMeta(db, 'scheduler_pauses_json', JSON.stringify(state.pauses || {}));
  setMeta(db, 'scheduler_cooldowns_json', JSON.stringify(cooldowns));
  if (pauses.length) setMeta(db, 'scheduler_paused', '1');
  else setMeta(db, 'scheduler_paused', '0');
}

function recordEvent(db, projectId, editionId, deliveryId, event, now) {
  const eventId =
    event.logId ||
    createHash('sha256')
      .update(
        JSON.stringify({
          projectId,
          editionId,
          deliveryId,
          reason: event.reason,
          code: event.errorCode,
          attempts: event.attempts,
        }),
      )
      .digest('hex')
      .slice(0, 32);
  if (db.prepare('SELECT 1 AS ok FROM events WHERE event_id = ?').get(eventId)) return;
  db.prepare(
    `INSERT INTO events (
      event_id, project_id, edition_id, delivery_id, stage, code, message, attempt, recovery, retry_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    eventId,
    projectId,
    editionId,
    deliveryId,
    event.platform || 'delivery',
    event.errorCode != null ? String(event.errorCode) : null,
    event.reason || event.status || 'error',
    event.attempts ?? null,
    event.postingContinues ? 'continue' : 'inspect',
    event.retryAt || null,
    now.toISOString(),
  );
}

function recordIncident(db, projectId, editionId, destinationId, event, now) {
  const fingerprint = `${event.platform || 'unknown'}:${event.reason || event.status}:${event.errorCode || ''}`;
  const open = db
    .prepare(
      `SELECT incident_id, count FROM incidents WHERE project_id = ? AND fingerprint = ? AND status = 'open'`,
    )
    .get(projectId, fingerprint);
  if (open) {
    db.prepare(
      `UPDATE incidents SET last_seen_at = ?, edition_id = ?, destination_id = ?, message = ? WHERE incident_id = ?`,
    ).run(
      now.toISOString(),
      editionId,
      destinationId,
      event.reason || event.status || 'error',
      open.incident_id,
    );
    return;
  }
  db.prepare(
    `INSERT INTO incidents (
      incident_id, project_id, fingerprint, stage, code, message, status, count,
      edition_id, destination_id, recovery, next_retry_at, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'open', 1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    projectId,
    fingerprint,
    event.platform || 'delivery',
    event.errorCode != null ? String(event.errorCode) : null,
    event.reason || event.status || 'error',
    editionId,
    destinationId,
    event.postingContinues ? 'continue' : 'inspect',
    event.retryAt || null,
    now.toISOString(),
    now.toISOString(),
  );
}

export async function cabinetTick(db, service, env, now = new Date()) {
  materializeScheduleSlots(db, service, env, now);
  if (env.BOT_REDIS_URL) {
    try {
      await bootstrapRedisSchedule(service, { db, env, now });
    } catch (error) {
      console.error(`Redis schedule bootstrap failed: ${error.message}`);
    }
  }
  const results = {};
  for (const projectId of Object.keys(service.projects || {})) {
    if (!service.projects[projectId].enabled) continue;
    try {
      results[projectId] = await syncProjectState(db, service, projectId, env, now);
    } catch (error) {
      if (error.code === 'ENOENT') results[projectId] = { skipped: true };
      else throw error;
    }
  }
  materializeBatches(db, service, now);
  await runReportWorker(db, service, env, now);
  try {
    runAnalyticsCleanup(db, { now });
  } catch (error) {
    console.error(`Analytics cleanup failed: ${error.message}`);
  }
  try {
    for (const projectId of Object.keys(service.projects || {})) {
      if (!service.projects[projectId].enabled) continue;
      syncEditorialMemory(db, { projectId, now });
    }
    await runEditorialScheduler(db, service, env, now);
  } catch (error) {
    console.error(`Editorial scheduler failed: ${error.message}`);
  }
  return results;
}
