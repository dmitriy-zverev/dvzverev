import type { ServiceDirection } from './schema';
import { serviceDirectionSchema } from './schema';

const rawServices: ServiceDirection[] = [
  {
    id: 'web',
    title: 'Сайты и веб-сервисы',
    outcome: 'Канал продаж или рабочий продукт',
    examples: 'лендинг, кабинет, каталог, SaaS-интерфейс',
  },
  {
    id: 'bots',
    title: 'Telegram / MAX',
    outcome: 'Автоматизированный сценарий в мессенджере',
    examples: 'заявки, оплата, уведомления, поддержка',
  },
  {
    id: 'backend',
    title: 'Backend и API',
    outcome: 'Надёжная логика и обмен данными',
    examples: 'интеграции, роли, платежи, очереди, админка',
  },
  {
    id: 'mvp',
    title: 'MVP и развитие',
    outcome: 'Быстрый проверяемый релиз без тупиковой архитектуры',
    examples: 'прототип, аналитика, итерации, поддержка',
  },
];

export const services: ServiceDirection[] = rawServices.map((item) =>
  serviceDirectionSchema.parse(item),
);
