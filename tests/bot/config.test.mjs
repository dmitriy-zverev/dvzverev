import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateServiceDocument } from '../../bot/config/validate.mjs';
import { loadAppConfig, validateConfigFile } from '../../bot/app-config.mjs';
import { dualConfigWarnings } from '../../bot/config/legacy.mjs';
import { scheduleConflicts } from '../../bot/config/schedule.mjs';
import { formatCliError, isOperatorSafeError } from '../../bot/config/errors.mjs';
import { openCabinetDb } from '../../bot/cabinet/db.mjs';
import {
  registerPromptVersion,
  activatePromptVersion,
  rollbackPromptVersion,
} from '../../bot/cabinet/analytics/prompts.mjs';

const exampleConfig = fileURLToPath(new URL('../../bot/service.example.json', import.meta.url));

test('service example validates', async () => {
  const result = await validateConfigFile(exampleConfig, {});
  assert.equal(result.ok, true);
  assert.equal(result.projects.length, 1);
  assert.equal(result.destinations.length, 2);
});

test('rejects prompt paths outside config root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bot-config-'));
  const configPath = join(dir, 'service.json');
  await mkdir(join(dir, 'prompts'), { recursive: true });
  await writeFile(join(dir, 'prompts', 'editor.md'), 'prompt');
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      providers: {
        editor: { adapter: 'openrouter', model: 'x', credentialEnv: 'OPENROUTER_API_KEY' },
      },
      destinations: {
        tg: {
          platform: 'telegram',
          chatIdEnv: 'TELEGRAM_CHAT_ID',
          credentialEnv: 'TELEGRAM_BOT_TOKEN',
        },
      },
      projects: {
        alpha: {
          enabled: true,
          format: 'tip',
          language: 'ru',
          prompts: { editor: '../../etc/passwd' },
          generation: { provider: 'editor' },
          schedule: { timezone: 'Europe/Moscow', times: ['10:00'] },
          delivery: { destinations: ['tg'] },
        },
      },
    }),
  );
  const validation = validateServiceDocument(JSON.parse(await readFile(configPath, 'utf8')), {
    configPath,
  });
  assert.equal(validation.ok, false);
  assert.match(validation.errors[0].message, /inside config directory/);
  await rm(dir, { recursive: true, force: true });
});

test('runtime config resolves project secrets and prompt', async () => {
  const app = await loadAppConfig({
    BOT_CONFIG_PATH: exampleConfig,
    TELEGRAM_BOT_TOKEN: '123:secret',
    TELEGRAM_CHAT_ID: '@channel',
    VK_ACCESS_TOKEN: 'vk',
    VK_GROUP_ID: '242034586',
    OPENROUTER_API_KEY: 'or-key',
    OPENROUTER_MODEL: 'google/gemini-3.1-flash-lite',
  });
  assert.equal(app.mode, 'multi');
  const runtime = await app.resolveProjectConfig('coding-reading');
  assert.equal(runtime.projectId, 'coding-reading');
  assert.equal(runtime.token, '123:secret');
  assert.equal(runtime.contentMode, 'digest');
  assert.ok(runtime.openrouterPrompt.length > 20);
  assert.equal(runtime.imagesEnabled, true);
});

test('runtime uses approved project prompt versions and rollback changes the next generation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'active-prompts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = {
    BOT_CONFIG_PATH: exampleConfig,
    BOT_CABINET_ENABLED: 'true',
    BOT_CABINET_DB_PATH: join(dir, 'cabinet.sqlite'),
    OPENROUTER_MODEL: 'google/gemini-3.1-flash-lite',
    TELEGRAM_BOT_TOKEN: '123:secret',
    TELEGRAM_CHAT_ID: '@channel',
    VK_ACCESS_TOKEN: 'vk',
    VK_GROUP_ID: '242034586',
    OPENROUTER_API_KEY: 'or-key',
  };
  const db = openCabinetDb(env);
  t.after(() => db.close());
  const app = await loadAppConfig(env);
  const original = (await app.resolveProjectConfig('coding-reading')).openrouterPrompt;
  const first = registerPromptVersion(db, {
    projectId: 'coding-reading',
    role: 'editor',
    versionLabel: 'v1',
    contentText: 'First approved prompt',
  }).version;
  activatePromptVersion(db, first.versionId);
  const second = registerPromptVersion(db, {
    projectId: 'coding-reading',
    role: 'editor',
    versionLabel: 'v2',
    contentText: 'Second approved prompt',
    parentVersionId: first.versionId,
  }).version;
  assert.equal(
    (await app.resolveProjectConfig('coding-reading')).openrouterPrompt,
    first.contentText,
  );
  activatePromptVersion(db, second.versionId);
  const current = await app.resolveProjectConfig('coding-reading');
  assert.equal(current.openrouterPrompt, second.contentText);
  assert.equal(current.promptVersions.editor.versionId, second.versionId);
  rollbackPromptVersion(db, second.versionId);
  assert.equal(
    (await app.resolveProjectConfig('coding-reading')).openrouterPrompt,
    first.contentText,
  );
  assert.equal(
    (
      await (
        await loadAppConfig({ ...env, BOT_CABINET_ENABLED: 'false' })
      ).resolveProjectConfig('coding-reading')
    ).openrouterPrompt,
    original,
  );
});

