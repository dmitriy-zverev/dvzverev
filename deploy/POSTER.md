# Автопостер на cloudru

Развёрнут 6 октября 2026 в `/opt/dvzverev-poster`. Контейнер `dvzverev-poster`.
Другие приложения сервера не перезапускаются. Локальный контейнер остановлен и
имеет `restart=no`: одновременно должен работать только один планировщик.

## Проверка и управление

```sh
ssh cloudru
cd /opt/dvzverev-poster
docker compose ps
docker compose logs --tail=100 poster
docker compose exec -T poster node bot/run.mjs --project dark-academia --status
docker compose exec -T poster node bot/run.mjs --project code-to-think --status
docker compose stop poster
docker compose up -d --no-deps poster
```

Ошибки: `data/logs/errors.jsonl` (с ротацией). Сначала запись с fsync,
затем Telegram владельцу. Если журнал недоступен, запись идёт в stderr Docker.
Секреты и URL скрываются. Telegram недоступен — уведомление ожидает backoff;
исход с неопределённой доставкой не повторяется автоматически.

Состояние: `data/projects/<projectId>/state.json`. Не редактировать и не удалять
его ради повторной публикации: `uncertain` требует сверки стены VK.
`--status` — чтение, `--publish-next` может создать настоящий пост.

## Секреты и сеть

`.env` имеет права 600, каталог 700. Образ не содержит ключей.
Перенесены ключи сообществ VK, OpenRouter и Telegram. Пользовательские токены,
OAuth-сессии и refresh_token исключены. Runtime не читает VK user token.

VK вызывается напрямую. OpenRouter и Telegram работают через выделенный Squid
на латвийском VPS: порт 3129, только CONNECT/443, только эти два домена,
только IP cloudru. Существующий прокси 3128 не изменён.
Настройки: `deploy/openrouter-proxy/autoposter.conf`,
`deploy/openrouter-proxy/squid-autoposter.service`.

## Обновление и откат

Сначала остановить **только** poster, сохранить конфигурацию и data, собрать и
протестировать образ, загрузить его на сервер, изменить `BOT_IMAGE` в `.env`,
затем `docker compose up -d --no-deps poster`. Проверить health и журнал.
Для отката выбрать предыдущий image tag. Состояние доставки не откатывать:
это может продублировать уже опубликованные посты. Старые migration-архивы
не распаковывать поверх действующего data.

Первоначальные резервные копии лежат в `backups/`. Перед обновлениями создавать
копии при остановленном poster; шифрованное регулярное хранение вне сервера
пока не настроено. Копии содержат конфигурацию и историю, доступ к ним ограничен.

## Ограничения

Контейнер: 256 МБ, 0.5 CPU, read-only rootfs, PID limit 64. Healthcheck проверяет
heartbeat; watchdog завершает зависший цикл после 10 минут без прогресса.
Docker restart помогает при завершении процесса, но сам статус unhealthy
не перезапускает контейнер. Полное отключение сервера требует внешнего мониторинга.

Бюджеты service.json пока не являются жёстким финансовым лимитом.
Подробная статистика охвата VK ключом сообщества недоступна.
Неизвестные показатели остаются null, коммерческие данные импортируются вручную.

Результаты ревью: [bot/RELIABILITY_REVIEW.md](../bot/RELIABILITY_REVIEW.md).
