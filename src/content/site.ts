import type { SiteContent } from './schema';

export const site: SiteContent = {
  canonicalBase: 'https://www.dvzverev.ru',
  telegramUrl: 'https://t.me/zverev_dmitry',
  githubUrl: 'https://github.com/dmitriy-zverev',
  headerBrand: 'dmitriy-zverev',
  headerRole: 'PYTHON / PRODUCT ENGINEER',
  fullName: 'Дмитрий Зверев',
  title: 'Дмитрий Зверев — product engineer',
  description:
    'Сайты, Telegram/MAX-боты и backend-системы — от идеи до запуска. Python backend и полный цифровой продукт.',
  heroHeadline: 'Собираю сайты, ботов и backend, которые работают.',
  heroSubline: 'Сайты, Telegram/MAX-боты и backend-системы — от идеи до запуска.',
  heroCtaLabel: 'Написать',
  heroCtaMicro: 'Отвечу лично и помогу Вам определить первый релиз.',
  heroSecondaryLabel: 'Проекты',
  xrayToggleLabel: 'Показать изнутри',
  nav: [
    { label: 'Проекты', href: '#cases' },
    { label: 'Контакт', href: '#contact' },
  ],
  faq: [
    {
      question: 'Можно начать с небольшой версии?',
      answer: 'Да. Сначала фиксируем первый релиз с понятным результатом, а не весь продукт сразу.',
    },
    {
      question: 'Как формируется стоимость?',
      answer: 'После разбора задачи: объём первого релиза, риски, сроки. Без скрытых этапов.',
    },
    {
      question: 'Работаете ли с готовым дизайном или командой?',
      answer: 'Да. Могу подключиться к существующей команде или собрать интерфейс вокруг backend.',
    },
    {
      question: 'Что будет после запуска?',
      answer: 'Наблюдение, исправления, аналитика и следующий шаг — без «бросил после релиза».',
    },
    {
      question: 'Можно подключиться к существующему проекту?',
      answer: 'Да. Разберём код, процессы и точку входа без лишнего переписывания.',
    },
    {
      question: 'Как проходят платежи и договор?',
      answer: 'Обсуждаем формат до старта: договор, этапы, прозрачные критерии приёмки.',
    },
  ],
  principles: [
    'Говорю о рисках до начала разработки.',
    'Показываю результат по ходу работы, а не в последний день.',
    'Выбираю технологии под задачу.',
    'Оставляю понятный код, документацию и точки контроля.',
    'Могу подключиться один или усилить существующую команду.',
  ],
  stackGroups: [
    { role: 'interface', items: 'React, TypeScript, JavaScript' },
    { role: 'application', items: 'Python, FastAPI, Django/DRF' },
    { role: 'data', items: 'PostgreSQL, MySQL, Redis, SQLAlchemy, Alembic' },
    { role: 'async', items: 'TaskIQ, Celery, RabbitMQ, Kafka' },
    { role: 'delivery', items: 'Docker, CI/CD, Jenkins, Linux' },
    { role: 'observe', items: 'Prometheus, Grafana, OpenTelemetry' },
    { role: 'tools', items: 'Go для CLI (базовый уровень)' },
  ],
  aboutBio:
    'Я Дмитрий, Python backend-разработчик с опытом коммерческой разработки более трёх лет. Проектирую API, данные, фоновые процессы и интеграции, а когда задаче нужен целый продукт — собираю вокруг них интерфейс, бота и инфраструктуру запуска.',
  contactHeadline: 'Есть задача?',
  contactAccent: 'Соберём вместе.',
  contactSubline: 'Опишите задачу — отвечу лично и предложу формат первого релиза.',
  footerTagline: 'Python backend · сайты · боты · запуск продукта',
};
