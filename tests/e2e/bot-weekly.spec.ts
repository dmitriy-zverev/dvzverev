import { test, expect } from '@playwright/test';

test('week view has no week-ahead preparation', async ({ page }) => {
  await page.route('**/bot/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: Record<string, unknown> = {};
    if (path.endsWith('/auth/session')) body = { authenticated: true };
    if (path.endsWith('/incidents')) body = { items: [] };
    if (path.endsWith('/vk/legacy/status')) body = { connected: true, canPrepare: true };
    if (path.endsWith('/overview'))
      body = {
        week: { start: '2026-10-12', end: '2026-10-18', timezone: 'Europe/Moscow' },
        projects: [],
        summary: { materials: 0, planned: 0, sent: 0, missed: 0 },
        deliverySummary: { materials: 0, sent: 0, delayed: 0, failed: 0, uncertain: 0 },
        days: [],
        cards: [],
        data_version: 1,
        service: {},
      };
    await route.fulfill({ json: body });
  });
  await page.goto('/bot/');
  await expect(page.locator('.weekly-prepare')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Подготовить посты/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Сегодня' })).toBeVisible();
});
