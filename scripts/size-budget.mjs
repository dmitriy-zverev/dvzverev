import { brotliCompressSync, constants } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const budgets = {
  htmlBrotli: 35 * 1024,
  jsBrotli: 30 * 1024,
  cssBrotli: 20 * 1024,
  fonts: 70 * 1024,
};

function walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
      continue;
    }

    files.push(fullPath);
  }

  return files;
}

function size(path) {
  return statSync(path).size;
}

function brotliSize(content) {
  return brotliCompressSync(content, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).length;
}

function inlineStyleBrotliSize(html) {
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)];
  let total = 0;

  for (const match of styles) {
    const body = match[1]?.trim();
    if (!body) {
      continue;
    }

    total += brotliSize(Buffer.from(body, 'utf8'));
  }

  return total;
}

function inlineScriptBrotliSize(html) {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  let total = 0;

  for (const match of scripts) {
    const body = match[1]?.trim();
    if (!body) {
      continue;
    }

    total += brotliSize(Buffer.from(body, 'utf8'));
  }

  return total;
}

const dist = 'dist';
const htmlPath = join(dist, 'index.html.br');
const htmlSize = size(htmlPath);

if (htmlSize > budgets.htmlBrotli) {
  console.error(`HTML brotli budget exceeded: ${htmlSize} > ${budgets.htmlBrotli}`);
  process.exit(1);
}

const jsFiles = walk(dist)
  .filter((file) => file.endsWith('.js.br'))
  .reduce((sum, file) => sum + size(file), 0);
const cssFiles = walk(dist)
  .filter((file) => file.endsWith('.css.br'))
  .reduce((sum, file) => sum + size(file), 0);
const fontTotal = walk(dist)
  .filter((file) => file.endsWith('.woff2'))
  .reduce((sum, file) => sum + size(file), 0);

const html = readFileSync(join(dist, 'index.html'), 'utf8');
const inlineJs = inlineScriptBrotliSize(html);
const inlineCss = inlineStyleBrotliSize(html);
const jsTotal = jsFiles + inlineJs;
const cssTotal = cssFiles + inlineCss;

if (jsTotal > budgets.jsBrotli) {
  console.error(`JS brotli budget exceeded: ${jsTotal} > ${budgets.jsBrotli}`);
  process.exit(1);
}

if (cssTotal > budgets.cssBrotli) {
  console.error(`CSS brotli budget exceeded: ${cssTotal} > ${budgets.cssBrotli}`);
  process.exit(1);
}

if (fontTotal > budgets.fonts) {
  console.error(`Font budget exceeded: ${fontTotal} > ${budgets.fonts}`);
  process.exit(1);
}

if (html.includes('[TBD]')) {
  console.error('Published HTML contains [TBD]');
  process.exit(1);
}

console.log(
  JSON.stringify({
    htmlBrotli: htmlSize,
    jsBrotli: jsTotal,
    inlineJsBrotli: inlineJs,
    inlineCssBrotli: inlineCss,
    cssBrotli: cssTotal,
    fonts: fontTotal,
  }),
);
