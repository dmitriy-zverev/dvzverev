import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function workspace(page: Page, invalid = false, anomalies = false) {
  let commits = 0;
  let confirmed = false;
  let observedAt = '';
  await page.route('**/bot/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { items: [], series: [] };
    if (path.endsWith('/auth/session')) body = { authenticated: true };
    if (path.endsWith('/vk/legacy/status'))
      body = {
        connected: true,
        userId: 83357715,
        expiresAt: '2026-10-07T13:00:00Z',
        refreshAvailable: false,
        canPrepare: true,
        grantedScope: 'wall photos groups',
      };
    if (path.endsWith('/overview'))
      body = {
        week: { start: '2026-10-05', end: '2026-10-11', timezone: 'Europe/Moscow' },
        projects: [{ id: 'example', title: 'Конэсанс' }],
        summary: {},
        days: [],
        cards: [],
        data_version: 1,
        as_of: '2026-10-07T07:00:00Z',
        scheduler_last_seen_at: '2026-10-07T07:00:00Z',
        service: {
          heartbeat: { ok: true, updatedAt: '2026-10-07T07:00:00Z', ageSeconds: 10 },
          reports: { mode: 'scheduled', pending: 2, failed: 0 },
        },
      };
    if (path.endsWith('/analytics'))
      body = {
        coverage: { sent: 10, withMetrics: 8, ratio: 0.8 },
        summary: { organicReach: { median: 140 }, engagementRate: { median: 0.05 } },
        top: [{ editionId: 'sample', reachOrganic: 240 }],
        bottom: [],
      };
    if (path.endsWith('/analytics/posts'))
      body = {
        total: 1,
        items: [
          {
            projectId: 'example',
            bodyText: 'Память о том, чего уже нет',
            publishedAt: '2026-10-07T07:00:00Z',
            vkUrl: 'https://vk.ru/wall-123_1',
            metrics: { reachOrganic: 240 },
            derived: { engagement: { value: 0.05 } },
          },
        ],
      };
    if (path.endsWith('/analytics/segments'))
      body = {
        segments: {
          byTopic: [
            { key: 'example', posts: 10, coverageRatio: 0.8, organicReach: { median: 140 } },
          ],
        },
      };
    if (path.endsWith('/editorial'))
      body = {
        memoryCount: 2,
        seriesCount: 0,
        pilotStats: {},
        revisions: [],
        latestRevision: null,
      };
    if (path.endsWith('/analysis-jobs'))
      return route.fulfill({ status: 503, json: { message: 'Сервис временно недоступен' } });
    if (path.endsWith('/imports/preview')) {
      observedAt = route.request().postDataJSON().observedAt;
      body = {
        importId: 'test',
        matchedCount: 1,
        preview: {
          validCount: 1,
          errorCount: invalid ? 1 : 0,
          canCommitStrict: !invalid,
          anomalyCount: anomalies ? 1 : 0,
        },
      };
    }
    if (path.endsWith('/commit')) {
      commits++;
      confirmed = route.request().postDataJSON().confirmAnomalies;
      return route.fulfill({ status: 503, json: { message: 'Попробуйте позже' } });
    }
    await route.fulfill({ json: body });
  });
  return { commits: () => commits, confirmed: () => confirmed, observedAt: () => observedAt };
}

test('analytics navigation makes one request and preserves percentage and unknown metrics', async ({
  page,
}) => {
  await workspace(page);
  let overviewRequests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/overview')) overviewRequests++;
  });
  await page.goto('/bot/?tab=analytics&project=example');
  await expect(page.locator('.week-kpi-value').nth(1)).toHaveText('5.0%');
  await expect(page.locator('.week-kpi-value').nth(2)).toHaveText('—');
  const before = overviewRequests;
  await page.getByRole('button', { name: 'Все посты', exact: true }).click();
  await expect(page.locator('.post-source')).toHaveAttribute('href', 'https://vk.ru/wall-123_1');
  expect(overviewRequests - before).toBe(1);
  await expect(page.locator('.posts-pagination')).toBeVisible();
});

test('VK login is visible and service shows verified legacy rights and actual refresh limitation', async ({
  page,
}) => {
  await workspace(page);
  await page.goto('/bot/?tab=service');
  await expect(page.locator('.cabinet-header .vk-login')).toHaveText('Переподключить VK');
  await expect(page.locator('.cabinet-header .vk-login')).toHaveAttribute(
    'href',
    /\/vk\/legacy\/login$/,
  );
  await expect(page.locator('.vk-connection')).toContainText(
    'Для обновления токена нужен повторный вход',
  );
  await expect(page.locator('.vk-connection')).toContainText(
    'Права wall, photos и groups проверены',
  );
});

