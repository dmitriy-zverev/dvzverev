import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';

const dist = 'dist';
const bannedPatterns = [
  /from\s+["']react["']/i,
  /from\s+["']react-dom["']/i,
  /from\s+["']gsap["']/i,
  /require\(\s*["']react["']\s*\)/i,
  /require\(\s*["']gsap["']\s*\)/i,
];

function walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
      continue;
    }

    if (fullPath.endsWith('.js')) {
      files.push(fullPath);
    }
  }

  return files;
}

for (const file of walk(dist)) {
  const content = readFileSync(file, 'utf8');
  for (const pattern of bannedPatterns) {
    if (pattern.test(content)) {
      console.error(`Banned runtime import found in ${file}`);
      process.exit(1);
    }
  }
}

console.log('bundle check passed');
