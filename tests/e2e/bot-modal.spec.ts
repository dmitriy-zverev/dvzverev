import { test, expect, type Page } from '@playwright/test';

async function cabinet(page: Page) {
  let refreshes = 0;
  let errorStatus = 0;
  await page.clock.install();
  await page.route('**/bot/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const headers = {
      'Access-Control-Allow-Origin': new URL(page.url()).origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,PATCH,OPTIONS',
    };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    let body: unknown = { items: [] };
    if (url.pathname.endsWith('/auth/session')) body = { authenticated: true };
    if (url.pathname.endsWith('/overview')) {
      refreshes++;
      if (errorStatus)
        return route.fulfill({ status: errorStatus, headers, json: { error: 'unavailable' } });
      const cards = Array.from({ length: 24 }, (_, index) => ({
        planId: `plan-${index}`,
        editionId: index === 1 ? 'edition-1' : null,
        projectId: 'example',
        projectTitle: 'Конэсанс',
        destinationId: 'connaissance-vk',
        destinationTitle: 'VK',
        date: '2026-10-07',
        time: '18:00',
        slotUtc: '2026-10-07T15:00:00Z',
        publicationKind: 'text',
        status: 'planned',
        statusLabel: 'Запланирован',
        topic: 'Новая тема',
        topicLabel: 'Новая тема',
        version: 1,
      }));
      body = {
        week: { start: '2026-10-05', end: '2026-10-11', timezone: 'Europe/Moscow' },
        projects: [],
        summary: {
          materials: 24,
          planned: 24,
          sent: 0,
          missed: 0,
          failed: 0,
          delayed: 0,
          readying: 0,
          uncertain: 0,
        },
        deliverySummary: {},
        days: [{ date: '2026-10-07', cards }],
        cards,
        data_version: refreshes,
        service: { heartbeat: { ok: true }, stale: false },
        as_of: '2026-10-07T07:00:00Z',
      };
    }
    if (url.pathname.includes('/editions/'))
      body = {
        edition: {
          statusLabel: 'Опубликован',
          bodyText: 'Длинный текст публикации.\n\n'.repeat(80),
        },
        deliveries: [],
        events: [],
      };
    await route.fulfill({ headers, json: body });
  });
  await page.goto('/bot/');
  await expect(page.locator('.slot')).toHaveCount(24);
  return {
    refreshes: () => refreshes,
    fail: (status: number) => {
      errorStatus = status;
    },
  };
}

test('automatic refresh preserves the open task and draft; closing restores real scrolling', async ({
  page,
}) => {
  const mock = await cabinet(page);
  await page.locator('.slot').first().click();
  await page.locator('#plan-topic').fill('Несохранённая тема');
  await page.clock.runFor(31000);
  await expect.poll(mock.refreshes).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#modal')).toBeVisible();
  await expect(page.locator('#plan-topic')).toHaveValue('Несохранённая тема');
  await expect(page.locator('#plan-topic')).toBeFocused();
  await page.locator('#modal-close').click();
  await expect(page.locator('body')).not.toHaveClass(/modal-open/);
  await page.mouse.wheel(0, 700);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.locator('.slot').first().click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#modal')).toBeHidden();
  await expect(page.locator('body')).not.toHaveClass(/modal-open/);
});

test('refresh failure keeps the draft, and session expiry releases the scroll lock', async ({
  page,
}) => {
  const mock = await cabinet(page);
  await page.locator('.slot').first().click();
  await page.locator('#plan-brief').fill('Важный черновик');
  mock.fail(503);
  await page.clock.runFor(31000);
  await expect.poll(mock.refreshes).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#modal')).toBeVisible();
  await expect(page.locator('#plan-brief')).toHaveValue('Важный черновик');
  mock.fail(401);
  await page.clock.runFor(61000);
  await expect(page.locator('#modal')).toHaveCount(0);
  await expect(page.locator('body')).not.toHaveClass(/modal-open/);
  await expect.poll(() => page.evaluate(() => document.body.style.paddingRight)).toBe('');
});

test('long task content scrolls inside the dialog and retains its position on refresh', async ({
  page,
}) => {
  const mock = await cabinet(page);
  await page.locator('.slot').nth(1).click();
  await expect(page.locator('.modal-post-text')).toBeVisible();
  await page.locator('#modal-body').hover();
  await page.mouse.wheel(0, 500);
  await expect
    .poll(() => page.locator('#modal-body').evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  const before = await page.locator('#modal-body').evaluate((element) => element.scrollTop);
  await page.clock.runFor(31000);
  await expect.poll(mock.refreshes).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#modal')).toBeVisible();
  await expect
    .poll(() => page.locator('#modal-body').evaluate((element) => element.scrollTop))
    .toBe(before);
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).not.toHaveClass(/modal-open/);
});
