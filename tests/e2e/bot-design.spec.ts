import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { legacyCallbackPage } from '../../bot/vk-oauth/legacy.mjs';
import { oauthStatusPage } from '../../bot/vk-oauth/pages.mjs';

const projects = [
  { id: 'things', title: 'Вещи — кстати' },
  { id: 'code', title: 'Код на подумать' },
];
const rubrics = projects.map((project, i) => ({
  id: `r${i}`,
  projectId: project.id,
  name: i ? 'Архитектура без магии' : 'Вещи с историей',
  color: i ? '#806bba' : '#348579',
  days: [1, 3, 5],
  times: ['18:00'],
  media: 'image',
  textPrompt:
    'Одна история, один предмет. Рассказываем о привычных вещах через неожиданные детали.',
  mediaPrompt: 'Мягкий свет',
  enabled: true,
  revision: 1,
  state: 'active',
}));
const days = Array.from({ length: 7 }, (_, i) => ({
  date: `2026-10-${String(5 + i).padStart(2, '0')}`,
  cards: projects.map((p, j) => ({
    planId: `p${i}-${j}`,
    projectId: p.id,
    projectTitle: p.title,
    time: j ? '19:30' : '18:00',
    date: `2026-10-${String(5 + i).padStart(2, '0')}`,
    status: i < 2 ? 'sent' : i === 2 ? 'failed' : 'planned',
    statusLabel: i < 2 ? 'Опубликован' : i === 2 ? 'Ошибка публикации' : 'Запланирован',
    publicationKind: 'image',
    channel: 'vk',
    rubricId: `r${j}`,
    rubricLabel: rubrics[j].name,
    rubricColor: rubrics[j].color,
    contentPreview: 'История привычной вещи',
    version: 1,
  })),
}));

async function designData(page: Page, { stale = false, complete = false, connected = true } = {}) {
  await page.route('**/bot/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { items: [], series: [] };
    if (path.endsWith('/auth/session')) body = { authenticated: true };
    if (path.endsWith('/vk/legacy/status'))
      body = {
        connected: true,
        canPrepare: true,
        userId: 123,
        expiresAt: '2026-11-08T10:00:00Z',
        grantedScope: 'wall photos groups',
      };
    if (path.endsWith('/overview'))
      body = {
        week: { start: '2026-10-05', end: '2026-10-11' },
        projects,
        rubrics,
        days,
        cards: days.flatMap((d) => d.cards),
        summary: { missed: 0, planned: 8, sent: 4, failed: 2, materials: 14 },
        data_version: 1,
        as_of: '2026-10-08T10:00:00Z',
        service: {
          stale,
          heartbeat: { ok: !stale, ageSeconds: 10, updatedAt: '2026-10-08T10:00:00Z' },
          reports: { pending: 2, failed: 0, mode: 'scheduled' },
        },
      };
    if (path.endsWith('/incidents'))
      body = {
        items: [
          {
            projectId: 'things',
            message:
              'Не удалось загрузить фотографию. Проверьте подключение VK и повторите подготовку.',
            count: 2,
            stage: 'upload',
            lastSeenAt: '2026-10-08T10:00:00Z',
          },
        ],
      };
    if (path.endsWith('/weekly-preparation'))
      body = {
        week: { start: '2026-10-12', end: '2026-10-18' },
        total: 14,
        ready: complete ? 14 : 2,
        missing: complete ? 0 : 12,
        complete,
        posts: projects.flatMap((p) =>
          Array.from({ length: 7 }, (_, i) => ({
            projectId: p.id,
            title: p.title,
            date: `2026-10-${12 + i}T15:00:00Z`,
            status: i ? 'pending' : 'scheduled',
          })),
        ),
        vk: { connected, canPrepare: connected },
      };
    if (path.endsWith('/analytics'))
      body = {
        coverage: { sent: 24, withMetrics: 20, ratio: 0.83 },
        summary: { organicReach: { median: 1420 }, engagementRate: { median: 0.052 } },
        top: [{ bodyText: 'Почему мы сохраняем старые вещи', reachOrganic: 2400, editionId: 'e1' }],
        bottom: [
          { bodyText: 'Вещи, которые становятся привычкой', reachOrganic: 320, editionId: 'e2' },
        ],
      };
    if (path.endsWith('/analytics/posts'))
      body = {
        total: 1,
        items: [
          {
            projectId: 'things',
            bodyText: 'У каждой вещи есть история. Иногда она начинается с маленькой детали.',
            publishedAt: '2026-10-07T10:00:00Z',
            metrics: { reachOrganic: 2400 },
            derived: { engagement: { value: 0.052 } },
            vkUrl: 'https://vk.ru/wall-123_1',
          },
        ],
      };
    if (path.endsWith('/analytics/segments'))
      body = {
        segments: {
          byTopic: projects.map((p) => ({
            key: p.id,
            posts: 12,
            coverageRatio: 0.83,
            organicReach: { median: 1420 },
          })),
        },
      };
    if (path.endsWith('/editorial'))
      body = {
        memoryCount: 24,
        seriesCount: 0,
        revisions: [],
        pilotStats: {},
        latestRevision: {
          revisionId: 'revision-1',
          status: 'proposed',
          proposal: {
            overview: {
              summary:
                'Продолжить истории привычных вещей и проверить новый формат коротких наблюдений.',
            },
            continue: [
              { rubricId: 'Вещи с историей', reason: 'Читатели сохраняют истории предметов.' },
            ],
            newFormats: [
              {
                title: 'Одна деталь',
                hypothesis: 'Короткий рассказ легче дочитать',
                activate: true,
              },
            ],
            calendar: [
              {
                topic: 'Память старой лампы',
                thesis: 'Как предметы становятся частью домашнего ритуала.',
                slotUtc: '2026-10-12T15:00:00Z',
              },
            ],
          },
        },
      };
    if (path.endsWith('/ozon/settings'))
      body = {
        settings: { extraRules: 'Без кликбейта.' },
        projects: [{ id: 'things' }],
        categories: { ordinary: { label: 'Обычный товар' } },
        rulesDate: '2026-10-07',
      };
    await route.fulfill({ json: body });
  });
}

