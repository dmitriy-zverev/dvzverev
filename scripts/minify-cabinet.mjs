import { createRequire } from 'node:module';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Reuse the esbuild version supplied by Astro's build toolchain.
const require = createRequire(import.meta.url);
const astroRequire = createRequire(require.resolve('astro/package.json'));
const { transform } = astroRequire('esbuild');
const directory = 'dist/bot';
const files = (await readdir(directory)).filter((name) => name.endsWith('.js'));

for (const name of files) {
  const path = join(directory, name);
  const source = await readFile(path, 'utf8');
  const result = await transform(source, {
    minify: true,
    charset: 'utf8',
    format: 'esm',
    target: 'es2022',
    legalComments: 'eof',
  });
  await writeFile(path, result.code);
}

console.log(`Minified ${files.length} cabinet modules in ${directory}`);
