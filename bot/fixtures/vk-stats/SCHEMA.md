# VK stats import schema (vk-stats-v1)

Обезличенный контракт для еженедельного импорта. CSV UTF-8 и JSON — основной
путь в кабинет. Пустая ячейка = «нет данных» (null), не ноль.

## Обязательные поля

| Поле         | Тип            | Описание                          |
| ------------ | -------------- | --------------------------------- |
| group_id     | integer string | ID сообщества без минуса          |
| post_id      | integer string | ID поста на стене                 |
| observed_at  | ISO-8601 UTC   | Момент наблюдения                 |
| metric_mode  | enum           | `cumulative` или `period`         |

## Опциональные поля

published_at, period_from, period_to, views, reach_total, reach_organic,
reach_paid, likes, comments, reposts, saves, clicks, link_clicks,
subscribers_at_publish, ad_spend, promoted, wall_url, text_hint.

Для `metric_mode=period` нужны period_from и period_to.
`text_hint` — подсказка для ручного сопоставления (обрезка описания из VK);
не доказательство совпадения и не замена post_id.

## Идентичность наблюдения

`(project_id, post_id, source, observed_at, metric_mode, period_from, period_to)`

Повтор того же файла (hash) не удваивает значения. Cumulative snapshots за
разные недели — последовательные записи, не суммы.

## Реальный VK export (`posts_*` classic .xls)

Имя: `{groupId}_posts_{audience|common|content}_{YYYY-MM-DD}_{YYYY-MM-DD}.xls`

| Файл            | Уровень     | Содержимое                                      | В Feature 3      |
| --------------- | ----------- | ----------------------------------------------- | ---------------- |
| posts_content   | **per-post** | Дата/время публикации, описание, охват, просмотры, лайки, комментарии, репосты, закладки | Да (после конвертации) |
| posts_common    | group       | Часовые/дневные ряды охвата и взаимодействий    | Нет              |
| posts_audience  | group       | Устройства/пол/возраст/**города**               | Нет (PII cities) |

Маппинг `posts_content` → контракт:

| VK колонка   | Поле              | Примечание                          |
| ------------ | ----------------- | ----------------------------------- |
| (имя файла)  | group_id          | `{groupId}_posts_content_...`       |
| —            | post_id           | **отсутствует** — не выдумывать     |
| Дата+Время   | published_at      | Москва (+03) → UTC                  |
| (имя файла)  | period_from/to, observed_at, metric_mode=`period` | окно выгрузки |
| Охват        | reach_total       |                                     |
| Просмотры    | views             |                                     |
| Лайки        | likes             | бывают отрицательные — reject       |
| Комментарии  | comments          |                                     |
| Поделились   | reposts           |                                     |
| Закладки     | saves             |                                     |
| Описание     | text_hint         | только hint                         |

### Импорт без xlrd в Docker

1. Конвертация offline:
   `uvx --from xlrd python bot/vk-posts-xls-to-json.py path/to/{id}_posts_content_{from}_{to}.xls`
2. Получите `*.vk-stats.json` (post_id пустой).
3. Допишите `post_id` или `wall_url` (`https://vk.com/wall-{group}_{post}`).
4. `POST /bot/api/v1/imports/preview` с JSON.

Либо UTF-8 CSV с теми же русскими заголовками, что в XLS sheet
(`sample-posts-content-native.csv`) — парсер распознаёт native format по
заголовкам и имени файла. audience/common отклоняются.

Fixtures: `sample-posts.csv` / `sample-posts.json` (полный контракт),
`sample-posts-content-native.csv` / `sample-posts-content.json` (структура VK).
