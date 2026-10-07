# VK capabilities — 7 октября 2026

API `5.199`. Реальный OAuth пройден 2026-10-07 через production callback. Приложение выдало только `vkid.personal_info`, хотя запрос содержал `wall photos groups video`. Это успешная авторизация, но не подтверждение доступа к публикациям.

## Результат реальной проверки на cloudru

- Пользовательский ID: `83357715`; `users.get` успешно проверил identity при callback.
- Access и refresh сохранены в зашифрованной persistent SQLite. Токены, code и upload URL в отчёт не включены.
- Принудительный refresh через единственный production broker: HTTP 200, новый expiry, refresh доступен; scope остался `vkid.personal_info`.
- `account.getAppPermissions`, `utils.resolveScreenName`, `groups.get`: отказ `1051`.
- `photos.getWallUploadServer` для профиля: отказ `15`, upload URL не получен.
- Ошибки записаны в логи; отчёт отправлен в настроенный Telegram-бот. Публикаций через этот OAuth не создано.
- Не установлено, каким способом VK разрешит расширенные API-доступы именно этому приложению. Повторный refresh не расширяет scope. Поддержка не считается обязательным следующим шагом: сначала проверяем собственное Mini App и VK Bridge, как описано ниже.

## Проверка способов без поддержки

### Новый пользовательский токен приложения 54809516

После включения приложения на dev.vk.ru пользователь прошёл авторизацию в собственном браузере и сохранил токен локально в `bot/.env` (`VK_PHOTOS_ACCESS_TOKEN`). Проверено 2026-10-07 без публикаций:

- `users.get`: пользователь `83357715`.
- `account.getAppPermissions`: маска `270340`, содержит `wall`, `photos`, `groups`.
- `groups.get(filter=admin)`: 5 сообществ.
- `photos.getWallUploadServer` для собственного профиля: upload URL получен, в вывод не включён.
- `utils.resolveScreenName(veshi_kstati)`: это профиль пользователя `894650885`, а не сообщество и не авторизованный пользователь. Доступ к публикации на его стене этим тестом не подтверждён.

Это отдельный пользовательский VK API токен приложения `54809516`, а не VK ID токен приложения `54809454`. Refresh token и срок действия для нового токена не предоставлены; переносить на него проверенный refresh VK ID другого приложения нельзя. Токен не переносился на production, production-постер не переключался.

2026-10-07 выполнены анонимные HTTP-запросы к `https://oauth.vk.com/authorize`; вход, согласие и выдача токена не выполнялись.

| Приложение          | Запрос                                                                                      | Фактический ответ                                      |
| ------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| VK ID `54809454`    | Implicit Flow, `wall,photos,groups,offline`, `redirect_uri=https://oauth.vk.com/blank.html` | HTTP 401, `invalid_request`, `Security Error`          |
| Mini App `54805806` | Те же параметры                                                                             | HTTP 401, `invalid_request`, `invalid scope`           |
| Mini App `54805806` | Без `offline`: `wall,photos,groups`                                                         | HTTP 401, `invalid_request`, `application is disabled` |

Ответ `application is disabled` — основание проверить включение Mini App в кабинете разработчика. Он не доказывает, что после включения права будут выданы или токен будет бессрочным.

