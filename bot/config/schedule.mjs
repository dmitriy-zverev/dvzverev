const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function parseScheduleTime(time) {
  if (!TIME_PATTERN.test(time)) throw new Error(`Invalid schedule time: ${time}`);
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

export function validateTimezone(timezone) {
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
}

export function scheduleConflicts(service, minIntervalMinutes = 0) {
  const issues = [];
  const byDestination = new Map();

  for (const [projectId, project] of Object.entries(service.projects)) {
    if (!project.enabled) continue;
    const timezone = project.schedule?.timezone;
    try {
      validateTimezone(timezone);
    } catch {
      issues.push({ kind: 'invalid_timezone', projectId, timezone });
      continue;
    }
    const times = project.schedule?.times || [];
    const unique = new Set(times);
    if (unique.size !== times.length) {
      issues.push({ kind: 'duplicate_times', projectId });
    }
    for (const time of times) {
      try {
        parseScheduleTime(time);
      } catch {
        issues.push({ kind: 'invalid_time', projectId, time });
      }
    }
    for (const destinationId of project.delivery?.destinations || []) {
      const bucketKey = `${destinationId}@${timezone}`;
      const bucket = byDestination.get(bucketKey) || [];
      bucket.push({ projectId, timezone, destinationId, times: [...unique] });
      byDestination.set(bucketKey, bucket);
    }
  }

  for (const [, entries] of byDestination) {
    const destinationId = entries[0]?.destinationId;
    if (!destinationId) continue;
    const slots = [];
    for (const entry of entries) {
      for (const time of entry.times) {
        slots.push({ destinationId, projectId: entry.projectId, minute: parseScheduleTime(time) });
      }
    }
    slots.sort((a, b) => a.minute - b.minute);
    const dayMinutes = 24 * 60;
    const gaps = [];
    for (let index = 1; index < slots.length; index += 1) {
      gaps.push(slots[index].minute - slots[index - 1].minute);
    }
    if (slots.length > 1) {
      gaps.push(dayMinutes - slots[slots.length - 1].minute + slots[0].minute);
    }
    for (const gap of gaps) {
      if (gap < minIntervalMinutes) {
        issues.push({
          kind: 'destination_interval',
          destinationId,
          minIntervalMinutes,
        });
        break;
      }
    }
  }

  return issues;
}
