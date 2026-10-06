# VK API: ключ сообщества

Дата: 6 октября 2026. Сообщество: `242034586`. Версия запросов: `5.199`.

## Поддержка типа токена и фактическая доступность

В [официальной схеме](https://github.com/VKCOM/vk-api-schema/tree/333481bd082ad747d4873ef4a77f9247097eeef0) найдено **112 методов** с `group` в `access_token_type`. Это поддержка типа токена, а не гарантия успешного вызова нашим ключом: дополнительно действуют права, настройки сообщества, ограничения объектов и продукта. Схема не содержит полной связи между методами и правами.

Ключи, access_key и подписанные URL в документ не включены.

## Права нашего ключа

`groups.getTokenPermissions` проверен в работающем Docker-контейнере только через `VK_ACCESS_TOKEN`. Маска: `134623237`.

| Право    |  Значение |
| -------- | --------: |
| photos   |         4 |
| docs     |    131072 |
| messages |      4096 |
| wall     |      8192 |
| manage   |    262144 |
| stories  |         1 |
| market   | 134217728 |

## Проверенные возможности и ограничения

- `groups.getById`, `groups.getTokenPermissions`, `utils.getServerTime`, `docs.getById`: работают; методы чтения повторно проверены 6 октября.
- `docs.getWallUploadServer` → multipart POST с полем `file` → `docs.save`: новый JPG загружен и сохранён только ключом сообщества. Получен `doc-242034586_706999992`, превью до 1280×720.
- `wall.post`: текст публикуется, публичная фотография прикрепляется. Создан пост №13 с JPG-документом; пользователь подтвердил, что он отображается ссылкой на файл без большого превью.
- `photos.getMessagesUploadServer` → `photos.saveMessagesPhoto`: загрузка работает. Полученное фото не удалось прикрепить к стене ни с access_key, ни без него.
- `wall.get` и `photos.getWallUploadServer`: повторно проверены, код 27 — метод недоступен для ключа сообщества.
- `wall.getById`, `photos.getById`, `photos.get`: ранее также возвращали код 27 для нашего ключа.

**Расхождение схемы и API:** `wall.post` отсутствует среди методов с `group` в зафиксированной схеме, хотя наши реальные публикации работают. Он указан отдельно после каталога. Поэтому список схемы не исчерпывает фактическое поведение API.

## Все методы из схемы

«Не проверен» означает только поддержку group token по схеме; реальный доступ нашего ключа не установлен. Изменяющие методы ради инвентаризации не вызывались. Обязательные параметры приведены по схеме; общие `access_token` и `v` не повторяются.

### appWidgets — 6

[Источник](https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/appWidgets/methods.json)

| Метод                                  | Обязательные параметры | Статус      |
| -------------------------------------- | ---------------------- | ----------- |
| `appWidgets.getAppImages`              | —                      | Не проверен |
| `appWidgets.getGroupImageUploadServer` | `image_type`           | Не проверен |
| `appWidgets.getGroupImages`            | —                      | Не проверен |
| `appWidgets.getImagesById`             | `images`               | Не проверен |
| `appWidgets.saveGroupImage`            | `hash`, `image`        | Не проверен |
| `appWidgets.update`                    | `code`, `type`         | Не проверен |

### board — 2

[Источник](https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/board/methods.json)

| Метод                  | Обязательные параметры               | Статус      |
| ---------------------- | ------------------------------------ | ----------- |
| `board.deleteComment`  | `group_id`, `topic_id`, `comment_id` | Не проверен |
| `board.restoreComment` | `group_id`, `topic_id`, `comment_id` | Не проверен |

### docs — 5

[Источник](https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/docs/methods.json)

| Метод                          | Обязательные параметры | Статус                      |
| ------------------------------ | ---------------------- | --------------------------- |
| `docs.getById`                 | `docs`                 | Проверен: документ читается |
| `docs.getMessagesUploadServer` | —                      | Не проверен                 |
| `docs.getWallUploadServer`     | —                      | Проверен: сервер получен    |
| `docs.save`                    | `file`                 | Проверен: JPG сохранён      |
| `docs.search`                  | —                      | Не проверен                 |

### execute — 1

[Источник](https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/execute/methods.json)

| Метод     | Обязательные параметры | Статус      |
| --------- | ---------------------- | ----------- |
| `execute` | —                      | Не проверен |

### groups — 29

[Источник](https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/groups/methods.json)

| Метод                                | Обязательные параметры                                             | Статус                    |
| ------------------------------------ | ------------------------------------------------------------------ | ------------------------- |
| `groups.addAddress`                  | `group_id`, `title`, `address`, `city_id`, `latitude`, `longitude` | Не проверен               |
| `groups.addCallbackServer`           | `group_id`, `url`, `title`                                         | Не проверен               |
| `groups.deleteAddress`               | `group_id`, `address_id`                                           | Не проверен               |
| `groups.deleteCallbackServer`        | `group_id`, `server_id`                                            | Не проверен               |
| `groups.disableOnline`               | `group_id`                                                         | Не проверен               |
| `groups.edit`                        | `group_id`                                                         | Не проверен               |
| `groups.editAddress`                 | `group_id`, `address_id`                                           | Не проверен               |
| `groups.editCallbackServer`          | `group_id`, `server_id`, `url`, `title`                            | Не проверен               |
| `groups.enableOnline`                | `group_id`                                                         | Не проверен               |
| `groups.getBanned`                   | `group_id`                                                         | Не проверен               |
| `groups.getById`                     | —                                                                  | Проверен: работает        |
| `groups.getCallbackConfirmationCode` | `group_id`                                                         | Не проверен               |
| `groups.getCallbackServers`          | `group_id`                                                         | Не проверен               |
| `groups.getCallbackSettings`         | `group_id`                                                         | Не проверен               |
| `groups.getLongPollServer`           | `group_id`                                                         | Не проверен               |
| `groups.getLongPollSettings`         | `group_id`                                                         | Не проверен               |
| `groups.getMembers`                  | —                                                                  | Не проверен               |
| `groups.getOnlineStatus`             | `group_id`                                                         | Не проверен               |
| `groups.getTagList`                  | `group_id`                                                         | Не проверен               |
| `groups.getTokenPermissions`         | —                                                                  | Проверен: права прочитаны |
| `groups.isMember`                    | `group_id`                                                         | Не проверен               |
| `groups.setCallbackSettings`         | `group_id`                                                         | Не проверен               |
| `groups.setLongPollSettings`         | `group_id`                                                         | Не проверен               |
| `groups.setSettings`                 | `group_id`                                                         | Не проверен               |
| `groups.setUserNote`                 | `group_id`, `user_id`                                              | Не проверен               |
| `groups.tagAdd`                      | `group_id`, `tag_name`                                             | Не проверен               |
| `groups.tagBind`                     | `group_id`, `tag_id`, `user_id`, `act`                             | Не проверен               |
| `groups.tagDelete`                   | `group_id`, `tag_id`                                               | Не проверен               |
| `groups.tagUpdate`                   | `group_id`, `tag_id`, `tag_name`                                   | Не проверен               |

### market — 4

[Источник](https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/market/methods.json)

| Метод                   | Обязательные параметры | Статус      |
| ----------------------- | ---------------------- | ----------- |
| `market.editOrder`      | `user_id`, `order_id`  | Не проверен |
| `market.getGroupOrders` | —                      | Не проверен |
| `market.getOrderById`   | `order_id`             | Не проверен |
| `market.getOrderItems`  | `order_id`             | Не проверен |

### messages — 36

[Источник](https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/messages/methods.json)

| Метод                                  | Обязательные параметры                | Статус      |
| -------------------------------------- | ------------------------------------- | ----------- |
| `messages.createChat`                  | —                                     | Не проверен |
| `messages.delete`                      | —                                     | Не проверен |
| `messages.deleteChatPhoto`             | `chat_id`                             | Не проверен |
| `messages.deleteConversation`          | —                                     | Не проверен |
| `messages.deleteReaction`              | `peer_id`, `cmid`                     | Не проверен |
| `messages.edit`                        | `peer_id`                             | Не проверен |
| `messages.editChat`                    | `chat_id`                             | Не проверен |
| `messages.getByConversationMessageId`  | `peer_id`, `conversation_message_ids` | Не проверен |
| `messages.getById`                     | —                                     | Не проверен |
| `messages.getConversationMembers`      | `peer_id`                             | Не проверен |
| `messages.getConversations`            | —                                     | Не проверен |
| `messages.getConversationsById`        | `peer_ids`                            | Не проверен |
| `messages.getHistory`                  | —                                     | Не проверен |
| `messages.getHistoryAttachments`       | —                                     | Не проверен |
| `messages.getImportantMessages`        | —                                     | Не проверен |
| `messages.getIntentUsers`              | `intent`                              | Не проверен |
| `messages.getInviteLink`               | `peer_id`                             | Не проверен |
| `messages.getLongPollHistory`          | —                                     | Не проверен |
| `messages.getLongPollServer`           | —                                     | Не проверен |
| `messages.getMessagesReactions`        | `peer_id`, `cmids`                    | Не проверен |
| `messages.getReactedPeers`             | `peer_id`, `cmid`                     | Не проверен |
| `messages.isMessagesFromGroupAllowed`  | `group_id`, `user_id`                 | Не проверен |
| `messages.markAsAnsweredConversation`  | `peer_id`                             | Не проверен |
| `messages.markAsImportantConversation` | `peer_id`                             | Не проверен |
| `messages.markAsRead`                  | —                                     | Не проверен |
| `messages.pin`                         | `peer_id`                             | Не проверен |
| `messages.removeChatUser`              | `chat_id`                             | Не проверен |
| `messages.restore`                     | —                                     | Не проверен |
| `messages.search`                      | —                                     | Не проверен |
| `messages.searchConversations`         | —                                     | Не проверен |
| `messages.send`                        | —                                     | Не проверен |
| `messages.sendMessageEventAnswer`      | `event_id`, `user_id`, `peer_id`      | Не проверен |
| `messages.sendReaction`                | `peer_id`, `cmid`, `reaction_id`      | Не проверен |
| `messages.setActivity`                 | —                                     | Не проверен |
| `messages.setChatPhoto`                | `file`                                | Не проверен |
| `messages.unpin`                       | `peer_id`                             | Не проверен |

### photos — 5

[Источник](https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/photos/methods.json)

| Метод                                   | Обязательные параметры | Статус                                              |
| --------------------------------------- | ---------------------- | --------------------------------------------------- |
| `photos.getChatUploadServer`            | `chat_id`              | Не проверен                                         |
| `photos.getMessagesUploadServer`        | —                      | Проверен: сервер получен                            |
| `photos.getOwnerCoverPhotoUploadServer` | —                      | Не проверен                                         |
| `photos.saveMessagesPhoto`              | `photo`                | Проверен: фото сохранено; на стене не прикрепляется |
| `photos.saveOwnerCoverPhoto`            | —                      | Не проверен                                         |

### podcasts — 1

[Источник](https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/podcasts/methods.json)

| Метод                    | Обязательные параметры | Статус      |
| ------------------------ | ---------------------- | ----------- |
| `podcasts.searchPodcast` | `search_string`        | Не проверен |

### storage — 3

[Источник](https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/storage/methods.json)

| Метод             | Обязательные параметры | Статус      |
| ----------------- | ---------------------- | ----------- |
| `storage.get`     | —                      | Не проверен |
| `storage.getKeys` | —                      | Не проверен |
| `storage.set`     | `key`                  | Не проверен |

### stories — 11

[Источник](https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/stories/methods.json)

| Метод                          | Обязательные параметры | Статус      |
| ------------------------------ | ---------------------- | ----------- |
| `stories.delete`               | —                      | Не проверен |
| `stories.get`                  | —                      | Не проверен |
| `stories.getById`              | `stories`              | Не проверен |
| `stories.getPhotoUploadServer` | —                      | Не проверен |
| `stories.getReplies`           | `owner_id`, `story_id` | Не проверен |
| `stories.getStats`             | `owner_id`, `story_id` | Не проверен |
| `stories.getVideoUploadServer` | —                      | Не проверен |
| `stories.getViewers`           | `story_id`             | Не проверен |
| `stories.hideAllReplies`       | `owner_id`             | Не проверен |
| `stories.hideReply`            | `owner_id`, `story_id` | Не проверен |
| `stories.save`                 | —                      | Не проверен |

### users — 1

[Источник](https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/users/methods.json)

| Метод       | Обязательные параметры | Статус      |
| ----------- | ---------------------- | ----------- |
| `users.get` | —                      | Не проверен |

### utils — 5

[Источник](https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/utils/methods.json)

| Метод                     | Обязательные параметры | Статус             |
| ------------------------- | ---------------------- | ------------------ |
| `utils.checkLink`         | `url`                  | Не проверен        |
| `utils.getLinkStats`      | `key`                  | Не проверен        |
| `utils.getServerTime`     | —                      | Проверен: работает |
| `utils.getShortLink`      | `url`                  | Не проверен        |
| `utils.resolveScreenName` | `screen_name`          | Не проверен        |

### wall — 3

[Источник](https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/wall/methods.json)

| Метод                | Обязательные параметры | Статус      |
| -------------------- | ---------------------- | ----------- |
| `wall.closeComments` | `owner_id`, `post_id`  | Не проверен |
| `wall.createComment` | `post_id`              | Не проверен |
| `wall.openComments`  | `owner_id`, `post_id`  | Не проверен |

## Дополнительный проверенный метод

`wall.post` — создание поста с текстом и/или attachments. Проверен нашим ключом, но отсутствует среди group-методов выбранной схемы. [Документация](https://dev.vk.ru/ru/method/wall.post).

## Практические ограничения

- Методам виджетов и другим продуктовым методам могут понадобиться дополнительные условия приложения или сообщества; наличие group в схеме этого не подтверждает.
- Успешная загрузка фото не гарантирует возможность прикрепить его к стене.
- Успешный wall.post с текстом не доказывает сохранение всех переданных вложений.
- Отправка сообщений, удаление объектов, изменение настроек и заказов для составления этого списка не выполнялись.
- Вызов execute ограничен правами вложенных методов; он не расширяет разрешения ключа.

## Дополнительные варианты изображения: тесты 6 октября

| Вариант                                                    | Что подтверждено                                                                    | Подходит для нового изображения в посте                                                                                             |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Публичный photo-ID из заранее заполненного альбома         | Прикрепление через wall.post работает                                               | Да, но новый файл автоматически загрузить этим способом нельзя                                                                      |
| Загрузка в обычный альбом через photos.getUploadServer     | Повторный вызов community token: код 27                                             | Нет для нашего ключа                                                                                                                |
| JPG как документ                                           | Загрузка, сохранение и пост №13 работают; пользователь увидел только ссылку на файл | Не подходит как большая обложка                                                                                                     |
| GIF как документ                                           | Двухкадровый GIF сохранён как doc type=3; создан пост №14                           | Пользователь подтвердил большое превью с кнопкой воспроизведения; это GIF-документ, не photo                                        |
| Фото из Messages API                                       | Загрузка работает, wall.post не принимает это фото                                  | Не сработало                                                                                                                        |
| Карточка ссылки с link_photo_id из Messages API            | Первоначальный запрос: код 100, link_photo_sizing_rule, No photo given              | Не сработало: исправленный запрос с фото в attachments также вернул код 100, No photo given                                         |
| Загрузка для виджетов appWidgets.getGroupImageUploadServer | Код 15: нет доступа с текущими scopes                                               | Не доступна; результат метода — изображение виджета, не автоматически photo для стены                                               |
| Загрузка фото истории stories.getPhotoUploadServer         | Сервер доступен                                                                     | Создание истории и пригодность её фото для стены не проверены; история — другой формат публикации                                   |
| Загрузка обложки сообщества                                | Метод поддерживает group; первый запрос требует crop шириной минимум 911            | Сохранение меняет обложку сообщества, это не доказанный способ создать вложение стены; не выполнялось                               |
| Загрузка картинки беседы photos.getChatUploadServer        | Сервер загрузки получен                                                             | Это аватар беседы; сохранение меняет беседу, не проверено и не выполнялось                                                          |
| Карточка ссылки на собственную страницу с Open Graph       | Схема wall.post допускает URL во вложениях                                          | Кандидат: нужен публичный URL страницы/картинки и проверка поведения парсера VK; собственная динамическая обложка не протестирована |

GIF: `doc-242034586_707000371`, пост https://vk.ru/wall-242034586_14. Полное выполнение цепочки community token → upload → docs.save → wall.post подтверждено; пользователь подтвердил большое превью в интерфейсе VK.

Истории, обложка сообщества и аватар беседы не публиковались/не изменялись для этого исследования. Их сохранение не является подтверждённой конвертацией в публичный объект photo. Вызовы execute и смена версии API не дают дополнительных прав токену.
