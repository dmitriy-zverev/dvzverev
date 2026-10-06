import { maintainMedia } from './maintenance.mjs';
import { heartbeat } from './health.mjs';
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
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { collectMetrics, importCommerce, metricsReport } from './metrics.mjs';

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
  '--collect-metrics',
  '--metrics-report',
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

function canScheduleProject(config) {
  return Boolean(
    config.chatId.trim() || (config.vkEnabled && config.vkToken && !config.vkConfigError),
  );
}

async function runMultiProjectScheduler(app, stoppingRef) {
  console.log(`Multi-project schedule: ${app.enabledProjectIds().join(', ')} (${app.configPath})`);
  lastProgressAt = Date.now();
  await heartbeat();
  while (!stoppingRef.stopping) {
    for (const id of app.enabledProjectIds()) {
      let projectConfig;
      try {
        projectConfig = await app.resolveProjectConfig(id);
        const result = await publish(projectConfig);
        if (result.status !== 'locked') await clearRuntimeFailure(projectConfig);
        if (!['not_due', 'already_processed'].includes(result.status)) {
          console.log(JSON.stringify({ projectId: id, ...result }));
        }
      } catch (error) {
        console.error(
          `Scheduler failure for project ${id}: check environment, delivery state and file permissions.`,
        );
        await reportRuntimeFailure(
          projectConfig || failureAlertConfig(app, id),
          undefined,
          null,
          error,
        );
      }
      if (projectConfig) {
        try {
          await maintainMedia(projectConfig);
        } catch (error) {
          await reportRuntimeFailure(
            { ...projectConfig, statePath: projectConfig.statePath + '.maintenance' },
            undefined,
            {
              reason: 'media_cleanup_failed',
              platform: 'system',
              status: 'failed',
              postingContinues: true,
            },
            error,
          );
        }
      }
      if (projectConfig?.metricsEnabled) {
        const metricsIncidentConfig = { ...projectConfig, statePath: projectConfig.metricsPath };
        try {
          const metricsResult = await collectMetrics(projectConfig);
          if (metricsResult.status === 'collected') {
            await clearRuntimeFailure(metricsIncidentConfig);
            console.log(
              JSON.stringify({
                projectId: id,
                metrics: 'collected',
                subscribers: metricsResult.subscribers,
              }),
            );
          }
        } catch (error) {
          console.error(`Analytics collection failed for project ${id}; posting remains active.`);
          await reportRuntimeFailure(
            metricsIncidentConfig,
            undefined,
            {
              reason: 'metrics_collection_failed',
              platform: 'vk',
              status: 'failed',
              postingContinues: true,
            },
            error,
          );
        }
      }
    }
    lastProgressAt = Date.now();
    await heartbeat();
    if (!stoppingRef.stopping) await sleep(15_000);
  }
}

let app;
let config;
let lastProgressAt = Date.now();
let watchdogStopping = false;
const watchdog = setInterval(() => {
  if (watchdogStopping || Date.now() - lastProgressAt <= 600000) return;
  watchdogStopping = true;
  const target =
    config ||
    (app?.mode === 'multi'
      ? failureAlertConfig(app, app.enabledProjectIds()[0])
      : {
          token: process.env.TELEGRAM_BOT_TOKEN || '',
          alertChatId: process.env.BOT_ALERT_CHAT_ID || '',
          statePath: process.env.BOT_STATE_PATH || '/app/data/state.json',
        });
  void reportRuntimeFailure(target, undefined, {
    reason: 'scheduler_stalled',
    platform: 'system',
    status: 'paused',
  }).finally(() => process.exit(1));
}, 30000);
watchdog.unref();
try {
  ({ args, projectId, configPath } = parseArgs(process.argv.slice(2)));
  const resolution = isResolutionCommand(args);
  const metricsCommand =
    (args[0] === '--import-metrics' && args.length === 2) ||
    (args[0] === '--metrics-report' && [1, 3].includes(args.length));
  if (
    !resolution &&
    !metricsCommand &&
    (args.length > 1 || args.some((arg) => !allowed.includes(arg)))
  ) {
    console.error(
      'Usage: node bot/run.mjs [--config PATH] [--project ID] [--dry-run | --generate-preview | --once | --publish-next | --status | --validate-config | --list | --resume | --resume-telegram | --resume-vk | --resume-queue | --resume-openrouter | --retry-post ID | --mark-sent ID MESSAGE_ID | --collect-metrics | --import-metrics FILE | --metrics-report [FROM TO]]',
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
      if (resolution) {
        console.log(
          JSON.stringify(
            await resolvePost(config, args[1], args[0] === '--mark-sent' ? Number(args[2]) : null),
          ),
        );
      } else if (args[0] === '--collect-metrics') {
        console.log(JSON.stringify(await collectMetrics(config, { force: true }), null, 2));
      } else if (args[0] === '--import-metrics') {
        const input = JSON.parse(await readFile(args[1], 'utf8'));
        console.log(JSON.stringify(await importCommerce(config, input), null, 2));
      } else if (args[0] === '--metrics-report') {
        console.log(
          JSON.stringify(await metricsReport(config, { from: args[1], to: args[2] }), null, 2),
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
        lastProgressAt = Date.now();
        await heartbeat();
        while (!stopping) {
          try {
            // GIF uploads use the community key; no user-token inbox polling.
            const result = canScheduleProject(config) ? await publish(config) : { status: 'not_due' };
            if (config.chatId.trim() && result.status !== 'locked')
              await clearRuntimeFailure(config);
            if (!['not_due', 'already_processed'].includes(result.status))
              console.log(JSON.stringify(result));
          } catch (error) {
            console.error(
              'Scheduler failure: check environment, delivery state and file permissions.',
            );
            await reportRuntimeFailure(config, undefined, null, error);
          }
          lastProgressAt = Date.now();
          await heartbeat();
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
    error,
  );
  console.error(formatCliError(error));
  process.exitCode = 1;
}
