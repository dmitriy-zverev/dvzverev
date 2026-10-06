// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  output: 'static',
  compressHTML: true,
  devToolbar: { enabled: false },
  site: 'https://www.dvzverev.ru',
  integrations: [sitemap({ filter: (page) => !page.includes('/bot') })],
  build: {
    inlineStylesheets: 'always',
  },
});
