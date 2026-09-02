// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  output: 'static',
  compressHTML: true,
  site: 'https://www.dvzverev.ru',
  integrations: [sitemap()],
  build: {
    inlineStylesheets: 'always',
  },
});
