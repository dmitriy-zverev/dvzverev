# Performance budget лендинга

Статус: применяется к текущей Neovim-версии  
Цель: первый экран выглядит завершённым сразу после получения HTML и остаётся полезным без JavaScript.

## 1. Критический путь

Первый ответ сервера уже содержит:

- семантическую разметку hero;
- весь интерфейс редактора, ASCII-схему, заголовок и CTA;
- локальные стили без runtime CSS-in-JS;
- обычные ссылки на Telegram и проекты.

Нет прелоадера, пустого hero, растрового LCP-изображения, стороннего виджета или клиентской гидратации. Системный monospace fallback отображает страницу, пока загружается локальный Nerd Font subset.

## 2. Архитектура

- Astro static output;
- Astro components, HTML и CSS;
- TypeScript только во время сборки и в маленьком необязательном клиентском модуле;
- без React, Next.js, GSAP и других runtime-библиотек;
- без API, SSR, базы данных и serverless-функций;
- готовый `dist/` публикуется на существующем VPS.

## 3. Жёсткие бюджеты

| Ресурс                                 | Максимум, Brotli/WOFF2 |
| -------------------------------------- | ---------------------: |
| HTML                                   |                  20 KB |
| CSS всей страницы                      |                  20 KB |
| Весь JavaScript                        |                  30 KB |
| Все локальные шрифты                   |                  70 KB |
| Все критические ресурсы первого экрана |                 110 KB |
| Вся страница                           |                 700 KB |
| Сторонний JavaScript до `load`         |                   0 KB |

Release gates:

- Lighthouse Performance mobile ≥ 90;
- Lighthouse Accessibility ≥ 95;
- CLS ≤ 0,05;
- INP ≤ 200 мс;
- автоматический size-budget и bundle-check проходят в CI.

## 4. Nerd Font

Используется self-hosted семейство `DVZ Mono Nerd` — модифицированный web-subset JetBrainsMono Nerd Font 3.5.1.

- regular содержит русский/латинский текст, box drawing и только используемые Nerd-глифы;
- extra-bold содержит только символы крупных заголовков;
- оба WOFF2 используются в первом viewport и предзагружаются;
- `font-display: swap` не блокирует текст;
- системный monospace stack остаётся fallback;
- суммарный фактический вес файлов — около 17,5 KB;
- файлы шрифта получают длительное immutable-кэширование;
- лицензия и атрибуция находятся рядом с файлами в `public/fonts/LICENSE.md`.

## 5. CSS и motion

- первый экран строится HTML/CSS, без картинок;
- постоянное движение ограничено курсором и лёгкой scanline;
- раскрытие проектов использует нативный `<details>`;
- анимации отключаются через `prefers-reduced-motion`;
- hover/focus/active отвечают сразу;
- контент не скрывается в ожидании reveal-анимации;
- нет scroll-scrubbing, canvas, WebGL и бесконечного JavaScript animation loop.

## 6. Сеть и кэш

- ассеты размещаются на том же origin;
- HTML кэшируется с revalidation;
- хэшированные CSS/JS и versioned fonts получают `Cache-Control: public, max-age=31536000, immutable`;
- Brotli/Gzip подготавливаются для текстовых ресурсов;
- Telegram CTA — обычная ссылка без SDK;
- аналитика и сторонние iframe не входят в первый релиз.

## 7. Проверка перед публикацией

Автоматически:

- production build;
- Astro typecheck и ESLint;
- unit tests;
- Playwright desktop/mobile smoke;
- тест без JavaScript;
- accessibility scan;
- проверка фактической загрузки `DVZ Mono Nerd`;
- size-budget и отсутствие тяжёлых runtime-зависимостей.

Вручную:

- первый и повторный запуск на мобильном viewport;
- клавиатурная навигация и видимый focus;
- `prefers-reduced-motion`;
- отсутствие горизонтального overflow;
- корректное отображение Nerd-глифов и ASCII-геометрии.

Бюджет считается ограничением дизайна: если новый эффект не помещается, упрощается эффект, а не увеличивается лимит.
