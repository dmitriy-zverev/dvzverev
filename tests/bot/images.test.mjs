import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  configFromEnv,
  publish,
  readState,
  TelegramRejection,
  VkRejection,
  sendTelegramPhoto,
  sendVk,
} from '../../bot/core.mjs';
import { generateCover, coverPath, uploadVkCover, ImageFailure } from '../../bot/images.mjs';

const post = {
  id: 'cover-test',
  kind: 'tip',
  title: 'Тесты для агентов',
  summary: 'Практический совет. '.repeat(10),
  why: 'Проверяем поведение',
  action: 'Добавьте тест',
};
const png = Buffer.alloc(24);
png.write('89504e470d0a1a0a', 'hex');
png.writeUInt32BE(1280, 16);
png.writeUInt32BE(720, 20);
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bot-images-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return configFromEnv({
    TELEGRAM_BOT_TOKEN: '123:secret',
    TELEGRAM_CHAT_ID: '@test',
    BOT_ALERT_CHAT_ID: '1',
    BOT_IMAGES_ENABLED: 'true',
    VK_IMAGES_ENABLED: 'true',
    BOT_STATE_PATH: join(dir, 'state.json'),
    VK_ACCESS_TOKEN: 'wall-token',
    VK_GROUP_ID: '42',
  });
}

test('cover receives the actual post, is cached after normalization, and never regenerates on cache hits', async (t) => {
  const config = await setup(t);
  config.openrouterKey = 'secret';
  const entry = { postId: post.id, image: { text: 'Ускоряем ревью тестами' } };
  let requests = 0;
  const options = {
    fetchImpl: async (url, init) => {
      requests++;
      assert.equal(url, 'https://openrouter.ai/api/v1/images');
      const body = JSON.parse(init.body);
      assert.match(body.prompt, /Ускоряем ревью тестами/);
      assert.equal(body.n, 1);
      assert.equal(body.model, 'inclusionai/ming-image-0.1-design');
      return {
        ok: true,
        json: async () => ({ data: [{ b64_json: png.toString('base64') }], usage: { cost: 0 } }),
      };
    },
    normalize: async (_, output) => writeFile(output, png),
  };
  assert.equal((await generateCover(config, entry, options)).cost, 0);
  assert.equal((await generateCover(config, entry, options)).width, 1280);
  assert.equal(requests, 1);
  await assert.rejects(
    generateCover(
      config,
      { postId: 'other', image: entry.image },
      {
        fetchImpl: async () => {
          throw new Error('secret');
        },
      },
    ),
    (e) => e instanceof ImageFailure && !e.message.includes('secret'),
  );
});

test('captioned photo retry and VK retry reuse the image without sending separate text', async (t) => {
  const config = await setup(t);
  let images = 0,
    photos = 0,
    texts = 0,
    uploads = 0,
    walls = 0;
  const options = {
    manual: true,
    provider: async () => post,
    generateImage: async () => {
      images++;
      return { status: 'ready' };
    },
    sendPhoto: async () => {
      photos++;
      if (photos === 1) throw new TelegramRejection(429, 1);
      return 100;
    },
    send: async () => {
      texts++;
      if (texts === 1) throw new TelegramRejection(429, 1);
      return 101;
    },
    uploadImage: async () => {
      uploads++;
      return 'photo-42_77';
    },
    sendVK: async (_, entry) => {
      walls++;
      assert.equal(entry.image.vk.attachment, 'photo-42_77');
      if (walls === 1) throw new VkRejection(6);
      return 102;
    },
    notify: async () => {},
  };
  assert.equal((await publish(config, options)).status, 'retry_wait');
  await publish(config, { ...options, manual: false, now: new Date(Date.now() + 60000) });
  assert.equal(
    (await publish(config, { ...options, manual: false, now: new Date(Date.now() + 120000) }))
      .status,
    'sent',
  );
  assert.deepEqual(
    { images, photos, texts, uploads, walls },
    { images: 1, photos: 2, texts: 0, uploads: 1, walls: 2 },
  );
  const state = await readState(config);
  assert.equal(state.entries[0].messageId, 100);
});

test('image failures and missing VK photo rights alert only in Telegram and preserve text publication', async (t) => {
  const config = await setup(t);
  let alerts = 0,
    texts = 0;
  const options = {
    manual: true,
    provider: async () => post,
    generateImage: async () => {
      throw new ImageFailure('image_api_rejected', 503);
    },
    send: async () => {
      texts++;
      return 1;
    },
    sendVK: async () => 2,
    notify: async (_, html) => {
      alerts++;
      assert.match(html, /image_api_rejected/);
    },
  };
  assert.equal((await publish(config, options)).status, 'sent');
  assert.equal(texts, 1);
  assert.equal(alerts, 1);
  assert.deepEqual((await readState(config)).pauses, {});
  const next = { ...post, id: 'next' };
  assert.equal(
    (
      await publish(config, {
        ...options,
        provider: async () => next,
        generateImage: async () => ({ status: 'ready' }),
        sendPhoto: async () => 10,
        uploadImage: uploadVkCover,
        notify: async (_, html) => {
          alerts++;
          assert.match(html, /vk_photo_token_required/);
        },
      })
    ).status,
    'sent',
  );
  assert.equal(alerts, 2);
});

