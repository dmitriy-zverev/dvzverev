import { expect, test, type Page, type Locator } from '@playwright/test';

async function advanceUntil(page: Page, locator: Locator, text: string) {
  for (let step = 0; step < 250; step++) {
    if ((await locator.textContent())?.includes(text)) return;
    await page.clock.runFor(100);
  }
  await expect(locator).toContainText(text);
}

test('coding demo types, reports an error, fixes it and switches projects', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.clock.install();
  await page.goto('/');
  await page.clock.runFor(200);
  await expect(page.locator('[data-terminal-status]')).toHaveText('Пишу обработчик');
  await advanceUntil(page, page.locator('[data-terminal-logs]'), 'F821');
  await expect(page.locator('[data-terminal-logs]')).toContainText('F821');
  await advanceUntil(page, page.locator('[data-terminal-logs]'), '201');
  await expect(page.locator('[data-terminal-logs]')).toContainText('201');
  await advanceUntil(page, page.locator('[data-terminal-file]'), 'bot.py');
  await expect(page.locator('[data-terminal-file]')).toHaveText('bot.py');
  await page.getByRole('button', { name: 'Приостановить анимацию кода' }).click();
  const code = await page.locator('[data-terminal-code]').textContent();
  await page.clock.runFor(2000);
  await expect(page.locator('[data-terminal-code]')).toHaveText(code!);
});

test('reduced motion shows a complete static example', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('[data-terminal-code]')).toContainText('from uuid import uuid4');
  await expect(page.locator('[data-terminal-status]')).toHaveText('API готов');
  await expect(page.locator('[data-terminal-pause]')).toBeHidden();
});
