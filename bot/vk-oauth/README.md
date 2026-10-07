# VK user OAuth — экспериментальный модуль кабинета

Цель: новая локальная JPG/PNG → настоящий `photo` → пост пользователя или сообщества. Регулярный poster пока продолжает использовать community keys. Модуль отключён по умолчанию; прежде чем менять production, нужен реальный OAuth и тест прав приложения.

## Подключение

1. В кабинете **VK ID**, а не Mini Apps, разрешить `https://www.dvzverev.ru/vk/callback/`. Используется новое приложение «Постер dvzverev», ID `54809454`, указанное пользователем. Mini App `54805806` — другое приложение.
2. Перенести [.env.example](.env.example) в закрытый `.env` кабинета, заполнить подтверждённый client ID. `wall photos groups video` — экспериментальный запрос scopes, не гарантия доступности.
3. Один раз сгенерировать `VK_OAUTH_ENCRYPTION_KEY` командой из примера. Не менять при релизе; хранить резервную копию ключа отдельно от БД. Без старого ключа токены не восстановятся.
4. Собрать из корня: `docker build -f bot/Dockerfile -t dvzverev-poster:vk-oauth .`. Использовать `bot/compose.production.yaml`, `BOT_IMAGE=dvzverev-poster:vk-oauth`, сервис `cabinet` и уже настроенные кабинет/Redis/БД. Включить `VK_OAUTH_ENABLED=true`. Только **одна реплика кабинета** на OAuth volume. Для MP4 выставить `BOT_CABINET_MEMORY_LIMIT=256m`.
5. Проксировать `/vk/*` **только на домене dvzverev** в `dvzverev-cabinet:8787`. Access logs callback должны исключать query string, содержащую code. URL callback не использовать как аналитическую страницу.
6. Войти в кабинет, открыть `/vk/login` в том же браузере. Пользователь сам выполняет стандартный вход на стороне VK. Пароли и cookies VK сервер не получает.
7. Callback проверяет сессию кабинета, одноразовый state (10 минут), PKCE, state ответа VK и identity через `users.get`, сохраняет зашифрованные токены. Привязанный аккаунт нельзя незаметно заменить другим.

## API

Все маршруты требуют `cabinet_session`. POST требует разрешённый `Origin`. Alias `/bot/api/v1/vk/...` тоже поддерживается; зарегистрированный callback должен точно совпадать с `VK_OAUTH_REDIRECT_URI`.

| Маршрут                             | Действие                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| GET `/vk/login`                     | Redirect с PKCE                                                                 |
| GET `/vk/callback`                  | Обмен code; токены не возвращаются браузеру                                     |
| GET `/vk/status`                    | User ID, срок действия, наличие refresh, выданный scope                         |
| GET `/vk/capabilities?group_id=123` | Permissions, identity, управляемые группы, photo upload session; без публикации |
| POST `/vk/refresh`                  | Принудительное обновление для POC                                               |
| POST `/vk/upload/photo`             | JSON: `target_type`, `target_id`, `filename`                                    |
| POST `/vk/upload/video`             | То же, MP4; **обычное видео, не Clip**                                          |
| POST `/vk/posts`                    | JSON: `target_type`, `target_id`, `message`, `attachment`, `guid`               |

`target_type=user|group`, `target_id` — положительный числовой ID. Для user разрешён только вошедший пользователь. Для группы применяются его реальные права в VK. Приложение одно, group ID передаётся каждому вызову.

Файлы кладутся на сервер приложения в `content/oauth/` — без ручной загрузки во VK. Cabinet получает read-only mount. Принимаются только имена внутри `VK_OAUTH_MEDIA_DIR`; traversal и symlink escape запрещены. JPG/PNG и MP4 не более 64 MiB. Upload URL только HTTPS на доменах VK; redirects запрещены.

После upload использовать возвращённый `attachment`:

```json
{
  "target_type": "group",
  "target_id": 123,
  "message": "Тест новой фотографии",
  "attachment": "photo-123_456",
  "guid": "unique-test-post-20261007-1"
}
```

`attachmentVerified` проверяет наличие объекта через `wall.getById`. Внешний вид дополнительно проверить в VK. При успехе post и сбое проверки возвращаются ID/URL и `verificationError`, повторный пост не создаётся.

## Надёжность и проверка

- Refresh перед API-запросом за пять минут до expiry. При error 5 — один refresh и один повтор; ошибки прав и сетевой timeout публикации автоматически не повторяются.
- Кабинет дополнительно проверяет токен в фоне раз в минуту, даже без открытого браузера. Ошибки refresh идут сначала в логи, затем в Telegram; паузы между попытками растут от одной минуты до часа. Фоновый процесс и HTTP используют один broker.
- Rotation refresh/device ID сохраняется атомарно. Одновременные вызовы внутри broker используют один refresh.
- AES-256-GCM; SQLite 0600, новый каталог 0700, persistent volume. После рестарта токены сохраняются.
- GUID записывается до отправки. Известный успех возвращает прежний результат; неизвестный исход требует ручной проверки. Не генерировать новый GUID для обхода блокировки.
- Ошибки идут в общий `errors.jsonl`; сырые provider responses / request_params, code, токены и upload URL не логируются.
- VK может отозвать/ограничить refresh; вечная авторизация не гарантируется.
- Прогнать OAuth/status/capabilities, новую фотографию в профиле и двух группах, force refresh, restart. Проверка через сутки требует реального времени, не unit test.

`node --test tests/bot/vk-oauth.test.mjs` на Node 22 проверяет mock API, временную зашифрованную БД и защиту от дублей. Реальных публикаций эти тесты не создают. Статус исследования — [VK_CAPABILITIES.md](VK_CAPABILITIES.md).
