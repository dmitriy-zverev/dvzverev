import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateVideoCover, convertVideo } from '../../bot/videos.mjs';
import { coverPath, ImageFailure, ImagePending } from '../../bot/images.mjs';
import { publish, readState, configFromEnv } from '../../bot/core.mjs';
const gif = Buffer.alloc(10);
gif.write('GIF89a');
gif.writeUInt16LE(1280, 6);
gif.writeUInt16LE(720, 8);
const response = (data) => ({ ok: true, json: async () => data });
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'video-bot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return {
    ...configFromEnv({
      BOT_STATE_PATH: join(dir, 'state.json'),
      BOT_TIMEZONE: 'Europe/Moscow',
      BOT_TIMES: '10:00,18:00',
    }),
    telegramEnabled: false,
    chatId: '',
    vkEnabled: true,
    vkToken: 'group-key',
    vkGroupId: '42',
    vkImagesEnabled: true,
    coverMode: 'video',
    mediaTimes: ['18:00'],
    coverPrompt: 'Period painting. SCENE: [SCENE]',
    openrouterKey: 'secret',
  };
}
const entry = { postId: 'video-test', image: { text: 'Memory of an unwritten letter' } };
function provider() {
  let posts = 0;
  return {
    get posts() {
      return posts;
    },
    fetch: async (url, init) => {
      if (url.endsWith('chat/completions'))
        return response({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  location: 'A deserted historical waiting room',
                  scene:
                    'An empty walnut desk with a sealed letter by a rainy window. Only raindrops move, the camera remains fixed.',
                }),
              },
            },
          ],
        });
      if (init?.method === 'POST') {
        posts++;
        const body = JSON.parse(init.body);
        assert.equal(body.generate_audio, false);
        assert.equal(body.duration, 4);
        assert.equal(body.resolution, '480p');
        assert.match(body.prompt, /sealed letter/);
        return response({ id: 'job-safe', status: 'pending' });
      }
      if (url.includes('/content'))
        return { ok: true, body: [Buffer.from('video')], headers: { get: () => null } };
      return response({
        status: 'completed',
        unsigned_urls: ['https://untrusted.example/video'],
        usage: { cost: 0.1 },
      });
    },
  };
}

test('video job survives restart and is never paid for twice; output URLs do not receive the API key', async (t) => {
  const config = await setup(t);
  const mock = provider();
  await assert.rejects(generateVideoCover(config, entry, { fetchImpl: mock.fetch }), ImagePending);
  const result = await generateVideoCover(config, entry, {
    fetchImpl: mock.fetch,
    convert: async (_, path) => {
      await writeFile(path, gif);
      return { duration: 6 };
    },
  });
  assert.equal(result.status, 'ready');
  assert.equal(mock.posts, 1);
  assert.equal(result.duration, 6);
  await generateVideoCover(config, entry, {
    fetchImpl: async () => {
      throw new Error('Must use cached GIF');
    },
  });
  assert.equal(
    JSON.parse(await readFile(`${coverPath(config, entry.postId)}.video.json`)).status,
    'completed',
  );
});

test('lost video submission response does not trigger another paid job', async (t) => {
  const config = await setup(t);
  const mock = provider();
  let posts = 0;
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/videos') && init?.method === 'POST') {
      posts++;
      throw new Error('lost secret response');
    }
    return mock.fetch(url, init);
  };
  await assert.rejects(generateVideoCover(config, entry, { fetchImpl }), ImageFailure);
  await assert.rejects(
    generateVideoCover(config, entry, { fetchImpl }),
    (error) => error.reason === 'video_submission_uncertain',
  );
  assert.equal(posts, 1);
});

