import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function setup(page: Page, mode = 'connected') {
  let writes = 0;
  const posts = ['Конэсанс', 'Вещи — кстати'].flatMap((title, index) =>
    Array.from({ length: 7 }, (_, day) => ({
      planId: `${index}-${day}`,
      projectId: `p${index}`,
      title,
      date: `2026-10-${12 + day}T15:00:00Z`,
      status: mode === 'complete' ? 'scheduled' : day === 0 ? 'scheduled' : 'pending',
      url: day === 0 || mode === 'complete' ? `https://vk.ru/wall-123_${index * 10 + day}` : null,
    })),
  );
  const batch = {
    week: { start: '2026-10-12', end: '2026-10-18' },
    posts,
    total: 14,
    ready: mode === 'complete' ? 14 : 2,
    missing: mode === 'complete' ? 0 : 12,
    uncertain: 0,
    running: false,
    complete: mode === 'complete',
    vk: {
      connected: mode !== 'disconnected',
      canPrepare: mode !== 'disconnected',
      available: true,
    },
  };
  await page.route('**/bot/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body = {};
    if (path.endsWith('/auth/session')) body = { authenticated: true };
    if (path.endsWith('/incidents')) body = { items: [] };
    if (path.endsWith('/vk/legacy/status')) body = batch.vk;
    if (path.endsWith('/overview'))
      body = {
        week: { start: '2026-10-05', end: '2026-10-11', timezone: 'Europe/Moscow' },
        projects: [],
        summary: {},
        days: [],
        cards: [],
        data_version: 1,
        service: {},
      };
    if (path.endsWith('/weekly-preparation')) {
      if (route.request().method() === 'POST') {
        writes++;
        batch.running = true;
      }
      body = batch;
    }
    await route.fulfill({ json: body });
  });
  await page.goto('/bot/');
  return () => writes;
}

test('one action prepares only remaining slots and prevents a second click', async ({ page }) => {
  const writes = await setup(page);
  await expect(page.getByRole('heading', { name: '12 октября — 18 октября' })).toBeVisible();
  const action = page.getByRole('button', { name: 'Подготовить посты', exact: true });
  await action.click();
  await expect(page.getByRole('button', { name: 'Подготавливаем посты…' })).toBeDisabled();
  expect(writes()).toBe(1);
  await expect(page.getByText('Можно закрыть страницу — подготовка продолжится')).toBeVisible();
});

test('fully scheduled week is locked and exposes VK receipts', async ({ page }) => {
  const writes = await setup(page, 'complete');
  await expect(page.getByRole('button', { name: 'Неделя подготовлена ✓' })).toBeDisabled();
  await page.getByText('Записи в VK · 14', { exact: true }).click();
  await expect(page.locator('.weekly-links a')).toHaveCount(14);
  expect(writes()).toBe(0);
});

test('disconnected account shows VK login instead of a misleading preparation button', async ({
  page,
}) => {
  await setup(page, 'disconnected');
  await expect(page.locator('.weekly-primary')).toHaveAttribute('href', /\/vk\/legacy\/login$/);
  await expect(page.getByRole('button', { name: /Подготовить посты/ })).toHaveCount(0);
});

test('weekly block fits mobile and has accessible controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
  const results = await new AxeBuilder({ page }).include('.weekly-prepare').analyze();
  expect(results.violations).toEqual([]);
});