test('unknown captioned photo delivery blocks duplicate text and VK until operator review', async (t) => {
  const config = await setup(t);
  let photos = 0;
  const options = {
    manual: true,
    provider: async () => post,
    generateImage: async () => ({ status: 'ready' }),
    sendPhoto: async () => {
      photos++;
      throw new Error('connection lost');
    },
    send: async () => 1,
    sendVK: async () => 2,
    uploadImage: async () => 'photo-42_1',
    notify: async () => {},
  };
  assert.equal((await publish(config, options)).status, 'uncertain');
  await publish(config, { ...options, manual: false });
  assert.equal(photos, 1);
  assert.equal((await readState(config)).entries[0].status, 'uncertain');
});

test('captioned photo respects rate limits and retries only after confirmed rejection', async (t) => {
  const config = await setup(t);
  let photos = 0,
    texts = 0;
  const options = {
    manual: true,
    provider: async () => post,
    generateImage: async () => ({ status: 'ready' }),
    sendPhoto: async () => {
      photos++;
      if (photos === 1) throw new TelegramRejection(429, 60);
      return 100;
    },
    send: async () => {
      texts++;
      return 1;
    },
    sendVK: async () => 2,
    uploadImage: async () => 'photo-42_1',
    notify: async () => {},
  };
  assert.equal((await publish(config, options)).status, 'retry_wait');
  assert.equal(texts, 0);
  await publish(config, { ...options, now: new Date(Date.now() + 120000) });
  assert.equal(texts, 0);
  assert.equal(photos, 2);
});

test('restart during image generation consumes no second generation and still delivers saved text', async (t) => {
  const config = await setup(t);
  let generated = 0;
  const entry = {
    slot: 'slot',
    postId: post.id,
    platform: 'telegram',
    status: 'retry_wait',
    retryAt: new Date().toISOString(),
    attempts: 0,
    html: '<b>Сохранённый пост</b>',
    vkText: 'Сохранённый пост',
    vkGroupId: '42',
    image: { status: 'generating', text: 'Сохранённый пост' },
  };
  await writeFile(
    config.statePath,
    JSON.stringify({
      version: 1,
      chatId: config.chatId,
      entries: [entry],
      pauses: {},
      cooldowns: {},
    }),
  );
  assert.equal(
    (
      await publish(config, {
        generateImage: async () => {
          generated++;
        },
        send: async () => 1,
        sendVK: async () => 2,
        notify: async () => {},
      })
    ).status,
    'sent',
  );
  assert.equal(generated, 0);
  assert.equal((await readState(config)).entries[0].image.status, 'failed');
});

test('short posts use one captioned photo; VK transport includes the saved attachment', async (t) => {
  const config = await setup(t);
  let texts = 0;
  const short = { ...post, summary: 'Короткий совет.' };
  assert.equal(
    (
      await publish(config, {
        manual: true,
        provider: async () => short,
        generateImage: async () => ({ status: 'ready' }),
        sendPhoto: async (_, entry, caption) => {
          assert.equal(entry.image.status, 'ready');
          assert.match(caption, /Короткий совет/);
          return 10;
        },
        send: async () => {
          texts++;
          return 11;
        },
        uploadImage: async () => 'photo-42_1',
        sendVK: async (cfg, entry) =>
          sendVk(cfg, entry, async (_, init) => {
            assert.equal(init.body.get('attachments'), 'photo-42_1');
            return { ok: true, json: async () => ({ response: { post_id: 12 } }) };
          }),
        notify: async () => {},
      })
    ).status,
    'sent',
  );
  assert.equal(texts, 0);
});

test('VK photo upload validates destination before upload and uses a separate token', async (t) => {
  const config = await setup(t);
  config.vkPhotosToken = 'photos-token';
  let calls = 0;
  await assert.rejects(
    uploadVkCover(config, { postId: post.id, vkGroupId: '42' }, async (_, init) => {
      calls++;
      assert.equal(init.body.get('access_token'), 'photos-token');
      return {
        ok: true,
        json: async () => ({ response: { upload_url: 'http://127.0.0.1/admin' } }),
      };
    }),
    (e) => e.reason === 'invalid_vk_upload_url',
  );
  assert.equal(calls, 1);
});

test('Telegram photo transport uploads binary data and sanitizes unknown responses', async (t) => {
  const config = await setup(t);
  await generateCover(
    { ...config, openrouterKey: 'key' },
    { postId: post.id, image: { text: 'Topic' } },
    {
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ data: [{ b64_json: png.toString('base64') }] }),
      }),
      normalize: async (_, output) => writeFile(output, png),
    },
  );
  assert.equal((await readFile(coverPath(config, post.id))).length, png.length);
  assert.equal(
    await sendTelegramPhoto(config, { postId: post.id }, '<b>Заголовок</b>', async (url, init) => {
      assert.ok(url.endsWith('/sendPhoto'));
      assert.equal(init.body.get('caption'), '<b>Заголовок</b>');
      assert.equal(init.body.get('photo').type, 'image/png');
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 15 } }) };
    }),
    15,
  );
  await assert.rejects(
    sendTelegramPhoto(config, { postId: post.id }, '', async () => {
      throw new Error('secret');
    }),
    (e) => !e.message.includes('secret'),
  );
});

