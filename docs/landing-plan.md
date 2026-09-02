# План лендинга dvzverev.ru

Статус: компактная Neovim-версия реализована  
Production URL: `https://www.dvzverev.ru/`

## 1. Позиционирование

Основной тезис:

> Собираю сайты, ботов и backend, которые работают.

Поддержка:

> От архитектуры и API до интерфейса, запуска и поддержки.

Предлагаемая услуга — не «любой код на заказ», а цельный цифровой продукт с сильной Python/backend-основой:

- сайты и web-интерфейсы;
- Telegram/MAX-боты;
- backend и REST API;
- базы данных и интеграции;
- Docker, CI/CD и production-сопровождение;
- MVP и развитие существующих систем.

## 2. Аудитория и действие

Основная аудитория:

- предприниматели с продуктовой задачей;
- небольшие продуктовые команды;
- агентства, которым нужен backend/full-cycle партнёр.

Главное действие — написать Дмитрию в Telegram: `@zverev_dmitry`.

Формы, CAPTCHA, CRM-widget и серверная часть для лендинга не нужны.

## 3. Структура страницы

### Экран 1 — profile

Содержит:

- роль `product_engineer`;
- основной тезис;
- короткий стек `Python / FastAPI / React / TypeScript / Docker`;
- прямое обещание полного цикла;
- CTA «написать»;
- anchor «проекты»;
- компактную ASCII-схему `request → site/API → bot/data → ready`.

Desktop выглядит как полный Neovim editor с explorer. Mobile сохраняет buffer, номера строк, tabline и statusline.

### Экран 2 — проекты

Три собственных проекта:

1. **Реппи** — фитнес-приложение с AI-функциями.
2. **Маяк** — утилита анализа безопасности сайта.
3. **Recall** — подготовка к собеседованиям через карточки и интервальное повторение.

Каждый проект — нативный раскрывающийся buffer. Первый открыт по умолчанию. Подробности и неподтверждённые факты ведутся в [content-inventory.md](./content-inventory.md).

### Экран 3 — контакт

Большой финальный тезис:

> Есть задача? Давай соберём.

Контакт оформлен как команда:

```text
: telegram @zverev_dmitry
```

Дополнительно показаны GitHub, Москва/remote и короткое описание специализации.

## 4. Технология страницы

- Astro static output;
- TypeScript только для сборки и типизированного контента;
- Astro components;
- CSS Modules и глобальные tokens;
- локальный `DVZ Mono Nerd` web-subset с системным monospace fallback;
- нативные `<details>` для проектов;
- без React runtime;
- без API, SSR, базы данных и serverless;
- готовый `dist/` позже публикуется на существующем VPS.

Схема будущей публикации находится в [deployment-target.md](./deployment-target.md).

## 5. Производительность

Текущая production-сборка после перехода на Neovim-концепцию:

| Ресурс                |   Brotli |
| --------------------- | -------: |
| HTML                  |  2,65 KB |
| CSS                   |  3,61 KB |
| JavaScript            |  0,38 KB |
| Nerd Font (оба WOFF2) | 17,62 KB |

Бюджеты:

- весь JavaScript ≤ 30 KB;
- весь CSS ≤ 20 KB;
- критический первый экран ≤ 110 KB;
- весь лендинг после lazy-load ≤ 700 KB;
- Lighthouse Performance release gate ≥ 90;
- доступность release gate ≥ 95.

Полные требования: [performance-budget.md](./performance-budget.md).

## 6. Доказательства и контент

Подтверждённый профиль:

- более трёх лет коммерческой Python-разработки;
- более 2,5 лет в B2B SaaS;
- FastAPI, Django/DRF, PostgreSQL, MySQL;
- SQLAlchemy, Alembic, Redis, Celery, TaskIQ;
- RabbitMQ, Kafka, WebSocket;
- Docker, CI/CD, Jenkins, Linux;
- Prometheus, Grafana, OpenTelemetry;
- React, TypeScript и JavaScript;
- базовый Golang для CLI.

Полный источник истины: [content-inventory.md](./content-inventory.md).

## 7. Что нужно уточнить для следующей итерации

Для каждого проекта:

1. Точная пользовательская проблема.
2. Личная роль Дмитрия.
3. Реальный стек.
4. Самое сложное техническое решение.
5. Стадия продукта.
6. Ссылка на demo или GitHub.
7. Один проверяемый результат.

Без этих данных не добавляем новые маркетинговые экраны. Лучше три честных строки, чем длинный выдуманный кейс.

## 8. Проверка перед публикацией

- production build;
- Astro typecheck;
- ESLint;
- unit tests;
- Playwright smoke tests;
- no-JavaScript test;
- accessibility test;
- desktop/mobile visual review;
- Brotli/Gzip precompression;
- size budget и runtime dependency check;
- canonical, sitemap, robots и structured data;
- Telegram/GitHub links;
- HTTPS и redirects на WWW.

## 9. Будущие улучшения

Только после запуска и реальной обратной связи:

- ссылки или screenshots проектов;
- отдельная подробная страница сильнейшего кейса;
- маленький блок коммерческого B2B-опыта;
- английская версия;
- лёгкая аналитика после отдельного решения;
- дополнительные страницы только при наличии поискового спроса.

## 10. Отдельный будущий продукт

AI-бот для Telegram-канала не является частью frontend. Он позже разворачивается отдельным Python-сервисом и может использовать OpenRouter как AI-провайдер.

План: [future-content-bot.md](./future-content-bot.md).
