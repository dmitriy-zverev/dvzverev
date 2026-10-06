import { setTimeout as sleep } from 'node:timers/promises';
import {
  nextQueuedPost,
  formatPost,
  publish,
  readState,
  resume,
  resolvePost,
  reportRuntimeFailure,
  clearRuntimeFailure,
} from './core.mjs';
import { generatePost, GenerationFailure } from './openrouter.mjs';
import { formatVkPost } from './content.mjs';
import { loadAppConfig, validateConfigFile, failureAlertConfig } from './app-config.mjs';
import { formatCliError } from './config/errors.mjs';
import { attachVkPhotosToken } from './vk-photos-token.mjs';
import { sendVkPhotosTokenRefreshRequest } from './vk-photos-inbox.mjs';
import { randomUUID } from 'node:crypto';

function parseArgs(argv) {
  const args = [...argv];
  const projectIndex = args.indexOf('--project');
  let projectId = null;
  if (projectIndex >= 0) {
    projectId = args[projectIndex + 1];
    if (!projectId || projectId.startsWith('--')) {
      throw new Error('Pass --project ID after --project');
    }
    args.splice(projectIndex, 2);
  }
  const configIndex = args.indexOf('--config');
  let configPath = null;
  if (configIndex >= 0) {
    configPath = args[configIndex + 1];
    if (!configPath || configPath.startsWith('--')) {
      throw new Error('Pass --config PATH after --config');
    }
    args.splice(configIndex, 2);
  }
  return { args, projectId, configPath };
}

let args;
let projectId;
let configPath;
const allowed = [
  '--dry-run',
  '--once',
  '--publish-next',
  '--resume',
  '--resume-telegram',
  '--resume-vk',
  '--resume-queue',
  '--resume-openrouter',
  '--generate-preview',
  '--status',
  '--validate-config',
  '--list',
  '--request-vk-photos-token',
];
function isResolutionCommand(parsedArgs) {
  return (
    (parsedArgs[0] === '--retry-post' && parsedArgs.length === 2) ||
    (parsedArgs[0] === '--mark-sent' && parsedArgs.length === 3)
  );
}

async function resolveRuntimeConfig(app) {
  if (app.mode === 'legacy') return app.legacyConfig;
  const targetProject = projectId || app.enabledProjectIds()[0];
  if (!targetProject) throw new Error('No enabled projects in service config');
  return app.resolveProjectConfig(targetProject);
}

function printWarnings(warnings) {
  for (const warning of warnings) console.error(`Warning: ${warning}`);
}

function canScheduleProject(projectConfig) {
  if (projectConfig.chatId.trim()) return true;
  if (projectConfig.vkEnabled && projectConfig.vkToken) {
    console.error(
      `Project ${projectConfig.projectId}: VK-only scheduling is not supported yet; configure a Telegram destination.`,
    );
  }
  return false;
}

async function runMultiProjectScheduler(app, stoppingRef) {
  console.log(`Multi-project schedule: ${app.enabledProjectIds().join(', ')} (${app.configPath})`);
  while (!stoppingRef.stopping) {
    const inboxIds = app.enabledProjectIds();
    if (inboxIds.length) {
      const inboxConfig = await app.resolveProjectConfig(inboxIds[0]);
      await attachVkPhotosToken(inboxConfig);
      // GIF uploads use the community key; no user-token inbox polling.
    }
    for (const id of app.enabledProjectIds()) {
      let projectConfig;
      try {
        projectConfig = await app.resolveProjectConfig(id);
        await attachVkPhotosToken(projectConfig);
        if (!canScheduleProject(projectConfig)) continue;
        const result = await publish(projectConfig);
        if (result.status !== 'locked') await clearRuntimeFailure(projectConfig);
        if (!['not_due', 'already_processed'].includes(result.status)) {
          console.log(JSON.stringify({ projectId: id, ...result }));
        }
      } catch {
        console.error(
          `Scheduler failure for project ${id}: check environment, delivery state and file permissions.`,
        );
        await reportRuntimeFailure(projectConfig || failureAlertConfig(app, id));
      }
    }
    if (!stoppingRef.stopping) await sleep(15_000);
  }
}