test('restart after an unconfirmed separate photo never sends that photo again', async (t) => {
  const config = await setup(t);
  let photos = 0,
    texts = 0;
  const entry = {
    slot: 'slot',
    postId: post.id,
    platform: 'telegram',
    status: 'retry_wait',
    retryAt: new Date().toISOString(),
    attempts: 0,
    html: `<b>Дайджест</b>\n\n${'Текст материала. '.repeat(100)}`,
    vkText: 'Text',
    vkGroupId: '42',
    image: { status: 'ready', text: 'Topic', telegram: { status: 'sending' } },
  };
  await writeFile(
    config.statePath,
    JSON.stringify({
      version: 1,
      chatId: config.chatId,
      entries: [entry],
      pauses: {},
      cooldowns: {},
    }),
  );
  assert.equal(
    (
      await publish(config, {
        sendPhoto: async () => {
          photos++;
          return 100;
        },
        send: async () => {
          texts++;
          return 1;
        },
        uploadImage: async () => 'photo-42_5',
        sendVK: async () => 2,
        notify: async () => {},
      })
    ).status,
    'sent',
  );
  assert.equal(photos, 0);
  assert.equal(texts, 1);
  assert.equal((await readState(config)).entries[0].image.telegram.status, 'uncertain');
});

test('VK upload saves a photo with the photos token and returns a reusable attachment', async (t) => {
  const config = await setup(t);
  config.vkPhotosToken = 'photos-token';
  const entry = { postId: post.id, vkGroupId: '42', image: { text: 'Topic' } };
  await generateCover({ ...config, openrouterKey: 'key' }, entry, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ data: [{ b64_json: png.toString('base64') }] }),
    }),
    normalize: async (_, output) => writeFile(output, png),
  });
  const urls = [];
  const attachment = await uploadVkCover(config, entry, async (url, init) => {
    urls.push(url);
    let response;
    if (url.endsWith('/photos.getWallUploadServer')) {
      assert.equal(init.body.get('access_token'), 'photos-token');
      response = { upload_url: 'https://pu.vk.com/upload' };
    } else if (url.endsWith('/photos.saveWallPhoto')) {
      assert.equal(init.body.get('access_token'), 'photos-token');
      assert.equal(init.body.get('group_id'), '42');
      assert.equal(init.body.get('photo'), '[photo]');
      response = [{ owner_id: -42, id: 99 }];
    } else {
      assert.equal(init.body.get('photo').type, 'image/png');
      return { ok: true, json: async () => ({ photo: '[photo]', hash: 'hash', server: 123 }) };
    }
    return { ok: true, json: async () => ({ response }) };
  });
  assert.equal(attachment, 'photo-42_99');
  assert.equal(urls.length, 3);
});

test('overlong photo captions are rejected before generation or delivery, never split into two posts', async (t) => {
  const config = await setup(t);
  let images = 0,
    photos = 0,
    texts = 0,
    walls = 0;
  const result = await publish(config, {
    manual: true,
    provider: async () => ({ ...post, summary: 'Длинный текст. '.repeat(100) }),
    generateImage: async () => {
      images++;
      return { status: 'ready' };
    },
    sendPhoto: async () => {
      photos++;
      return 1;
    },
    send: async () => {
      texts++;
      return 2;
    },
    sendVK: async () => {
      walls++;
      return 3;
    },
    notify: async () => {},
  });
  assert.equal(result.status, 'failed');
  assert.deepEqual({ images, photos, texts, walls }, { images: 0, photos: 0, texts: 0, walls: 0 });
});

test('VK text-only mode skips photo upload and alerts while Telegram keeps its captioned cover', async (t) => {
  const config = await setup(t);
  config.vkImagesEnabled = configFromEnv({}).vkImagesEnabled;
  assert.equal(config.vkImagesEnabled, false);
  let photos = 0,
    walls = 0;
  const result = await publish(config, {
    manual: true,
    provider: async () => post,
    generateImage: async () => ({ status: 'ready' }),
    sendPhoto: async () => {
      photos++;
      return 10;
    },
    uploadImage: async () => {
      assert.fail('VK must not upload images');
    },
    sendVK: async (_, entry) => {
      walls++;
      assert.equal(entry.image.vk, undefined);
      return 20;
    },
    notify: async () => {
      assert.fail('Disabled VK images must not create alerts');
    },
  });
  assert.equal(result.status, 'sent');
  assert.equal(photos, 1);
  assert.equal(walls, 1);
  await sendVk(
    config,
    { vkGroupId: '42', vkText: 'Text', slot: 'slot', image: { vk: { attachment: 'photo-42_77' } } },
    async (_, init) => {
      assert.equal(init.body.has('attachments'), false);
      return { ok: true, json: async () => ({ response: { post_id: 21 } }) };
    },
  );
});
