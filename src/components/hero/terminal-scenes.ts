export const apiBroken = [
  'from fastapi import FastAPI',
  'from pydantic import BaseModel',
  '',
  'app = FastAPI()',
  '',
  'class Project(BaseModel):',
  '    title: str',
  '    budget: int',
  '',
  '@app.post("/projects", status_code=201)',
  'async def create_project(project: Project):',
  '    return {',
  '        "id": str(uuid4()),',
  '        "title": project.title,',
  '        "status": "created",',
  '    }',
].join('\n');
export const apiFixed = 'from uuid import uuid4\n' + apiBroken;
const botBroken = [
  'from aiogram import Router',
  'from aiogram.filters import CommandStart',
  'from aiogram.types import Message',
  '',
  'router = Router()',
  '',
  '@router.message(CommandStart())',
  'async def start(message: Message):',
  '    message.answer(',
  '        "Привет! Опишите вашу задачу.",',
  '    )',
].join('\n');
const botFixed = botBroken.replace('    message.answer(', '    await message.answer(');

type LogLine = { text: string; tone?: 'error' | 'success' | 'command' | 'muted' };
export type TerminalStep = {
  duration: number;
  source: string;
  mode?: 'type' | 'import' | 'await';
  logs: LogLine[];
  status: string;
  errorLine?: number;
};
export const terminalScenes: { file: string; label: string; steps: TerminalStep[] }[] = [
  {
    file: 'api.py',
    label: 'Создаю API для заявок',
    steps: [
      {
        duration: 11000,
        source: apiBroken,
        mode: 'type',
        logs: [{ text: '~/projects/client-api', tone: 'muted' }],
        status: 'Пишу обработчик',
      },
      {
        duration: 1300,
        source: apiBroken,
        logs: [{ text: '$ uv run ruff check api.py', tone: 'command' }],
        status: 'Проверяю код',
      },
      {
        duration: 2300,
        source: apiBroken,
        errorLine: 13,
        logs: [
          { text: '$ uv run ruff check api.py', tone: 'command' },
          { text: 'F821 Undefined name `uuid4`', tone: 'error' },
          { text: '  --> api.py:13:19', tone: 'muted' },
        ],
        status: 'Добавляю импорт',
      },
      {
        duration: 1450,
        source: apiFixed,
        mode: 'import',
        logs: [{ text: 'Исправление: from uuid import uuid4', tone: 'muted' }],
        status: 'Исправляю ошибку',
      },
      {
        duration: 1600,
        source: apiFixed,
        logs: [
          { text: '$ uv run ruff check api.py', tone: 'command' },
          { text: 'All checks passed!', tone: 'success' },
          { text: '$ uv run pytest -q', tone: 'command' },
        ],
        status: 'Запускаю тесты',
      },
      {
        duration: 4300,
        source: apiFixed,
        logs: [
          { text: '... 3 passed in 0.24s', tone: 'success' },
          { text: '$ curl -X POST localhost:8000/projects', tone: 'command' },
          { text: 'HTTP/1.1 201 Created', tone: 'success' },
          { text: '{"title":"Новый сайт","status":"created"}' },
        ],
        status: 'API готов',
      },
    ],
  },
  {
    file: 'bot.py',
    label: 'Создаю Telegram-бота',
    steps: [
      {
        duration: 9000,
        source: botBroken,
        mode: 'type',
        logs: [{ text: '~/projects/telegram-bot', tone: 'muted' }],
        status: 'Пишу команду /start',
      },
      {
        duration: 1400,
        source: botBroken,
        logs: [{ text: '$ uv run pytest tests/test_bot.py -q', tone: 'command' }],
        status: 'Проверяю ответ бота',
      },
      {
        duration: 2700,
        source: botBroken,
        errorLine: 9,
        logs: [
          { text: 'FAILED test_start_replies', tone: 'error' },
          { text: 'AssertionError: Expected answer to have', tone: 'error' },
          { text: 'been awaited once. Awaited 0 times.', tone: 'error' },
        ],
        status: 'Не хватает await',
      },
      {
        duration: 1200,
        source: botFixed,
        mode: 'await',
        logs: [{ text: 'Исправление: await message.answer(...)', tone: 'muted' }],
        status: 'Исправляю вызов',
      },
      {
        duration: 1600,
        source: botFixed,
        logs: [{ text: '$ uv run pytest tests/test_bot.py -q', tone: 'command' }],
        status: 'Повторяю тест',
      },
      {
        duration: 4300,
        source: botFixed,
        logs: [
          { text: '. 1 passed in 0.18s', tone: 'success' },
          { text: '$ uv run python -m app', tone: 'command' },
          { text: 'INFO  Start polling', tone: 'success' },
          { text: 'INFO  /start → ответ отправлен', tone: 'success' },
        ],
        status: 'Бот отвечает',
      },
    ],
  },
];

export function tokenize(line: string): { text: string; kind: string }[] {
  const pattern =
    /(#.*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b(?:from|import|class|async|def|return|await)\b|\b\d+\b|@\w+(?:\.\w+)?)/g;
  const tokens: { text: string; kind: string }[] = [];
  let start = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > start) tokens.push({ text: line.slice(start, index), kind: 'plain' });
    const text = match[0];
    const kind = text.startsWith('#')
      ? 'comment'
      : /^["']/.test(text)
        ? 'string'
        : /^\d/.test(text)
          ? 'number'
          : text.startsWith('@')
            ? 'decorator'
            : 'keyword';
    tokens.push({ text, kind });
    start = index + text.length;
  }
  if (start < line.length) tokens.push({ text: line.slice(start), kind: 'plain' });
  return tokens;
}
