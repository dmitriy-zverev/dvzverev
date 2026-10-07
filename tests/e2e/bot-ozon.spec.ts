import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=',
  'base64',
);
type AdInput = {
  requestId: string;
  name: string;
  referralUrl: string;
  markingUrl: string;
  references: { name: string; data: string }[];
};
type MockPost = {
  id: string;
  input: AdInput;
  status: string;
  version: number;
  imageStyle?: string;
  imageId?: string;
  message?: string;
  url?: string;
};
async function setup(page: Page) {
  let generated = 0;
  let published = 0;
  let regenerated = 0;
  let captured: AdInput | undefined;
  let post: MockPost | undefined;
  let settings = {
    extraRules: 'Без кликбейта.',
  };
  await page.route('**/bot/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body = {};
    if (path.endsWith('/auth/session')) body = { authenticated: true };
    if (path.endsWith('/incidents')) body = { items: [] };
    if (path.endsWith('/overview'))
      body = {
        week: { start: '2026-10-05', end: '2026-10-11' },
        projects: [{ id: 'things', title: 'Вещи — кстати' }],
        summary: {},
        days: [],
        cards: [],
        data_version: 1,
        service: {},
      };
    if (path.endsWith('/ozon/settings')) {
      if (route.request().method() === 'POST') settings = route.request().postDataJSON();
      body = {
        settings,
        projects: [{ id: 'things' }],
        categories: { ordinary: { label: 'Обычный товар' }, medical: { label: 'Лекарство' } },
        rulesDate: '2026-10-07',
      };
    }
    if (path.endsWith('/ozon/posts')) {
      if (route.request().method() === 'POST') {
        generated++;
        const request = route.request().postDataJSON() as AdInput;
        captured = request;
        post = {
          id: request.requestId,
          input: request,
          status: 'generating',
          version: 1,
          imageStyle: 'Стиль Вещи — кстати',
          imageId: 'first-image',
        };
        body = { post };
      } else body = { items: post ? [post] : [] };
    }
    if (/\/ozon\/posts\/[\w-]+$/.test(path)) {
      if (!post) throw new Error('Missing mock post');
      post = {
        ...post,
        status: 'ready',
        imageId: post.status === 'regenerating' ? 'image-' + post.version : post.imageId,
        message:
          'Белая лампа из металла.\n\n' +
          post.input.referralUrl +
          '\n\nРеклама. Информация о рекламодателях по ссылке ' +
          post.input.markingUrl,
      };
      body = { post };
    }
    if (path.endsWith('/image')) {
      await route.fulfill({ body: image, contentType: 'image/png' });
      return;
    }
    if (path.endsWith('/regenerate-image')) {
      if (!post) throw new Error('Missing mock post');
      regenerated++;
      post = { ...post, status: 'regenerating', version: post.version + 1 };
      body = { post };
    }
    if (path.endsWith('/publish')) {
      if (!post) throw new Error('Missing mock post');
      published++;
      post = { ...post, status: 'sent', url: 'https://vk.ru/wall-123_44' };
      body = { post };
    }
    await route.fulfill({ json: body });
  });
  await page.goto('/bot/');
  await page.getByRole('button', { name: 'Выпустить рекламный пост', exact: true }).click();
  await expect(page.getByLabel('Название товара')).toBeVisible();
  return {
    generated: () => generated,
    published: () => published,
    regenerated: () => regenerated,
    captured: () => captured!,
  };
}
test('prepare with references, preview exact marking, then explicitly publish', async ({
  page,
}) => {
  const f = await setup(page);
  await page.getByLabel('Название товара').fill('Белая лампа');
  await page.getByLabel('Реферальная ссылка на товар').fill('https://s.ozon.ru/Test?erid=Keep');
  await page
    .getByLabel('Подтверждённые характеристики товара')
    .fill('Материал: металл. Цвет: белый.');
  await page
    .getByLabel('Фото товара и референсы')
    .setInputFiles({ name: 'lamp.png', mimeType: 'image/png', buffer: image });
  await page.getByRole('button', { name: 'Подготовить рекламный пост', exact: true }).click();
  expect(f.generated()).toBe(0);
  await page
    .getByLabel('Ссылка на рекламодателей для этого поста')
    .fill('https://s.ozon.ru/UniqueMark?erid=42');
  await page.getByRole('button', { name: 'Подготовить рекламный пост', exact: true }).click();
  await expect(page.getByText('Готовим текст и фото…', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Опубликовать в VK', exact: true })).toBeVisible();
  expect(f.generated()).toBe(1);
  expect(f.published()).toBe(0);
  expect(f.captured().references[0].data).toMatch(/^data:image\/png;base64,/);
  await expect(page.locator('.ozon-post-text')).toContainText('https://s.ozon.ru/Test?erid=Keep');
  await expect(page.locator('.ozon-post-text')).toContainText(
    'Реклама. Информация о рекламодателях по ссылке https://s.ozon.ru/UniqueMark?erid=42',
  );
  await expect(
    page.getByRole('img', { name: 'Сгенерированное рекламное фото товара' }),
  ).toBeVisible();
  const firstPhoto = await page.locator('#ozon-photo').getAttribute('src');
  const firstText = await page.locator('.ozon-post-text').textContent();
  await page.getByRole('button', { name: 'Перегенерировать изображение', exact: true }).click();
  await expect(
    page.getByText('Генерируем новый вариант изображения…', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Опубликовать в VK', exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Перегенерировать изображение', exact: true }),
  ).toBeVisible();
  await expect(page.locator('#ozon-photo')).not.toHaveAttribute('src', firstPhoto!);
  await expect(page.locator('.ozon-post-text')).toHaveText(firstText!);
  expect(f.generated()).toBe(1);
  expect(f.regenerated()).toBe(1);
  expect(f.published()).toBe(0);
  await page.getByRole('button', { name: 'Опубликовать в VK', exact: true }).click();
  expect(f.published()).toBe(0);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Опубликовать в VK', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Открыть публикацию в VK' })).toBeVisible();
  expect(f.published()).toBe(1);
  await expect(
    page.getByRole('button', { name: 'Перегенерировать изображение', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Новый рекламный пост' }).click();
  await expect(page.getByLabel('Ссылка на рекламодателей для этого поста')).toHaveValue('');
});
test('settings persist; refresh keeps the open form and file input', async ({ page }) => {
  await setup(page);
  await page.getByText('Наши правила', { exact: true }).click();
  await page.getByLabel('Наши дополнительные правила').fill('Без эмодзи и списков.');
  await page.getByRole('button', { name: 'Сохранить настройки' }).click();
  await expect(page.getByText('Правила сохранены.')).toBeVisible();
  await page.getByLabel('Название товара').fill('Сохранить эту тему');
  await page
    .getByLabel('Фото товара и референсы')
    .setInputFiles({ name: 'lamp.png', mimeType: 'image/png', buffer: image });
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByLabel('Название товара')).toHaveValue('Сохранить эту тему');
  await expect(page.locator('.ozon-references figcaption')).toHaveText('lamp.png');
  await page.getByRole('button', { name: 'Закрыть рекламу' }).click();
  await page.getByRole('button', { name: 'Выпустить рекламный пост', exact: true }).click();
  await page.getByText('Наши правила', { exact: true }).click();
  await expect(page.getByLabel('Наши дополнительные правила')).toHaveValue('Без эмодзи и списков.');
});
test('mobile composer fits screen, exposes labels and traps focus accessibly', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await setup(page);
  const dialog = page.getByRole('dialog');
  const bounds = await dialog.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(360);
  const result = await new AxeBuilder({ page }).include('.ozon-dialog').analyze();
  expect(result.violations).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('session expiry removes the private advertising dialog', async ({ page }) => {
  await setup(page);
  await page.route('**/bot/api/v1/overview**', (route) =>
    route.fulfill({ status: 401, json: { error: 'unauthorized' } }),
  );
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('Пароль')).toBeVisible();
});