test('confirmed video failure reuses the saved location and scene without another text generation', async (t) => {
  const config = await setup(t);
  const mock = provider();
  let planningCalls = 0;
  let submittedPrompt;
  const fetchImpl = async (url, init) => {
    if (url.endsWith('chat/completions')) planningCalls++;
    if (url.endsWith('/videos') && init?.method === 'POST') {
      const prompt = JSON.parse(init.body).prompt;
      if (submittedPrompt) assert.equal(prompt, submittedPrompt);
      submittedPrompt = prompt;
      assert.match(prompt, /Location: A deserted historical waiting room/);
    }
    if (url.endsWith('/job-safe'))
      return response({ status: 'failed', error: { message: 'failed generation' } });
    return mock.fetch(url, init);
  };
  await assert.rejects(generateVideoCover(config, entry, { fetchImpl }), ImagePending);
  await assert.rejects(generateVideoCover(config, entry, { fetchImpl }), ImageFailure);
  await assert.rejects(generateVideoCover(config, entry, { fetchImpl }), ImagePending);
  assert.equal(planningCalls, 1);
  assert.equal(mock.posts, 2);
  const receipt = JSON.parse(await readFile(`${coverPath(config, entry.postId)}.video.json`));
  assert.equal(receipt.sceneLocation, 'A deserted historical waiting room');
  assert.equal(receipt.sceneFamily, receipt.setting.family);
  assert.equal(receipt.attempts, 2);
});
const post = {
  id: 'literary-test',
  kind: 'literary',
  quoteId: 'austen-hope',
  commentary: 'A quiet memory remains with the person who stayed behind. '.repeat(11),
};

test('morning is text-only; evening waits for GIF, then publishes text and attachment once', async (t) => {
  const config = await setup(t);
  let images = 0;
  let uploaded = 0;
  let sent = 0;
  const options = {
    provider: async () => post,
    sendVK: async (_c, e) => {
      sent++;
      assert.equal(Boolean(e.image), sent === 2);
      return sent;
    },
    notify: async () => {},
  };
  await publish(config, {
    ...options,
    now: new Date('2026-10-06T07:00:00Z'),
    generateImage: async () => {
      throw new Error('Morning must skip media');
    },
  });
  const evening = {
    ...options,
    provider: async () => ({ ...post, id: 'evening-post' }),
    generateImage: async () => {
      images++;
      if (images === 1) throw new ImagePending();
      return { status: 'ready' };
    },
    uploadImage: async () => {
      uploaded++;
      return 'doc-42_9';
    },
  };
  assert.equal(
    (await publish(config, { ...evening, now: new Date('2026-10-06T15:00:00Z') })).status,
    'retry_wait',
  );
  assert.equal(sent, 1);
  const interrupted = await readState(config);
  interrupted.entries.at(-1).image.status = 'generating';
  await writeFile(config.statePath, JSON.stringify(interrupted));
  const later = new Date(Date.now() + 60000);
  assert.equal((await publish(config, { ...evening, now: later })).status, 'sent');
  assert.equal(sent, 2);
  assert.equal(uploaded, 1);
  assert.equal((await readState(config)).entries.length, 2);
});

test('failed evening GIF still publishes text and sends an owner notification', async (t) => {
  const config = { ...(await setup(t)), alertChatId: '1' };
  let alerts = 0;
  const result = await publish(config, {
    now: new Date('2026-10-06T15:00:00Z'),
    provider: async () => post,
    generateImage: async () => {
      throw new ImageFailure('video_generation_failed');
    },
    notify: async () => {
      alerts++;
    },
    sendVK: async (_c, e) => {
      assert.equal(e.image.status, 'failed');
      return 4;
    },
  });
  assert.equal(result.status, 'sent');
  assert.equal(alerts, 1);
});

test('expired video job falls back without submitting another generation', async (t) => {
  const config = await setup(t);
  const mock = provider();
  const started = Date.now();
  await assert.rejects(
    generateVideoCover(config, entry, { fetchImpl: mock.fetch, now: started }),
    ImagePending,
  );
  await assert.rejects(
    generateVideoCover(config, entry, {
      fetchImpl: async () => {
        throw new Error('Expired job must not call provider');
      },
      now: started + 16 * 60000,
    }),
    (error) => error.reason === 'video_generation_timeout',
  );
  assert.equal(mock.posts, 1);
});