test('dual legacy and new config emits warning', () => {
  const warnings = dualConfigWarnings({
    BOT_CONFIG_PATH: 'bot/service.example.json',
    TELEGRAM_BOT_TOKEN: '123:secret',
  });
  assert.equal(warnings.length, 1);
});

test('CLI validate-config succeeds for example service', () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../../bot/run.mjs', import.meta.url)),
      '--validate-config',
      '--config',
      exampleConfig,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"ok": true/);
});

test('rejects queue and state paths outside config root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bot-config-paths-'));
  const configPath = join(dir, 'service.json');
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      providers: {
        editor: { adapter: 'openrouter', model: 'x', credentialEnv: 'OPENROUTER_API_KEY' },
      },
      destinations: {
        tg: {
          platform: 'telegram',
          chatIdEnv: 'TELEGRAM_CHAT_ID',
          credentialEnv: 'TELEGRAM_BOT_TOKEN',
        },
      },
      projects: {
        alpha: {
          enabled: true,
          format: 'tip',
          language: 'ru',
          postSource: 'queue',
          queuePath: '../../outside/posts.json',
          statePath: '../../outside/state.json',
          prompts: { editor: 'prompts/editor.md' },
          generation: { provider: 'editor' },
          schedule: { timezone: 'Europe/Moscow', times: ['10:00'] },
          delivery: { destinations: ['tg'] },
        },
      },
    }),
  );
  await mkdir(join(dir, 'prompts'), { recursive: true });
  await writeFile(join(dir, 'prompts', 'editor.md'), 'prompt');
  const validation = validateServiceDocument(JSON.parse(await readFile(configPath, 'utf8')), {
    configPath,
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.path.includes('queuePath')));
  assert.ok(validation.errors.some((error) => error.path.includes('statePath')));
  await rm(dir, { recursive: true, force: true });
});

test('schedule conflicts detect midnight wrap on shared destination', () => {
  const issues = scheduleConflicts(
    {
      projects: {
        a: {
          enabled: true,
          schedule: { timezone: 'Europe/Moscow', times: ['23:50', '00:10'] },
          delivery: { destinations: ['shared'] },
        },
      },
    },
    30,
  );
  assert.ok(issues.some((issue) => issue.kind === 'destination_interval'));
});

test('schedule conflicts respect timezone on shared destination', () => {
  const issues = scheduleConflicts(
    {
      projects: {
        a: {
          enabled: true,
          schedule: { timezone: 'Europe/Moscow', times: ['10:00'] },
          delivery: { destinations: ['shared'] },
        },
        b: {
          enabled: true,
          schedule: { timezone: 'America/New_York', times: ['10:00'] },
          delivery: { destinations: ['shared'] },
        },
      },
    },
    30,
  );
  assert.equal(issues.length, 0);
});

test('unsafe runtime errors stay generic in CLI output', () => {
  assert.equal(
    isOperatorSafeError(new Error('Missing environment variable: OPENROUTER_API_KEY')),
    true,
  );
  assert.equal(
    formatCliError(new Error('fetch failed: Bearer sk-secret')),
    'Bot stopped: check environment, queue, state and file permissions. Run bot tests for validation.',
  );
});

test('CLI rejects --project without id', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../../bot/run.mjs', import.meta.url)), '--project', '--dry-run'],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Pass --project ID/);
});

test('CLI list reports projects in multi mode', () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../../bot/run.mjs', import.meta.url)),
      '--list',
      '--config',
      exampleConfig,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /coding-reading/);
});
