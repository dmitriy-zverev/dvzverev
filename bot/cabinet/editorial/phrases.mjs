const PUNCT_RE = /[«»„"'\-–—.,!?;:()[\]{}]/g;
const SPACE_RE = /\s+/g;

export function normalizePhrase(text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  return text.toLowerCase().replace(PUNCT_RE, ' ').replace(SPACE_RE, ' ').trim().slice(0, 120);
}

export function openingPhrase(bodyText) {
  if (typeof bodyText !== 'string' || !bodyText.trim()) return '';
  const first = bodyText.trim().split(/\n+/)[0] || '';
  return normalizePhrase(first).slice(0, 80);
}

export function closingPhrase(bodyText) {
  if (typeof bodyText !== 'string' || !bodyText.trim()) return '';
  const parts = bodyText.trim().split(/\n+/).filter(Boolean);
  const last = parts[parts.length - 1] || '';
  return normalizePhrase(last).slice(0, 80);
}

export function findPhraseRepeats(entries, { minCount = 2 } = {}) {
  const openings = new Map();
  const closings = new Map();
  for (const entry of entries) {
    if (entry.openingPhrase) {
      openings.set(entry.openingPhrase, (openings.get(entry.openingPhrase) || 0) + 1);
    }
    if (entry.closingPhrase) {
      closings.set(entry.closingPhrase, (closings.get(entry.closingPhrase) || 0) + 1);
    }
  }
  return {
    repeatedOpenings: [...openings.entries()]
      .filter(([, count]) => count >= minCount)
      .map(([phrase, count]) => ({ phrase, count })),
    repeatedClosings: [...closings.entries()]
      .filter(([, count]) => count >= minCount)
      .map(([phrase, count]) => ({ phrase, count })),
  };
}
