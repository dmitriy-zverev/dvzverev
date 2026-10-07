import { findPhraseRepeats } from './phrases.mjs';
import { PROJECT_RULES } from './vocab.mjs';

export function analyzeDiversity(memoryRows, { projectId } = {}) {
  const entries = memoryRows.map(normalizeMemoryRow);
  const authors = countBy(entries.map((e) => e.author).filter(Boolean));
  const tones = countBy(entries.map((e) => e.tone || 'unknown'));
  const structures = countBy(entries.map((e) => e.structure || 'unknown'));
  const rubrics = countBy(entries.map((e) => e.rubricId || 'unknown'));
  const phrases = findPhraseRepeats(entries);
  const heavyShare = share(tones, 'heavy');
  const rules = PROJECT_RULES[projectId] || null;

  const findings = [];
  if (phrases.repeatedOpenings.length) {
    findings.push({
      kind: 'repeat_opening',
      label: 'Повторяющиеся заходы',
      evidenceKind: 'editorial_hypothesis',
      items: phrases.repeatedOpenings,
    });
  }
  if (phrases.repeatedClosings.length) {
    findings.push({
      kind: 'repeat_closing',
      label: 'Повторяющиеся концовки',
      evidenceKind: 'editorial_hypothesis',
      items: phrases.repeatedClosings,
    });
  }
  if (projectId === 'dark-academia' && topShare(authors) >= 0.4 && entries.length >= 5) {
    findings.push({
      kind: 'author_concentration',
      label: 'Автор повторяется слишком часто',
      evidenceKind: 'editorial_hypothesis',
      authors: topEntries(authors, 3),
    });
  }
  if (projectId === 'dark-academia' && heavyShare >= 0.6 && entries.length >= 4) {
    findings.push({
      kind: 'heavy_tone_dominance',
      label: 'Слишком много тяжёлого тона',
      evidenceKind: 'editorial_hypothesis',
      heavyShare,
    });
  }

  return {
    projectId,
    rules,
    counts: {
      posts: entries.length,
      authors,
      tones,
      structures,
      rubrics,
    },
    phrases,
    findings,
    missingFeatures: entries.filter((e) => e.tone === 'unknown' || e.structure === 'unknown')
      .length,
  };
}

export function authorAlternationOk(historyAuthors, nextAuthor) {
  if (!nextAuthor) return true;
  const recent = historyAuthors.filter(Boolean).slice(-2);
  if (recent.length < 2) return true;
  return !(recent[0] === nextAuthor && recent[1] === nextAuthor);
}

function normalizeMemoryRow(row) {
  return {
    memoryId: row.memory_id || row.memoryId,
    editionId: row.edition_id || row.editionId,
    author: row.author || null,
    tone: row.tone || 'unknown',
    intensity: row.intensity || 'unknown',
    structure: row.structure || 'unknown',
    rubricId: row.rubric_id || row.rubricId || null,
    openingPhrase: row.opening_phrase || row.openingPhrase || '',
    closingPhrase: row.closing_phrase || row.closingPhrase || '',
  };
}

function countBy(values) {
  const map = {};
  for (const value of values) {
    const key = value || 'unknown';
    map[key] = (map[key] || 0) + 1;
  }
  return map;
}

function share(counts, key) {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (!total) return 0;
  return (counts[key] || 0) / total;
}

function topShare(counts) {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (!total) return 0;
  return Math.max(0, ...Object.values(counts)) / total;
}

function topEntries(counts, limit) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}
