import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';
const TEXT_EXTENSIONS = new Set(['.html', '.css', '.js', '.svg', '.json', '.txt', '.xml']);

function walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
      continue;
    }

    const ext = entry.name.slice(entry.name.lastIndexOf('.'));
    if (TEXT_EXTENSIONS.has(ext)) {
      files.push(fullPath);
    }
  }

  return files;
}

for (const file of walk(DIST)) {
  const source = readFileSync(file);
  writeFileSync(`${file}.br`, brotliCompressSync(source, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }));
  writeFileSync(`${file}.gz`, gzipSync(source, { level: 9 }));
}

console.log(`precompressed ${walk(DIST).length} text assets in ${DIST}`);
