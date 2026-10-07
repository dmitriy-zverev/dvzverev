export const AGE_BUCKETS = [
  { id: '1-3', minDays: 1, maxDays: 3 },
  { id: '4-7', minDays: 4, maxDays: 7 },
  { id: '8-14', minDays: 8, maxDays: 14 },
  { id: '15-30', minDays: 15, maxDays: 30 },
];

export function engagementRate(observation) {
  const reach = observation.reach_organic ?? observation.reach_total;
  if (reach == null || reach === 0) {
    return { value: null, reason: reach === 0 ? 'zero_reach' : 'missing_reach' };
  }
  const parts = [
    observation.likes,
    observation.comments,
    observation.reposts,
    observation.saves,
  ];
  if (parts.some((v) => v == null)) {
    return { value: null, reason: 'missing_engagement_parts' };
  }
  return { value: (parts[0] + parts[1] + parts[2] + parts[3]) / reach, reason: null };
}

export function linkCtr(observation, { denominator = 'views' } = {}) {
  const clicks = observation.link_clicks;
  const denom = denominator === 'views' ? observation.views : observation.reach_total;
  if (clicks == null) return { value: null, reason: 'missing_link_clicks', denominator };
  if (denom == null) return { value: null, reason: `missing_${denominator}`, denominator };
  if (denom === 0) return { value: null, reason: `zero_${denominator}`, denominator };
  return { value: clicks / denom, reason: null, denominator };
}

export function reachPerThousandSubscribers(observation) {
  const reach = observation.reach_organic;
  const subs = observation.subscribers_at_publish;
  if (reach == null) return { value: null, reason: 'missing_organic_reach' };
  if (subs == null) return { value: null, reason: 'missing_subscribers' };
  if (subs === 0) return { value: null, reason: 'zero_subscribers' };
  return { value: (reach / subs) * 1000, reason: null };
}

export function costPerThousandReached(observation, costUsd) {
  const reach = observation.reach_organic;
  if (costUsd == null) return { value: null, reason: 'missing_cost' };
  if (reach == null) return { value: null, reason: 'missing_organic_reach' };
  if (reach === 0) return { value: null, reason: 'zero_organic_reach' };
  return { value: (costUsd / reach) * 1000, reason: null };
}

export function observationAgeDays(publishedAt, observedAt) {
  if (!publishedAt || !observedAt) return null;
  const ms = Date.parse(observedAt) - Date.parse(publishedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms / (24 * 60 * 60 * 1000);
}

export function ageBucketId(ageDays) {
  if (ageDays == null) return null;
  for (const bucket of AGE_BUCKETS) {
    if (ageDays >= bucket.minDays && ageDays <= bucket.maxDays) return bucket.id;
  }
  if (ageDays < 1) return '0-1';
  return '30+';
}

export function isD7Comparable(ageDays) {
  return ageDays != null && ageDays >= 6 && ageDays <= 8;
}

export function median(values) {
  const nums = values.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

export function spread(values) {
  const nums = values.filter((v) => v != null && Number.isFinite(v));
  if (!nums.length) return { min: null, max: null, median: null, count: 0 };
  return {
    min: Math.min(...nums),
    max: Math.max(...nums),
    median: median(nums),
    count: nums.length,
  };
}

export function completeness(observation, fields) {
  const present = fields.filter((f) => observation[f] != null).length;
  return {
    present,
    required: fields.length,
    ratio: fields.length ? present / fields.length : null,
  };
}