test('three failed GIF attempts publish one text-only post and notify on each error', async (t) => {
  const config = { ...(await setup(t)), imageMaxAttempts: 3, alertChatId: '1' };
  let calls = 0;
  let sends = 0;
  let alerts = 0;
  const options = {
    provider: async () => post,
    notify: async () => {
      alerts++;
    },
    generateImage: async () => {
      calls++;
      throw new ImageFailure('video_generation_failed');
    },
    sendVK: async (_c, e) => {
      sends++;
      assert.equal(e.image.status, 'failed');
      return 10;
    },
  };
  assert.equal(
    (await publish(config, { ...options, now: new Date('2026-10-06T15:00:00Z') })).status,
    'retry_wait',
  );
  assert.equal(
    (await publish(config, { ...options, now: new Date(Date.now() + 60000) })).status,
    'retry_wait',
  );
  assert.equal(sends, 0);
  assert.equal(
    (await publish(config, { ...options, now: new Date(Date.now() + 180000) })).status,
    'sent',
  );
  assert.equal(calls, 3);
  assert.equal(sends, 1);
  assert.equal(alerts, 3);
  assert.equal((await readState(config)).entries[0].image.failureAttempts, 3);
});

test('confirmed failed video jobs retry with the same model at most three times', async (t) => {
  const config = { ...(await setup(t)), imageMaxAttempts: 3 };
  const mock = provider();
  let submissions = 0;
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/videos') && init?.method === 'POST') {
      submissions++;
      assert.equal(JSON.parse(init.body).model, 'bytedance/seedance-1-5-pro');
      return response({ id: `failed-${submissions}` });
    }
    if (url.includes('/videos/'))
      return response({ status: 'failed', error: 'provider failure details must stay private' });
    return mock.fetch(url, init);
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(generateVideoCover(config, entry, { fetchImpl }), ImagePending);
    await assert.rejects(
      generateVideoCover(config, entry, { fetchImpl }),
      (error) => error.reason === 'video_generation_failed',
    );
  }
  await assert.rejects(
    generateVideoCover(config, entry, { fetchImpl }),
    (error) => error.reason === 'video_attempts_exhausted',
  );
  assert.equal(submissions, 3);
});

test('real H264 conversion yields a compact seamless GIF within 2 MB', async (t) => {
  // Retain application memory during conversion; run this suite with --memory=256m.
  const applicationMemory = Buffer.alloc(64 * 1024 * 1024, 1);
  const config = await setup(t);
  const output = join(tmpdir(), `bot-loop-${process.pid}-${Date.now()}.gif.tmp`);
  t.after(() => rm(output, { force: true }));
  const result = await convertVideo(
    fileURLToPath(new URL('./fixtures/loop.mp4', import.meta.url)),
    output,
  );
  assert.ok([768, 640, 512, 480, 384].includes(result.width));
  assert.equal(result.height, (result.width * 9) / 16);
  assert.ok(result.frames >= 2);
  assert.ok(result.duration >= 4 && result.duration <= 7);
  assert.ok(result.bytes <= 2000000);
  assert.equal(result.loop, true);
  assert.equal(applicationMemory.at(-1), 1);
  void config;
});

test('VK upload rate limit delays text fallback instead of immediately calling wall.post', async (t) => {
  const config = { ...(await setup(t)), imageMaxAttempts: 1 };
  let sends = 0;
  const options = {
    provider: async () => post,
    generateImage: async () => ({ status: 'ready' }),
    uploadImage: async () => {
      throw new ImageFailure('vk_photo_api_rejected', 6);
    },
    sendVK: async () => {
      sends++;
      return 11;
    },
    notify: async () => {},
  };
  const first = await publish(config, { ...options, now: new Date('2026-10-06T15:00:00Z') });
  assert.equal(first.status, 'retry_wait');
  assert.equal(sends, 0);
  const state = await readState(config);
  const until = state.cooldowns.vk;
  assert.ok(Date.parse(until) >= Date.now() + 119000);
  await publish(config, { ...options, now: new Date(Date.parse(until) - 1) });
  assert.equal(sends, 0);
  assert.equal((await publish(config, { ...options, now: new Date(until) })).status, 'sent');
  assert.equal(sends, 1);
});