for (const width of [375, 1280]) {
  test(`all workspace tabs fit and remain accessible at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await workspace(page);
    for (const tab of [
      'editorial',
      'analytics',
      'analytics-posts',
      'analytics-imports',
      'analytics-segments',
      'analytics-prompts',
      'incidents',
      'service',
    ]) {
      await page.goto(`/bot/?tab=${tab}&project=example`);
      await expect(page.locator('.cabinet--workspace')).toBeVisible();
      if (process.env.CABINET_SCREENSHOTS)
        await page.screenshot({
          path: `${process.env.CABINET_SCREENSHOTS}/${tab}-${width}.png`,
          fullPage: true,
        });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const result = await new AxeBuilder({ page }).include('#app').analyze();
      expect(result.violations).toEqual([]);
    }
    expect(errors).toEqual([]);
  });
}

test('import draft and selected file survive refresh, invalid preview cannot commit', async ({
  page,
}) => {
  await workspace(page, true);
  await page.goto('/bot/?tab=analytics-imports&project=example');
  await page.locator('[name="vkGroupId"]').fill('123');
  await page.locator('[name="observedAt"]').fill('2026-10-07T10:00');
  await page.locator('[name="file"]').setInputFiles({
    name: 'stats.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('post_id,views\n1,10'),
  });
  await page.locator('#refresh').click();
  await expect(page.locator('[name="vkGroupId"]')).toHaveValue('123');
  expect(
    await page.locator('[name="file"]').evaluate((node: HTMLInputElement) => node.files?.[0]?.name),
  ).toBe('stats.csv');
  await page.locator('#import-form [type="submit"]').click();
  await expect(page.locator('#import-commit')).toBeDisabled();
});

test('anomalies need explicit consent; commit and analysis errors recover inline', async ({
  page,
}) => {
  const mock = await workspace(page, false, true);
  await page.goto('/bot/?tab=analytics-imports&project=example');
  await page.locator('[name="vkGroupId"]').fill('123');
  await page.locator('[name="observedAt"]').fill('2026-10-07T10:00');
  await page.locator('[name="file"]').setInputFiles({
    name: 'stats.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('post_id,views\n1,10'),
  });
  await page.locator('#import-form [type="submit"]').click();
  await expect(page.locator('#import-commit')).toBeDisabled();
  await page.locator('#confirm-anomalies').check();
  await page.locator('#import-commit').click();
  await expect(page.locator('#import-feedback')).toContainText('Не удалось');
  await expect(page.locator('#import-commit')).toBeEnabled();
  expect(mock.commits()).toBe(1);
  expect(mock.confirmed()).toBe(true);
  expect(mock.observedAt()).toBe('2026-10-07T07:00:00.000Z');
  await page.goto('/bot/?tab=analytics-prompts&project=example');
  await page.locator('#run-analysis').click();
  await expect(page.locator('#analytics-feedback')).toContainText('Не удалось');
  await expect(page.locator('#run-analysis')).toBeEnabled();
});

test('header styles remain consistent between tabs at every breakpoint', async ({ page }) => {
  await workspace(page);
  for (const width of [320, 768, 1280, 1465, 1626]) {
    await page.setViewportSize({ width, height: 900 });
    let baseline: unknown;
    for (const tab of ['', 'editorial', 'analytics', 'incidents', 'service']) {
      await page.goto(`/bot/?tab=${tab}`);
      await expect(page.locator('.cabinet-header')).toBeVisible();
      const styles = await page.locator('.cabinet-header').evaluate((header) => {
        const shell = getComputedStyle(header.querySelector('.cabinet-header-shell')!);
        const button = getComputedStyle(header.querySelector('.cabinet-tab')!);
        return {
          display: shell.display,
          areas: shell.gridTemplateAreas,
          font: button.fontSize,
          padding: button.padding,
          radius: button.borderRadius,
          minHeight: button.minHeight,
        };
      });
      if (!tab) baseline = styles;
      else expect(styles).toEqual(baseline);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      const overlaps = await page.locator('.cabinet-header-shell').evaluate((shell) => {
        const rects = Array.from(shell.children).map((node) => node.getBoundingClientRect());
        return rects.some((a, i) =>
          rects
            .slice(i + 1)
            .some(
              (b) =>
                Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
                Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1,
            ),
        );
      });
      expect(overlaps).toBe(false);
    }
  }
});
