# Целевая публикация

Статус: параметры зафиксированы, развёртывание отложено  
Production URL: `https://www.dvzverev.ru/`  
Инфраструктура: существующий VPS

## 1. Граница проекта

Лендинг состоит только из статического frontend:

- HTML;
- минимизированный CSS;
- небольшой нативный JavaScript;
- SVG;
- локальные WOFF2-шрифты;
- оптимизированные AVIF/WebP-изображения.

На production не нужны Node.js, Python, база данных, API, SSR, serverless functions или постоянно работающий application process. Astro используется только во время сборки и создаёт готовую папку `dist/`.

## 2. Домен

- основной адрес: `https://www.dvzverev.ru/`;
- canonical на всех страницах: `https://www.dvzverev.ru/...`;
- `http://dvzverev.ru`, `https://dvzverev.ru` и `http://www.dvzverev.ru` должны делать постоянный redirect на HTTPS WWW-версию;
- sitemap, Open Graph URL и structured data используют WWW-адрес;
- HSTS включается после проверки HTTPS и redirect-цепочки.

DNS и VPS сейчас не изменяются. Записи, web server и сертификат настраиваются отдельным этапом публикации.

## 3. Предлагаемая схема VPS

```text
git/build machine
      │
      ├─ astro build
      ├─ minify + optimize
      ├─ generate .br/.gz assets
      └─ upload dist/
              │
              ▼
       existing VPS
              │
       Nginx or Caddy
              │
   https://www.dvzverev.ru/
```

Перед выбором конфигурации нужно проверить ОС, установленный web server и поддержку Brotli/Zstandard. До этой проверки не предполагаем, что на VPS уже есть Nginx, Caddy или нужные модули.

## 4. Требования к web server

- TLS 1.2/1.3 и автоматическое обновление сертификата;
- HTTP/2, HTTP/3 — если поддерживается текущим стеком VPS;
- приоритет Brotli для заранее сжатых текстовых ассетов, fallback на Gzip;
- отдача готовых `.br`/`.gz` файлов без сжатия на каждый запрос;
- hashed assets: `Cache-Control: public, max-age=31536000, immutable`;
- HTML: короткий cache/revalidation, чтобы обновления появлялись сразу;
- SVG, WOFF2, AVIF и WebP с корректными MIME types;
- отдельная страница 404;
- запрет directory listing;
- минимальные security headers: CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`;
- access/error logs без записи чувствительных query-параметров.

## 5. Фронтенд-контакт без backend

- главный CTA — обычная ссылка `https://t.me/zverev_dmitry`;
- дополнительный контакт — `mailto:` при решении показать email;
- JavaScript не нужен для открытия контакта;
- формы, CAPTCHA, webhook и сбор персональных данных на сайте отсутствуют;
- при необходимости мини-бриф можно копировать в буфер, но это необязательное улучшение.

## 6. Будущий процесс публикации

1. Провести read-only инвентаризацию VPS.
2. Проверить DNS-зону `dvzverev.ru`.
3. Выбрать Nginx или Caddy на основе уже установленного ПО.
4. Сделать production build локально или в CI.
5. Проверить bundle budget и Lighthouse на preview.
6. Загрузить новую версию в отдельную release-папку.
7. Переключить симлинк на release атомарно.
8. Проверить HTTPS, redirects, headers, cache и реальные страницы.
9. Сохранить предыдущий release для быстрого rollback.

Никакие действия из этого списка не выполняются до отдельной команды на публикацию.

## 7. Будущий content bot не меняет границу сайта

AI-бот для Telegram-канала описан в [future-content-bot.md](./future-content-bot.md). Позже он может работать отдельным контейнером или systemd unit на том же VPS, но:

- не обслуживает страницы лендинга;
- не добавляет API-вызовы в frontend;
- хранит секреты отдельно;
- разворачивается и откатывается независимо;
- его недоступность не влияет на `www.dvzverev.ru`.