let app;
let config;
try {
  ({ args, projectId, configPath } = parseArgs(process.argv.slice(2)));
  const resolution = isResolutionCommand(args);
  if (!resolution && (args.length > 1 || args.some((arg) => !allowed.includes(arg)))) {
    console.error(
      'Usage: node bot/run.mjs [--config PATH] [--project ID] [--dry-run | --generate-preview | --once | --publish-next | --request-vk-photos-token | --status | --validate-config | --list | --resume | --resume-telegram | --resume-vk | --resume-queue | --resume-openrouter | --retry-post ID | --mark-sent ID MESSAGE_ID]',
    );
    process.exit(1);
  }
  if (configPath) process.env.BOT_CONFIG_PATH = configPath;
  if (args[0] === '--validate-config') {
    const target = configPath || process.env.BOT_CONFIG_PATH;
    if (!target) throw new Error('Pass --config PATH or set BOT_CONFIG_PATH');
    const result = await validateConfigFile(target, process.env);
    printWarnings(result.warnings);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } else {
    app = await loadAppConfig();
    printWarnings(app.warnings);
    if (args[0] === '--list') {
      console.log(
        JSON.stringify(
          {
            mode: app.mode,
            configPath: app.configPath || null,
            projects: app.listProjects(),
            destinations: app.listDestinations(),
          },
          null,
          2,
        ),
      );
    } else if (args.length === 0 && app.mode === 'multi') {
      const stoppingRef = { stopping: false };
      process.on('SIGTERM', () => {
        stoppingRef.stopping = true;
      });
      process.on('SIGINT', () => {
        stoppingRef.stopping = true;
      });
      await runMultiProjectScheduler(app, stoppingRef);
    } else {
      config = await resolveRuntimeConfig(app);
      await attachVkPhotosToken(config);
      if (args[0] === '--request-vk-photos-token') {
        const result = await sendVkPhotosTokenRefreshRequest(config);
        console.log(
          JSON.stringify({
            telegramSent: result.sent,
            alertChatId: config.alertChatId,
            authorizeUrl: result.authorizeUrl,
            inboxPoll: result.poll,
          }),
        );
        if (!result.sent) process.exitCode = 1;
      } else if (resolution) {
        console.log(
          JSON.stringify(
            await resolvePost(config, args[1], args[0] === '--mark-sent' ? Number(args[2]) : null),
          ),
        );
      } else if (args[0] === '--generate-preview') {
        const paidNotice =
          config.postSource === 'openrouter'
            ? 'Paid OpenRouter generation will run. Nothing will be published.'
            : 'Preview uses the manual queue without publishing.';
        console.error(paidNotice);
        const post = await generatePost(config, { id: `preview-${randomUUID()}` });
        console.log(formatVkPost(post));
        console.log(JSON.stringify(post.generation));
      } else if (args[0] === '--dry-run') {
        if (config.postSource === 'openrouter') {
          console.log(
            JSON.stringify({
              projectId: config.projectId || null,
              source: 'openrouter',
              mode: config.contentMode,
              times: config.times,
              timezone: config.timezone,
              model: config.openrouterModel,
              prompt: config.openrouterPrompt,
              note: 'Use --generate-preview for a paid generation without publishing.',
            }),
          );
        } else {
          const state = await readState(config);
          const post = await nextQueuedPost(config, state.entries);
          console.log(
            post ? formatPost(post) : 'Queue is empty: add posts to bot/content/posts.json',
          );
        }
      } else if (args[0]?.startsWith('--resume')) {
        console.log(
          JSON.stringify(await resume(config, args[0] === '--resume' ? null : args[0].slice(9))),
        );
      } else if (args[0] === '--status') {
        const state = await readState(config);
        const entries = state.entries.map(({ html, vkText, ...entry }) => {
          void html;
          void vkText;
          return entry;
        });
        const payload = {
          mode: app.mode,
          projectId: config.projectId || null,
          pauses: state.pauses,
          cooldowns: state.cooldowns,
          generation: state.pendingGeneration,
          entries,
        };
        if (app.mode === 'multi' && !projectId) {
          payload.note =
            'Showing status for the first enabled project. Pass --project ID for others.';
        }
        console.log(JSON.stringify(payload, null, 2));
      } else if (args.length) {
        const result = await publish(config, { manual: args[0] === '--publish-next' });
        console.log(JSON.stringify({ projectId: config.projectId || null, ...result }));
        if (['uncertain', 'failed', 'exhausted', 'paused', 'locked'].includes(result.status))
          process.exitCode = 1;
      } else {
        let stopping = false;
        process.on('SIGTERM', () => {
          stopping = true;
        });
        process.on('SIGINT', () => {
          stopping = true;
        });
        console.log(`Schedule: ${config.times.join(', ')} (${config.timezone})`);
        if (!config.chatId.trim()) {
          console.log(
            'Waiting for TELEGRAM_CHAT_ID. Set the channel in .env and recreate the container. No posts will be sent.',
          );
        }
        while (!stopping) {
          try {
            await attachVkPhotosToken(config);
            // GIF uploads use the community key; no user-token inbox polling.
            const result = config.chatId.trim() ? await publish(config) : { status: 'not_due' };
            if (config.chatId.trim() && result.status !== 'locked')
              await clearRuntimeFailure(config);
            if (!['not_due', 'already_processed'].includes(result.status))
              console.log(JSON.stringify(result));
          } catch {
            console.error(
              'Scheduler failure: check environment, delivery state and file permissions.',
            );
            await reportRuntimeFailure(config);
          }
          if (!stopping) await sleep(15_000);
        }
      }
    }
  }
} catch (error) {
  await reportRuntimeFailure(
    config ||
      (app && projectId
        ? failureAlertConfig(app, projectId)
        : {
            token: process.env.TELEGRAM_BOT_TOKEN || '',
            alertChatId: process.env.BOT_ALERT_CHAT_ID || '',
            chatId: process.env.TELEGRAM_CHAT_ID || '',
            statePath: process.env.BOT_STATE_PATH || 'bot/data/state.json',
          }),
    undefined,
    error instanceof GenerationFailure
      ? { platform: 'openrouter', reason: error.reason, errorCode: error.code, status: 'failed' }
      : null,
  );
  console.error(formatCliError(error));
  process.exitCode = 1;
}
