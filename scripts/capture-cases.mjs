import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
await mkdir('public/cases', { recursive: true });
const browser = await chromium.launch();
try {
  for (const [id, url] of [
    ['sniper-search', 'https://sniper-search.ru/'],
    ['reppi', 'https://reppy.ru/'],
    ['mayak', 'https://mayakpulse.ru/'],
    ['recall', 'https://recall.dvzverev.ru/'],
  ]) {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 780 },
      deviceScaleFactor: 1,
    });
    try {
      const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 });
      console.log(id, response?.status(), (await page.locator('body').innerText()).slice(0, 14000));
      for (const name of ['Только необходимые', 'Без аналитики']) {
        const button = page.getByRole('button', { name, exact: true });
        if (await button.count()) await button.first().click();
      }
      await page.screenshot({
        path: `public/cases/${id}.jpg`,
        type: 'jpeg',
        quality: 75,
        animations: 'disabled',
      });
    } catch (error) {
      console.log(id, String(error));
    }
    await page.close();
  }
} finally {
  await browser.close();
}