Официальный [VK Bridge](https://github.com/VKCOM/vk-bridge/blob/master/packages/core/src/types/data.ts) определяет:

- `PersonalAuthScope`: в том числе `wall`, `photos`, `groups`, `video`; `offline` в перечислении отсутствует.
- `VKWebAppCheckAllowedScopes({ scopes })`: результат — список `{ scope, allowed }` для проверки доступности запрашиваемых прав.
- `VKWebAppGetAuthToken({ app_id, scope })`: ответ содержит `access_token`, `scope`, необязательный `expires`; `refresh_token` в типе ответа отсутствует.

Следующий тест выполняется **внутри собственного Mini App в VK**, с согласием владельца:

```js
await bridge.send('VKWebAppInit');
const allowed = await bridge.send('VKWebAppCheckAllowedScopes', {
  scopes: 'wall,photos,groups',
});
// Сначала показать allowed владельцу. Не запрашивать запрещённые права.
const auth = await bridge.send('VKWebAppGetAuthToken', {
  app_id: 54805806,
  scope: 'wall,photos,groups',
});
// Не выводить auth/access_token в консоль и логи.
```

После получения проверить фактические `scope`, срок действия и read-only методы `account.getAppPermissions`, `groups.get`, `photos.getWallUploadServer`. До этой проверки Mini App/Bridge — кандидат, а не подтверждённая авторизация для постоянного серверного автопостинга. Не передавать этот токен в VK ID refresh другого приложения.

Пользовательская страница документации токенов VK ID не прочитана: web-инструмент не получил содержимое, браузер заблокировал URL политикой безопасности. Выводы выше основаны на официальном коде VK Bridge и фактических HTTP-ответах, а не на предположении о содержимом этой страницы.

## Проверенные источники

- [Официальный VK ID SDK](https://github.com/VKCOM/vkid-web-sdk/blob/master/src/auth/auth.ts): PKCE, state, code exchange и refresh с client/device ID, проверка state ответа. Просмотрен 2026-10-07.
- [URL construction](https://github.com/VKCOM/vkid-web-sdk/blob/master/src/utils/url/url.ts) и [domains](https://github.com/VKCOM/vkid-web-sdk/blob/master/src/constants.ts): VK ID domain `id.vk.ru`.
- Официальные [Photos](https://github.com/VKCOM/vk-api-schema/blob/master/photos/methods.json), [Wall](https://github.com/VKCOM/vk-api-schema/blob/master/wall/methods.json), [Video](https://github.com/VKCOM/vk-api-schema/blob/master/video/methods.json): реально загружены и разобраны 2026-10-07.
- Пользователь создал новое приложение «Постер dvzverev», ID `54809454`, callback `https://www.dvzverev.ru/vk/callback/`. Mini App `54805806` не используется.

Upload/save методы указаны с `access_token_type=[user]`. `wall.post` также указан `[user]`, хотя в ранее выполненных реальных тестах community token работал. Расхождение зафиксировано: JSON Schema не является гарантией фактического доступа.

| Возможность          | Кандидат scope/permission                 | Методы                                                                    | Работает фактически                                         |
| -------------------- | ----------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Login и refresh      | Настройки выбранного приложения           | `/authorize`, `/oauth2/auth`                                              | Реальные login и принудительный refresh успешны             |
| Identity             | User token                                | `users.get`                                                               | Реальная identity проверена                                 |
| Управляемые группы   | `groups`, требует проверки                | `groups.get(filter=admin,editor)`                                         | Реальный отказ 1051                                         |
| Новое фото в профиль | `photos`, `wall`, требует проверки        | `photos.getWallUploadServer`, upload, `photos.saveWallPhoto`, `wall.post` | Первый этап: реальный отказ 15                              |
| Новое фото в группу  | Те же scopes, права пользователя в группе | Те же методы с `group_id` и отрицательным wall owner                      | Только mock flow; `veshi_kstati` выбран для реального теста |
| Несколько групп      | Права в каждой группе                     | Те же методы, другой group ID                                             | Реальный тест двух групп не выполнен                        |
| Обычное MP4          | `video`, `wall`, требует проверки         | `video.save`, multipart `video_file`, `wall.post`                         | Код POC есть; реальный тест не выполнен                     |
| Именно Clip          | Не установлен                             | Подтверждённый публичный create/publish flow не найден                    | Не установлено                                              |

Строка scope принимается SDK, но доступность `wall photos groups video` новому приложению нужно проверить после входа через выданный scope, `account.getAppPermissions` и реальные API-запросы.

## Клипы

В разобранных разделах methods `photos`, `wall`, `video` нет метода с `clip` или `short` в имени. Объект `clip` не доказывает наличие метода создания. `publish_clip` не реализован; обычный MP4 не считается Clip. Категорический вывод «API не существует» **пока не доказан**: официальная документация частично недоступна, схема не отражает все фактические возможности (см. wall.post). Нужны доступная официальная документация/ответ VK либо подтверждённый официальный flow. Закрытые endpoints, cookies VK и автоматический login не используются.

## Что осталось для P0

1. Уточнить у VK, как получить расширенные API-доступы для приложения 54809454. Client ID/callback, обычный OAuth и force refresh уже проверены.
2. После изменения доступов пройти новое согласие и повторно проверить реальные права.
3. Новый локальный JPG/PNG в `veshi_kstati`: upload, post, API attachment verification, визуальная проверка.
4. Проверить профиль и вторую группу — пока пользователь указал одну цель.
5. Force refresh, rotation, restart Docker, фактический повтор через сутки.

Community-only обходы из задания приняты как ранее подтверждённые; повторно не тестировались. Production poster пока не переключён на user OAuth.