async function expectIconGeometry(page: Page) {
  const problems = await page.locator('.cabinet-icon').evaluateAll((icons) =>
    icons.flatMap((icon) => {
      const rect = icon.getBoundingClientRect();
      if (!rect.width || !rect.height) return [];
      const parent = icon.parentElement!;
      const box = parent.getBoundingClientRect();
      const label = parent.getAttribute('aria-label') || parent.textContent?.trim();
      const expectedSize = parent.classList.contains('empty-symbol') ? 28 : 20;
      const centeredY = Math.abs(rect.top + rect.height / 2 - box.top - box.height / 2) < 0.6;
      const iconOnly = parent.tagName === 'BUTTON' && !parent.textContent?.trim();
      const centeredX =
        !iconOnly || Math.abs(rect.left + rect.width / 2 - box.left - box.width / 2) < 0.6;
      return rect.width === expectedSize && rect.height === expectedSize && centeredY && centeredX
        ? []
        : [{ label, width: rect.width, height: rect.height, centeredY, centeredX }];
    }),
  );
  expect(problems).toEqual([]);
  const chevrons = await page.locator('select:not([multiple])').evaluateAll((selects) =>
    selects
      .filter((select) => select.getBoundingClientRect().width > 0)
      .map((select) => ({
        arrow: getComputedStyle(select).backgroundImage !== 'none',
        padding: parseFloat(getComputedStyle(select).paddingRight) >= 40,
      })),
  );
  expect(chevrons.every((select) => select.arrow && select.padding)).toBe(true);
}

