import { test, expect } from '@playwright/test';

test.describe('no javascript', () => {
  test.use({ javaScriptEnabled: false });

  test('hero and CTA are visible without JS', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1 })).toContainText('Собираю сайты');
    await expect(page.getByRole('link', { name: /написать/i }).first()).toHaveAttribute(
      'href',
      'https://t.me/zverev_dmitry',
    );
  });
});
