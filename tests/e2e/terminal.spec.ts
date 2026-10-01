import { expect, test } from '@playwright/test';

test('coding demo types, reports an error, fixes it and switches projects', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.clock.install();
  await page.goto('/');
  await page.clock.runFor(200);
  await expect(page.locator('[data-terminal-status]')).toHaveText('Пишу обработчик');
  await page.clock.runFor(13500);
  await expect(page.locator('[data-terminal-logs]')).toContainText('F821');
  await page.clock.runFor(4000);
  await expect(page.locator('[data-terminal-logs]')).toContainText('201');
  await page.clock.runFor(5000);
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
