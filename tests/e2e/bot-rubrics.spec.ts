import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function setup(page: Page) {
  let rubrics = [
    {
      id: 'r1',
      projectId: 'things',
      name: 'Вещи с историей',
      color: '#348579',
      days: [1, 3, 5],
      times: ['18:00'],
      media: 'image',
      textPrompt: 'История одной вещи',
      mediaPrompt: 'Мягкий свет',
      enabled: true,
      revision: 1,
      state: 'active',
    },
  ];
  const mutations: { method: string; body: Record<string, unknown> }[] = [];
  const preparation: string[] = [];
  const projects = [
    { id: 'things', title: 'Вещи — кстати' },
    { id: 'code', title: 'Код на подумать' },
  ];
  const current = {
    week: { start: '2026-10-05', end: '2026-10-11' },
    total: 2,
    ready: 0,
    missing: 2,
    uncertain: 0,
    running: false,
    posts: [
      {
        projectId: 'things',
        title: 'Вещи — кстати',
        date: '2026-10-09T15:00:00Z',
        media: 'image',
        status: 'pending',
      },
    ],
  };
  await page.route('**/bot/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let body: object = {};
    if (path.endsWith('/auth/session')) body = { authenticated: true };
    if (path.endsWith('/incidents')) body = { items: [] };
    if (path.endsWith('/vk/legacy/status')) body = { canPrepare: true, connected: true };
    if (path.endsWith('/overview')) {
      const cards =
        url.searchParams.has('rubric') && url.searchParams.get('rubric') !== 'r1'
          ? []
          : rubrics.length
            ? [
                {
                  planId: 'p1',
                  projectId: 'things',
                  projectTitle: 'Вещи — кстати',
                  time: '18:00',
                  date: '2026-10-09',
                  status: 'planned',
                  statusLabel: 'Запланирован',
                  publicationKind: 'image',
                  rubricId: 'r1',
                  rubricLabel: rubrics[0].name,
                  rubricColor: rubrics[0].color,
                },
              ]
            : [];
      body = {
        week: { start: '2026-10-05', end: '2026-10-11' },
        projects,
        rubrics,
        summary: { materials: cards.length },
        days: [{ date: '2026-10-09', cards }],
        cards,
        service: {},
        data_version: 1,
      };
    }
    if (path.includes('/rubrics') && route.request().method() !== 'GET') {
      const input = route.request().postDataJSON();
      mutations.push({ method: route.request().method(), body: input });
      if (route.request().method() === 'DELETE') rubrics = [];
      else if (route.request().method() === 'PATCH')
        rubrics = [{ ...rubrics[0], ...input, revision: 2 }];
      body = { rubrics };
    }
    if (path.endsWith('/weekly-preparation')) {
      if (route.request().method() === 'POST')
        preparation.push(url.searchParams.get('scope') || 'next');
      body = {
        week: { start: '2026-10-12', end: '2026-10-18' },
        total: 0,
        ready: 0,
        missing: 0,
        uncertain: 0,
        running: false,
        complete: false,
        posts: [],
        vk: { canPrepare: true, connected: true },
        current,
      };
    }
    await route.fulfill({ json: body });
  });
  return { mutations, preparation };
}

test('rubric calendar badge and filter survive refresh', async ({ page }) => {
  await setup(page);
  await page.goto('/bot/');
  await expect(page.locator('.slot-rubric')).toHaveText('Вещи с историей');
  await page.getByRole('combobox', { name: 'Рубрика', exact: true }).click();
  await page.getByRole('option', { name: 'Без рубрики', exact: true }).click();
  await expect(page.locator('.slot-rubric')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Рубрика', exact: true }).click();
  await page.getByRole('option', { name: 'Вещи с историей', exact: true }).click();
  await expect(page.locator('.slot-rubric')).toHaveText('Вещи с историей');
});

test('editing sends group, schedule, prompts and optimistic revision; periodic refresh retains form', async ({
  page,
}, testInfo) => {
  const f = await setup(page);
  await page.goto('/bot/?tab=rubrics');
  await expect(page.getByRole('button', { name: 'Настроить →' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('rubrics-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Настроить →' }).click();
  await page.getByLabel('Название', { exact: true }).fill('Ритуалы дома');
  await page
    .getByRole('textbox', { name: /^Дополнительный промпт для текста/ })
    .fill('Один предмет, один небольшой ритуал');
  await page.getByLabel('Время публикации · Москва').fill('17:30, 19:00');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByLabel('Название', { exact: true })).toHaveValue('Ритуалы дома');
  await page.getByRole('button', { name: 'Сохранить рубрику', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(f.mutations[0]).toMatchObject({
    method: 'PATCH',
    body: {
      projectId: 'things',
      revision: 1,
      name: 'Ритуалы дома',
      times: ['17:30', '19:00'],
      days: [1, 3, 5],
      media: 'image',
      mediaPrompt: 'Мягкий свет',
    },
  });
});

test('deleting requires concrete confirmation and removes calendar badge', async ({ page }) => {
  const f = await setup(page);
  await page.goto('/bot/?tab=rubrics');
  await page.getByRole('button', { name: 'Настроить →' }).click();
  await page.getByRole('button', { name: 'Удалить рубрику', exact: true }).click();
  expect(f.mutations).toHaveLength(0);
  await page.getByRole('button', { name: 'Удалить рубрику и посты', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(f.mutations[0].method).toBe('DELETE');
  await page.getByRole('button', { name: 'Неделя', exact: true }).click();
  await expect(page.locator('.slot-rubric')).toHaveCount(0);
});

test('current week supplement works even when next week has no missing posts', async ({ page }) => {
  const f = await setup(page);
  await page.goto('/bot/');
  await page.getByRole('button', { name: 'Дополнить неделю', exact: true }).click();
  await expect.poll(() => f.preparation).toEqual(['current']);
});

test('rubric form is keyboard accessible and fits mobile viewport', async ({ page }, testInfo) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/bot/?tab=rubrics');
  await page.getByRole('button', { name: '+ Новая рубрика', exact: true }).click();
  await page.getByRole('combobox', { name: 'Формат', exact: true }).click();
  await page.getByRole('option', { name: 'Короткое видео', exact: true }).click();
  await expect(page.locator('#rubric-media-note')).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('rubrics-mobile.png') });
  expect((await new AxeBuilder({ page }).include('.rubric-dialog').analyze()).violations).toEqual(
    [],
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
