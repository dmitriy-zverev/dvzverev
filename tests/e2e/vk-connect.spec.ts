import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { legacyManualLoginPage } from '../../bot/vk-oauth/legacy.mjs';

const authorize =
  'https://oauth.vk.ru/authorize?client_id=54809516&redirect_uri=https%3A%2F%2Foauth.vk.ru%2Fblank.html';
const returned =
  'https://oauth.vk.ru/blank.html#access_token=vk1.a.' +
  'a'.repeat(30) +
  '&expires_in=86400&state=' +
  'b'.repeat(43);

test('manual VK connection submits privately and returns to cabinet', async ({ page }) => {
  const view = legacyManualLoginPage(authorize);
  await page.route('**/bot/api/v1/vk/legacy/login', (route) =>
    route.fulfill({ contentType: 'text/html', body: view.html }),
  );
  await page.route('**/bot/api/v1/auth/session', (route) =>
    route.fulfill({ json: { authenticated: false } }),
  );
  let submitted: unknown;
  await page.route('**/bot/api/v1/vk/legacy/complete', async (route) => {
    submitted = route.request().postDataJSON();
    await expect(page.getByLabel('Адрес страницы после входа')).toHaveValue('');
    await route.fulfill({ json: { connected: true } });
  });
  await page.goto('/bot/api/v1/vk/legacy/login');
  await expect(page.getByRole('link', { name: 'Открыть VK' })).toHaveAttribute('href', authorize);
  await page.getByLabel('Адрес страницы после входа').fill(returned);
  await page.getByRole('button', { name: 'Подключить VK', exact: true }).click();
  await expect(page).toHaveURL(/\/bot\/\?vk=connected$/);
  expect(submitted).toEqual({ redirectUrl: returned });
});

test('manual VK connection fits mobile, is accessible and explains rejected identity', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const view = legacyManualLoginPage(authorize);
  await page.route('**/bot/api/v1/vk/legacy/login', (route) =>
    route.fulfill({ contentType: 'text/html', body: view.html }),
  );
  await page.route('**/bot/api/v1/vk/legacy/complete', (route) =>
    route.fulfill({ status: 400, json: { error: 'vk_oauth_wrong_user' } }),
  );
  await page.goto('/bot/api/v1/vk/legacy/login');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByLabel('Адрес страницы после входа').fill(returned);
  await page.getByRole('button', { name: 'Подключить VK', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('под аккаунтом владельца');
  await expect(page.getByLabel('Адрес страницы после входа')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Подключить VK', exact: true })).toBeEnabled();
  await page.screenshot({ path: 'test-results/vk-connect-mobile.png' });
});

for (const [error, message] of [
  ['vk_api_rejected_5', 'VK отклонил ключ'],
  ['vk_api_rejected_5_ip_mismatch', 'Включите VPN на латвийском VPS бота'],
  ['vk_api_rejected_5_expired', 'Срок действия ключа VK истёк'],
]) {
  test(`manual VK connection explains ${error}`, async ({ page }) => {
    await page.route('**/bot/api/v1/vk/legacy/login', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: legacyManualLoginPage(authorize).html,
      }),
    );
    await page.route('**/bot/api/v1/vk/legacy/complete', (route) =>
      route.fulfill({
        status: 400,
        json: { error },
      }),
    );
    await page.goto('/bot/api/v1/vk/legacy/login');
    await page.getByLabel('Адрес страницы после входа').fill(returned);
    await page.getByRole('button', { name: 'Подключить VK', exact: true }).click();
    await expect(page.getByRole('status')).toContainText(message);
    await expect(page.getByLabel('Адрес страницы после входа')).toHaveValue('');
  });
}
