import { setTimeout as sleep } from 'node:timers/promises';
import {
  configFromEnv,
  nextQueuedPost,
  formatPost,
  publish,
  readState,
  resume,
  resolvePost,
} from './core.mjs';

const args = process.argv.slice(2);
const allowed = ['--dry-run', '--once', '--publish-next', '--resume', '--status'];
const resolution =
  (args[0] === '--retry-post' && args.length === 2) ||
  (args[0] === '--mark-sent' && args.length === 3);
if (!resolution && (args.length > 1 || args.some((arg) => !allowed.includes(arg)))) {
  console.error(
    'Usage: node bot/run.mjs [--dry-run | --once | --publish-next | --status | --resume | --retry-post ID | --mark-sent ID MESSAGE_ID]',
  );
  process.exit(1);
}

try {
  const config = configFromEnv();
  if (resolution) {
    console.log(
      JSON.stringify(
        await resolvePost(config, args[1], args[0] === '--mark-sent' ? Number(args[2]) : null),
      ),
    );
  } else if (args[0] === '--dry-run') {
    const state = await readState(config);
    const post = await nextQueuedPost(config, state.entries);
    console.log(post ? formatPost(post) : 'Queue is empty: add posts to bot/content/posts.json');
  } else if (args[0] === '--resume') {
    console.log(JSON.stringify(await resume(config)));
  } else if (args[0] === '--status') {
    const state = await readState(config);
    console.log(
      JSON.stringify(
        {
          paused: state.paused,
          entries: state.entries.map(({ html, ...entry }) => {
            void html;
            return entry;
          }),
        },
        null,
        2,
      ),
    );
  } else if (args.length) {
    const result = await publish(config, { manual: args[0] === '--publish-next' });
    console.log(JSON.stringify(result));
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
      const result = config.chatId.trim() ? await publish(config) : { status: 'not_due' };
      if (!['not_due', 'already_processed'].includes(result.status))
        console.log(JSON.stringify(result));
      if (!stopping) await sleep(15_000);
    }
  }
} catch {
  // Do not print arbitrary exception messages: credentials may appear in them.
  console.error(
    'Bot stopped: check environment, queue, state and file permissions. Run bot tests for validation.',
  );
  process.exitCode = 1;
}
