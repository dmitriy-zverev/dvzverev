import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  chooseSceneSetting,
  generateVideoScene,
  recentVideoScenes,
} from '../../bot/video-scenes.mjs';
import { coverPath } from '../../bot/images.mjs';
import { configFromEnv } from '../../bot/core.mjs';

test('scene families rotate independently for literary and lifestyle communities', () => {
  for (const contentMode of ['literary', 'lifestyle']) {
    const history = [];
    for (let i = 0; i < 20; i++) {
      const next = chooseSceneSetting({ contentMode }, history, () => 0);
      assert.ok(!history.slice(-5).some((previous) => previous.family === next.family));
      assert.ok(next.direction && next.seed);
      history.push(next);
    }
    assert.ok(new Set(history.map((scene) => scene.family)).size >= 6);
  }
});

test('confirmed scene history includes legacy receipts but excludes unsent posts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'scene-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = configFromEnv({ BOT_STATE_PATH: join(dir, 'state.json') });
  const path = `${coverPath(config, 'old')}.video.json`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ scene: 'A window with a candle.' }));
  const history = await recentVideoScenes(config, [
    { status: 'sent', postId: 'old', image: {} },
    {
      status: 'sent',
      postId: 'new',
      image: {
        scene: 'An empty theatre.',
        sceneLocation: 'A closed theatre',
        sceneFamily: 'theatre',
      },
    },
    { status: 'pending', postId: 'pending', image: { scene: 'Must not appear' } },
  ]);
  assert.equal(history.length, 2);
  assert.equal(history[0].scene, 'A window with a candle.');
  assert.equal(history[1].family, 'theatre');
});

test('location planning receives post, style and recent scenes; exact repeated locations are rejected', async () => {
  const config = {
    openrouterKey: 'test',
    openrouterModels: ['test/model'],
    videoPrompt: 'Muted period painting. [SCENE]',
  };
  const previous = [
    {
      family: 'railway',
      location: 'An empty railway waiting room',
      scene: 'A sealed letter on a forgotten bench as a curtain gently moves.',
    },
  ];
  const setting = chooseSceneSetting({}, previous, () => 0);
  let input;
  const fetchImpl = async (_url, init) => {
    input = JSON.parse(JSON.parse(init.body).messages[1].content);
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                location: previous[0].location,
                scene: 'A different scene with rain falling across the empty platform.',
              }),
            },
          },
        ],
      }),
    };
  };
  await assert.rejects(
    generateVideoScene(
      config,
      { postId: 'p', image: { text: 'A memory of separation' } },
      setting,
      previous,
      fetchImpl,
    ),
    (error) => error.reason === 'invalid_or_repeated_video_scene',
  );
  assert.equal(input.post, 'A memory of separation');
  assert.equal(input.settingFamily, setting.family);
  assert.equal(input.locationDirection, setting.direction);
  assert.deepEqual(input.recentScenes, previous);
  assert.match(input.visualStyle, /Muted period painting/);
});
