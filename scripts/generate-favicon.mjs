import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'public/favicon.svg'), 'utf8');
const encoded = `data:image/svg+xml,${encodeURIComponent(svg)}`;

async function renderPng(canvasSize, markSize) {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: canvasSize, height: canvasSize },
    deviceScaleFactor: 1,
  });

  await page.setContent(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <style>
      html,
      body {
        margin: 0;
        width: ${canvasSize}px;
        height: ${canvasSize}px;
        background: #101722;
      }
      body {
        display: grid;
        place-items: center;
      }
      img {
        display: block;
        width: ${markSize}px;
        height: ${markSize}px;
        image-rendering: pixelated;
      }
    </style>
  </head>
  <body>
    <img src="${encoded}" alt="" />
  </body>
</html>`);

  const buffer = await page.screenshot({ type: 'png' });
  await browser.close();
  return buffer;
}

const favicon32 = await renderPng(32, 32);
writeFileSync(join(root, 'public/favicon.ico'), favicon32);

const appleTouch = await renderPng(180, 160);
writeFileSync(join(root, 'public/apple-touch-icon.png'), appleTouch);

console.log('Wrote public/favicon.ico and public/apple-touch-icon.png');
