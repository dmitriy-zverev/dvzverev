/** Compact task document stored in Redis (JSON). */
export function encodeTask(task) {
  return JSON.stringify({
    i: task.id,
    p: task.projectId,
    d: task.destinationId,
    pl: task.platform,
    u: task.slotUtc,
    k: task.slotKey,
    t: task.topic ?? null,
    b: task.brief ?? null,
    v: task.version ?? 1,
    s: task.status ?? 'planned',
    pk: task.publicationKind ?? 'text',
    m: task.expectedMedia ?? null,
    a: task.adHoc ? 1 : 0,
    w: task.weekStart,
  });
}

export function decodeTask(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed?.i || !parsed?.p || !parsed?.d || !parsed?.u) return null;
  return {
    id: parsed.i,
    projectId: parsed.p,
    destinationId: parsed.d,
    platform: parsed.pl || 'vk',
    slotUtc: parsed.u,
    slotKey: parsed.k,
    topic: parsed.t ?? null,
    brief: parsed.b ?? null,
    version: Number(parsed.v) || 1,
    status: parsed.s || 'planned',
    publicationKind: parsed.pk || 'text',
    expectedMedia: parsed.m ?? null,
    adHoc: parsed.a === 1,
    weekStart: parsed.w,
  };
}