test('all cabinet screens and dialogs are centered and readable at 1920px', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await designData(page);
  for (const tab of [
    'week',
    'rubrics',
    'editorial',
    'analytics',
    'analytics-posts',
    'analytics-imports',
    'analytics-segments',
    'analytics-prompts',
    'incidents',
    'service',
  ]) {
    await page.goto(`/bot/?tab=${tab}&project=things`);
    await expect(page.locator('.cabinet-header')).toBeVisible();
    await expect(page.locator('.cabinet > section').first()).toBeVisible();
    const geometry = await page.locator('.cabinet').evaluate((el) => {
      const box = el.getBoundingClientRect();
      const header = el.querySelector('.cabinet-header')!.getBoundingClientRect();
      const sections = [...el.querySelectorAll(':scope > section')].map((e) =>
        e.getBoundingClientRect(),
      );
      return {
        centered: Math.abs(box.left - (innerWidth - box.right)) < 1,
        overflow: document.documentElement.scrollWidth > innerWidth,
        aligned: sections.every(
          (s) => Math.abs(s.left - header.left) < 1 && Math.abs(s.right - header.right) < 1,
        ),
      };
    });
    expect(geometry, tab).toEqual({ centered: true, overflow: false, aligned: true });
    await expectIconGeometry(page);
    await page.screenshot({ path: testInfo.outputPath(`${tab}-1920.png`), fullPage: true });
    const summary = page.locator('summary').first();
    if (await summary.count()) {
      await summary.click();
      await expectIconGeometry(page);
      await page.screenshot({
        path: testInfo.outputPath(`${tab}-details-1920.png`),
        fullPage: true,
      });
    }
    expect((await new AxeBuilder({ page }).include('.cabinet').analyze()).violations, tab).toEqual(
      [],
    );
  }
  await page.goto('/bot/?tab=week');
  await page.locator('.slot').first().click();
  await expect(page.locator('.modal-dialog')).toBeVisible();
  await page.mouse.move(40, 40);
  await expect(page.locator('.modal-backdrop')).toHaveCSS(
    'background-color',
    'rgba(32, 32, 30, 0.55)',
  );
  await expect(page.locator('.modal-backdrop')).toHaveCSS('box-shadow', 'none');
  await expectIconGeometry(page);
  await page.screenshot({ path: testInfo.outputPath('post-dialog-1920.png') });
  const modal = await page.locator('.modal-dialog').boundingBox();
  expect(Math.abs(modal!.x + modal!.width / 2 - 960)).toBeLessThan(1);
  await page.locator('#modal-close').click();
  await page.goto('/bot/?tab=rubrics');
  await page.getByRole('button', { name: 'Настроить →' }).first().click();
  await expect(page.locator('.rubric-dialog')).toBeVisible();
  await expectIconGeometry(page);
  await page.screenshot({ path: testInfo.outputPath('rubric-dialog-1920.png') });
  await page.locator('.rubric-dialog').evaluate((dialog) => {
    dialog.scrollTop = dialog.scrollHeight;
  });
  await expect(page.locator('#rubric-close')).toBeInViewport();
  await expectIconGeometry(page);
  await page.screenshot({ path: testInfo.outputPath('rubric-dialog-bottom-1920.png') });
  await page.keyboard.press('Escape');
  await page.locator('#ozon-open').click();
  await expect(page.getByLabel('Название товара')).toBeVisible();
  await expectIconGeometry(page);
  await page.screenshot({ path: testInfo.outputPath('ozon-1920.png'), fullPage: true });
  expect((await new AxeBuilder({ page }).include('.ozon-dialog').analyze()).violations).toEqual([]);
  expect(errors).toEqual([]);
});

test('status icons remain aligned in stale, disconnected and complete states', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await designData(page, { stale: true, connected: false });
  await page.goto('/bot/?tab=week');
  await expect(page.locator('.stale-indicator')).toBeVisible();
  await expectIconGeometry(page);
  await page.screenshot({ path: testInfo.outputPath('week-offline-1920.png'), fullPage: true });
  await page.unrouteAll({ behavior: 'wait' });
  await designData(page, { complete: true });
  await page.goto('/bot/?tab=week');
  await expect(page.getByRole('button', { name: 'Неделя подготовлена ✓' })).toBeDisabled();
  await expectIconGeometry(page);
  const controls = await page.locator('.toolbar-nav button').evaluateAll((buttons) =>
    buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { height: rect.height, clipped: button.scrollWidth > button.clientWidth };
    }),
  );
  expect(controls).toEqual([
    { height: 48, clipped: false },
    { height: 48, clipped: false },
    { height: 48, clipped: false },
  ]);
  await page.screenshot({ path: testInfo.outputPath('week-complete-1920.png'), fullPage: true });
});

