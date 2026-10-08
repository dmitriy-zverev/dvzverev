import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const rubric = {
  id: 'r1',
  projectId: 'things',
  revision: 1,
  state: 'active',
  enabled: true,
  name: 'Сценарии',
  days: [1, 3, 5],
  times: ['18:00'],
  media: 'text',
  textPrompt: 'Практический сценарий без рекламы',
  mediaPrompt: '',
  color: '#5640ad',
};
const suggestion = {
  kind: 'change',
  rubricId: 'r1',
  expectedRevision: 1,
  title: 'Изменить «Сценарии»',
  hypothesis: 'Короткий вопрос в конце повысит обсуждение',
  reason: 'Повторяются концовки публикаций',
  evidenceIds: ['finding:closing_repeat'],
  targetPosts: 6,
  reviewDays: 14,
  metric: 'comments',
  successRule: 'Медиана комментариев выше предыдущих 6 публикаций',
  config: { ...rubric, textPrompt: rubric.textPrompt + '\nОдин короткий вопрос для обсуждения.' },
};
for (const width of [1920, 375]) {
  test(`editorial rubric hypothesis review, launch and finish at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1080 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let items: Record<string, unknown>[] = [],
      applied = 0,
      submitted: Record<string, unknown> = {};
    await page.route('**/bot/api/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown = { items: [], series: [] };
      if (path.endsWith('/auth/session')) body = { authenticated: true };
      if (path.endsWith('/overview'))
        body = {
          week: { start: '2026-10-05', end: '2026-10-11', timezone: 'Europe/Moscow' },
          projects: [{ id: 'things', title: 'Вещи' }],
          summary: {},
          days: [],
          cards: [],
          data_version: 1,
          service: { heartbeat: { ok: true } },
        };
      if (path.endsWith('/editorial'))
        body = {
          memoryCount: 12,
          seriesCount: 0,
          pilotStats: {},
          revisions: [],
          latestRevision: null,
        };
      if (path.endsWith('/editorial/rubric-tests')) {
        if (route.request().method() === 'POST') {
          submitted = route.request().postDataJSON();
          items = [
            {
              id: 't1',
              status: 'proposed',
              kind: submitted.kind,
              proposal: submitted,
              before: rubric,
              report: { changedManually: false },
            },
          ];
          body = items[0];
        } else
          body = {
            projectId: 'things',
            rubrics: [rubric],
            suggestions: [suggestion],
            tests: items,
            metricsStale: true,
          };
      }
      if (path.endsWith('/t1/decide')) {
        const decision = route.request().postDataJSON();
        if (decision.decision === 'apply') {
          applied++;
          items[0] = {
            ...items[0],
            status: 'testing',
            startedAt: '2026-10-08T12:00:00Z',
            report: {
              test: { posts: 6, measured: 6, median: 24 },
              baseline: { posts: 6, measured: 6, median: 15 },
              reviewAt: '2026-10-22T12:00:00Z',
              reviewDue: true,
              changedManually: false,
              warning: 'Последовательная проверка гипотезы',
            },
          };
        }
        if (decision.decision === 'keep')
          items[0] = { ...items[0], status: 'kept', note: decision.note };
        body = items[0];
      }
      await route.fulfill({ json: body });
    });
    await page.goto('/bot/?tab=editorial&project=things');
    await expect(page.getByRole('heading', { name: 'Лаборатория рубрик' })).toBeVisible();
    await page.getByRole('button', { name: 'Проверить настройки' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[name=target]')).toHaveValue('r1');
    await expect(dialog.getByRole('combobox', { name: 'Основная метрика' })).toBeVisible();
    await dialog.getByRole('combobox', { name: 'Основная метрика' }).click();
    await dialog.getByRole('option', { name: 'Лайки', exact: true }).click();
    await dialog.getByLabel('Критерий успеха').fill('Лайков на публикацию больше, чем до теста');
    expect(
      await dialog.evaluate(
        (el) =>
          [...el.querySelectorAll('*')].filter((n) => {
            const s = getComputedStyle(n);
            return ['auto', 'scroll'].includes(s.overflowY) && n.scrollHeight > n.clientHeight + 2;
          }).length,
      ),
    ).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (width === 1920) {
      mkdirSync('/tmp/editorial-rubric-screens', { recursive: true });
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: '/tmp/editorial-rubric-screens/review-1920.png',
        fullPage: true,
      });
    }
    await dialog.getByRole('button', { name: 'Сохранить предложение' }).click();
    await expect(page.getByRole('button', { name: 'Запустить тест' })).toBeVisible();
    expect(submitted.kind).toBe('change');
    expect(submitted.expectedRevision).toBe(1);
    expect(submitted.metric).toBe('likes');
    expect(applied).toBe(0);
    await page.getByRole('button', { name: 'Запустить тест' }).click();
    await expect(page.getByText('Тест идёт', { exact: true })).toBeVisible();
    expect(applied).toBe(1);
    await page.getByLabel('Вывод по тесту').fill('Гипотеза подтверждена; сохраняем подачу');
    if (width === 1920) {
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: '/tmp/editorial-rubric-screens/testing-1920.png',
        fullPage: true,
      });
    }
    await page.getByRole('button', { name: 'Сохранить изменение' }).click();
    await expect(page.getByText('Изменение сохранено', { exact: true })).toBeVisible();
    await expect(page.getByText('Вывод: Гипотеза подтверждена; сохраняем подачу')).toBeVisible();
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
