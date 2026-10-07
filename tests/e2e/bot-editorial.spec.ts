import { test, expect } from '@playwright/test';

for (const width of [375, 1280]) {
  test(`editorial errors recover and layout fits ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    let requests = 0;
    await page.route('**/bot/api/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown = { items: [], series: [] };
      if (path.endsWith('/auth/session')) body = { authenticated: true };
      if (path.endsWith('/overview'))
        body = {
          week: { start: '2026-10-05', end: '2026-10-11', timezone: 'Europe/Moscow' },
          projects: [{ id: 'dark-academia', title: 'Конэсанс' }],
          summary: {},
          days: [],
          cards: [],
          data_version: 1,
          service: { heartbeat: { ok: true } },
        };
      if (path.endsWith('/editorial'))
        body = {
          memoryCount: 2,
          seriesCount: 0,
          pilotStats: {},
          revisions: [],
          latestRevision: null,
        };
      if (path.endsWith('/editorial/jobs') && route.request().method() === 'POST') {
        requests++;
        await new Promise((resolve) => setTimeout(resolve, 150));
        return route.fulfill({ status: 503, json: { error: 'service_unavailable' } });
      }
      await route.fulfill({ json: body });
    });
    await page.goto('/bot/?tab=editorial&project=dark-academia');
    const button = page.locator('#editorial-run-job');
    await expect(button).toBeVisible();
    await button.click();
    await expect(button).toBeDisabled();
    await expect(page.locator('#editorial-feedback')).toContainText(
      'Не удалось выполнить действие',
    );
    await expect(button).toBeEnabled();
    expect(requests).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