test('login is centered at 1920px', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.route('**/bot/api/v1/auth/session', (r) =>
    r.fulfill({ json: { authenticated: false } }),
  );
  await page.goto('/bot/');
  await expect(page.locator('.login')).toBeVisible();
  const box = await page.locator('.login').boundingBox();
  expect(Math.abs(box!.x + box!.width / 2 - 960)).toBeLessThan(1);
  expect(Math.abs(box!.y + box!.height / 2 - 540)).toBeLessThan(1);
  await expectIconGeometry(page);
  await page.screenshot({ path: testInfo.outputPath('login-1920.png') });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

for (const width of [390, 1920]) {
  test(`OAuth waiting and failure pages respect nonce CSP at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1080 });
    await page.route('**/vk/legacy/complete', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await route.abort();
    });
    for (const [name, view] of [
      ['vk-waiting', legacyCallbackPage()],
      [
        'vk-error',
        oauthStatusPage(
          'VK не подключён для публикаций',
          'VK не выдал права на фотографии и сообщества. Вернитесь в кабинет и начните новый вход.',
        ),
      ],
    ] as const) {
      await page.route('**/design-oauth', (route) =>
        route.fulfill({
          contentType: 'text/html',
          headers: {
            'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${view.nonce}'; script-src 'nonce-${view.nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
          },
          body: view.html,
        }),
      );
      await page.goto('/design-oauth');
      await expect(page.locator('main')).toBeVisible();
      expect(
        await page.locator('main').evaluate((el) => getComputedStyle(el).backgroundColor),
      ).toBe('rgb(255, 254, 250)');
      const box = await page.locator('main').boundingBox();
      expect(Math.abs(box!.x + box!.width / 2 - width / 2)).toBeLessThan(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`${name}-${width}.png`) });
    }
  });
}

test('empty and failed workspaces offer clear recovery at 1920px', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await designData(page);
  await page.route('**/bot/api/v1/incidents?**', (route) => route.fulfill({ json: { items: [] } }));
  await page.goto('/bot/?tab=incidents');
  await expect(page.getByRole('heading', { name: 'Открытых инцидентов нет' })).toBeVisible();
  await expectIconGeometry(page);
  await page.screenshot({ path: testInfo.outputPath('incidents-empty-1920.png') });
  await page.goto('/bot/?tab=editorial');
  await expect(page.getByRole('heading', { name: 'Сначала выберите сообщество' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('editorial-empty-1920.png') });
  await page.route('**/bot/api/v1/overview?**', (route) =>
    route.fulfill({ status: 503, json: { error: 'unavailable' } }),
  );
  await page.goto('/bot/');
  await expect(page.locator('.error-banner')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Обновить', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('workspace-error-1920.png') });
});

test('Ozon preview loads its image under the production CSP and preserves explicit review', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await designData(page);
  const { readFileSync } = await import('node:fs');
  const nginx = readFileSync('deploy/nginx-container.conf', 'utf8');
  const csp = nginx.match(/location = \/bot\/ \{[^}]*Content-Security-Policy "([^"]+)"/s)![1];
  await page.route('**/bot/', (route) =>
    route.fulfill({
      contentType: 'text/html',
      headers: { 'Content-Security-Policy': csp },
      body: readFileSync('dist/bot/index.html', 'utf8'),
    }),
  );
  const post = {
    id: 'ad1',
    input: { name: 'Белая лампа', projectId: 'things', markingUrl: 'https://s.ozon.ru/marking' },
    status: 'ready',
    imageId: 'img1',
    imageStyle: 'Вещи — кстати',
    version: 1,
    message:
      'Белая лампа: небольшой домашний ритуал.\n\nhttps://s.ozon.ru/product\n\nРеклама. Информация о рекламодателях по ссылке https://s.ozon.ru/marking',
  };
  await page.route('**/bot/api/v1/ozon/posts', (route) =>
    route.fulfill({ json: { items: [post] } }),
  );
  await page.route('**/bot/api/v1/ozon/posts/ad1', (route) => route.fulfill({ json: { post } }));
  await page.route('**/bot/api/v1/ozon/posts/ad1/image', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=',
        'base64',
      ),
    }),
  );
  await page.goto('/bot/');
  await page.locator('#ozon-open').click();
  await page.locator('.ozon-history summary').click();
  await page.locator('[data-ozon-post="ad1"]').click();
  await expect
    .poll(() => page.locator('#ozon-photo').evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);
  await expect(page.locator('#ozon-publish input')).not.toBeChecked();
  expect((await new AxeBuilder({ page }).include('.ozon-dialog').analyze()).violations).toEqual([]);
  await page.locator('.ozon-dialog').evaluate((el) => {
    el.scrollTop = 0;
  });
  await expectIconGeometry(page);
  await page.screenshot({ path: testInfo.outputPath('ozon-preview-1920.png') });
  await page.locator('#ozon-publish button').scrollIntoViewIfNeeded();
  await expect(page.locator('#ozon-close')).toBeInViewport();
  const actions = await page.locator('.ozon-dialog').evaluate((el) => {
    const publish = el.querySelector('#ozon-publish button')!.getBoundingClientRect();
    const next = el.querySelector('#ozon-new')!.getBoundingClientRect();
    return next.top - publish.bottom;
  });
  expect(actions).toBeGreaterThanOrEqual(20);
  const checkboxOffset = await page.locator('.ozon-check input').evaluate((input) => {
    const box = input.getBoundingClientRect();
    const parent = input.parentElement!;
    const label = parent.getBoundingClientRect();
    const lineHeight = parseFloat(getComputedStyle(parent).lineHeight);
    return Math.abs(box.top + box.height / 2 - label.top - lineHeight / 2);
  });
  expect(checkboxOffset).toBeLessThan(0.6);
  await expectIconGeometry(page);
  await page.screenshot({ path: testInfo.outputPath('ozon-review-1920.png') });
});
