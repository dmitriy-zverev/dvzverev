export function upsertPlanFromRedisTask(db, task, now = new Date().toISOString()) {
  const topicState = task.topic?.trim() ? 'manual' : 'unknown';
  const existing = db.prepare('SELECT plan_id FROM schedule_slots WHERE plan_id = ?').get(task.id);
  if (existing) {
    db.prepare(
      `UPDATE schedule_slots SET topic = ?, brief = ?, topic_state = ?, version = ?, plan_status = ?,
        slot_utc = ?, slot_key = ?, publication_kind = ?, expected_media = ?, updated_at = ?
       WHERE plan_id = ? AND edition_id IS NULL`,
    ).run(
      task.topic,
      task.brief,
      topicState,
      task.version,
      task.status,
      task.slotUtc,
      task.slotKey,
      task.publicationKind,
      task.expectedMedia,
      now,
      task.id,
    );
    return;
  }
  db.prepare(
    `INSERT INTO schedule_slots (
      plan_id, project_id, destination_id, slot_utc, slot_key, publication_kind,
      expected_media, topic, brief, topic_state, plan_status, config_version, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'redis', ?, ?, ?)`,
  ).run(
    task.id,
    task.projectId,
    task.destinationId,
    task.slotUtc,
    task.slotKey,
    task.publicationKind,
    task.expectedMedia,
    task.topic,
    task.brief,
    topicState,
    task.status,
    task.version,
    now,
    now,
  );
}
