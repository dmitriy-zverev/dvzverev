# VK capabilities — 7 октября 2026

API `5.199`. Реальный пользовательский OAuth **ещё не пройден**. Код и mock-тесты не доказывают получение нужных прав приложением.

## Проверенные источники

- [Официальный VK ID SDK](https://github.com/VKCOM/vkid-web-sdk/blob/master/src/auth/auth.ts): PKCE, state, code exchange и refresh с client/device ID, проверка state ответа. Просмотрен 2026-10-07.
- [URL construction](https://github.com/VKCOM/vkid-web-sdk/blob/master/src/utils/url/url.ts) и [domains](https://github.com/VKCOM/vkid-web-sdk/blob/master/src/constants.ts): VK ID domain `id.vk.ru`.
- Официальные [Photos](https://github.com/VKCOM/vk-api-schema/blob/master/photos/methods.json), [Wall](https://github.com/VKCOM/vk-api-schema/blob/master/wall/methods.json), [Video](https://github.com/VKCOM/vk-api-schema/blob/master/video/methods.json): реально загружены и разобраны 2026-10-07.
- Пользователь создал новое приложение «Постер dvzverev», ID `54809454`, callback `https://www.dvzverev.ru/vk/callback/`. Mini App `54805806` не используется.

Upload/save методы указаны с `access_token_type=[user]`. `wall.post` также указан `[user]`, хотя в ранее выполненных реальных тестах community token работал. Расхождение зафиксировано: JSON Schema не является гарантией фактического доступа.

| Возможность          | Кандидат scope/permission                 | Методы                                                                    | Работает фактически                                         |
| -------------------- | ----------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Login и refresh      | Настройки выбранного приложения           | `/authorize`, `/oauth2/auth`                                              | SDK проверен; наш реальный OAuth ещё нет                    |
| Identity             | User token                                | `users.get`                                                               | Только mock                                                 |
| Управляемые группы   | `groups`, требует проверки                | `groups.get(filter=admin,editor)`                                         | Не проверено                                                |
| Новое фото в профиль | `photos`, `wall`, требует проверки        | `photos.getWallUploadServer`, upload, `photos.saveWallPhoto`, `wall.post` | Только mock flow                                            |
| Новое фото в группу  | Те же scopes, права пользователя в группе | Те же методы с `group_id` и отрицательным wall owner                      | Только mock flow; `veshi_kstati` выбран для реального теста |
| Несколько групп      | Права в каждой группе                     | Те же методы, другой group ID                                             | Реальный тест двух групп не выполнен                        |
| Обычное MP4          | `video`, `wall`, требует проверки         | `video.save`, multipart `video_file`, `wall.post`                         | Код POC есть; реальный тест не выполнен                     |
| Именно Clip          | Не установлен                             | Подтверждённый публичный create/publish flow не найден                    | Не установлено                                              |

Строка scope принимается SDK, но доступность `wall photos groups video` новому приложению нужно проверить после входа через выданный scope, `account.getAppPermissions` и реальные API-запросы.

## Клипы

В разобранных разделах methods `photos`, `wall`, `video` нет метода с `clip` или `short` в имени. Объект `clip` не доказывает наличие метода создания. `publish_clip` не реализован; обычный MP4 не считается Clip. Категорический вывод «API не существует» **пока не доказан**: официальная документация частично недоступна, схема не отражает все фактические возможности (см. wall.post). Нужны доступная официальная документация/ответ VK либо подтверждённый официальный flow. Закрытые endpoints, cookies VK и автоматический login не используются.

## Что осталось для P0

1. Подтвердить VK ID client ID и callback, пройти обычный OAuth.
2. Проверить права; отказ записать как код ошибки без request_params и уточнить доступы приложения у VK.
3. Новый локальный JPG/PNG в `veshi_kstati`: upload, post, API attachment verification, визуальная проверка.
4. Проверить профиль и вторую группу — пока пользователь указал одну цель.
5. Force refresh, rotation, restart Docker, фактический повтор через сутки.

Community-only обходы из задания приняты как ранее подтверждённые; повторно не тестировались. Production poster пока не переключён на user OAuth.
