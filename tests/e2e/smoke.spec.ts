import { test, expect } from '@playwright/test';

test('hero to telegram CTA', async ({ page }) => {
  await page.goto('/');
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const faces = await document.fonts.load('16px "DVZ Mono Nerd"', '  ');
        return faces.length > 0 && document.fonts.check('16px "DVZ Mono Nerd"');
      }),
    )
    .toBe(true);

  for (const font of ['Regular', 'ExtraBold']) {
    const response = await page.request.get(`/fonts/DVZMonoNerd-${font}-v1.woff2`);
    expect(response.ok()).toBe(true);
  }

  const cta = page.getByRole('link', { name: /написать/i }).first();
  await expect(cta).toHaveAttribute('href', 'https://t.me/zverev_dmitry');
  await expect(cta).toHaveAttribute('rel', /noopener/);
});

test('nav to projects section', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('link', { name: /проекты/i })
    .first()
    .click();
  await expect(page.locator('#cases')).toBeInViewport();
});

test('project buffer expands without a javascript controller', async ({ page }) => {
  await page.goto('/');
  const mayak = page.locator('details').filter({ hasText: 'Маяк' });
  await mayak.locator('summary').click();
  await expect(mayak).toHaveAttribute('open', '');
});

test('contact links are external and safe', async ({ page }) => {
  await page.goto('/');

  const telegram = page.getByRole('link', { name: /telegram @zverev_dmitry/i });
  await expect(telegram).toHaveAttribute('href', 'https://t.me/zverev_dmitry');
  await expect(telegram).toHaveAttribute('rel', /noopener/);

  const github = page.getByRole('link', { name: /github/i }).last();
  await expect(github).toHaveAttribute('href', 'https://github.com/dmitriy-zverev');
});

test('reduced motion keeps content and contact', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: /telegram @zverev_dmitry/i })).toBeVisible();
});
