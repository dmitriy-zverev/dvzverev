import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openCabinetDb, setMeta } from '../../bot/cabinet/db.mjs';
import {
  createOzonPost,
  prepareOzonPost,
  getOzonPost,
  publishOzonPost,
  validateOzonInput,
  validateOzonSettings,
  ozonUrl,
  assembleOzonPost,
  claimOzonImageRegeneration,
  regenerateOzonImage,
} from '../../bot/cabinet/ozon.mjs';
import { generateCover, coverPath } from '../../bot/images.mjs';
import { startCabinetServer } from '../../bot/cabinet/server.mjs';

const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=';
function input(overrides = {}) {
  return {
    requestId: randomUUID(),
    projectId: 'things',
    referralUrl: 'https://s.ozon.ru/product?tracking=Keep%2BMe',
    markingUrl: 'https://s.ozon.ru/EICM9Xs',
    name: 'Лампа',
    facts: 'Материал: металл. Цвет: белый.',
    category: 'ordinary',
    references: [{ name: 'Товар.png', data: png }],
    ...overrides,
  };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ozon-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { BOT_CABINET_DB_PATH: join(root, 'cabinet.sqlite') };
  const config = {
    coverPrompt:
      'Warm natural light, tactile materials, lived-in surroundings. Стиль Вещи — кстати.',
    openrouterKey: 'test',
    vkGroupId: '123',
    openrouterModel: 'writer',
    reviewModel: 'reviewer',
    statePath: join(root, 'state.json'),
  };
  const app = {
    service: {
      projects: { things: { enabled: true, delivery: { destinations: ['things-vk'] } } },
      destinations: { 'things-vk': { platform: 'vk' } },
    },
    resolveProjectConfig: async () => config,
  };
  const db = openCabinetDb(env);
  t.after(() => db.close());
  return { root, env, db, app, config };
}
const completion = (data) => ({ choices: [{ message: { content: JSON.stringify(data) } }] });
async function ready(f, overrides = {}) {
  const created = await createOzonPost(f.db, f.env, input(overrides), f.app);
  let calls = 0;
  await prepareOzonPost(f.env, created.post, created.references, f.config, {
    complete: async () =>
      completion(
        ++calls === 1
          ? { text: 'Белая металлическая лампа для рабочего стола.', imagePrompt: 'Лампа на столе' }
          : { approved: true, issues: [] },
      ),
    cover: async () => {},
    overlay: async () => {},
  });
  return getOzonPost(f.db, created.post.id);
}

test('referral URL keeps tracking and excludes impostor hosts, credentials, banned tracking', () => {
  const url = 'https://s.ozon.ru/AbCd?x=a%2Bb&erid=42';
  assert.equal(ozonUrl(url), url);
  for (const bad of [
    'http://ozon.ru/a',
    'https://ozon.ru.evil.test/a',
    'https://evilozon.ru/a',
    'https://me@ozon.ru/a',
    'https://ozon.ru:44/a',
    'https://ozon.ru/a?utm_source=adv_system&utm_medium=banner&utm_campaign=12345',
  ])
    assert.throws(() => ozonUrl(bad));
});
test('input requires its own Ozon marking link and rejects spoofed images', () => {
  assert.equal(validateOzonInput(input()).references.length, 1);
  assert.throws(() =>
    validateOzonInput(
      input({ references: [{ name: 'fake', data: 'data:image/png;base64,YmFk' }] }),
    ),
  );
  assert.throws(() =>
    validateOzonInput(input({ references: Array(5).fill({ name: 'x', data: png }) })),
  );
  assert.throws(() => validateOzonInput(input({ category: 'medical', details: '' })));
  assert.throws(() => validateOzonInput(input({ markingUrl: undefined })));
  assert.throws(() => validateOzonInput(input({ markingUrl: 'https://evil.test' })));
  assert.deepEqual(
    validateOzonSettings({ footer: 'Реклама. https://s.ozon.ru/Old', extraRules: '' }),
    { extraRules: '' },
  );
});
test('prepare snapshots rules and footer, passes references, and never publishes', async (t) => {
  const f = await fixture(t);
  const body = input();
  const created = await createOzonPost(f.db, f.env, body, f.app);
  assert.equal(created.created, true);
  assert.equal((await createOzonPost(f.db, f.env, body, f.app)).created, false);
  assert.throws(() => assembleOzonPost('https://evil.test', created.post));
  assert.throws(() => assembleOzonPost('Лучший товар на Wildberries', created.post));
  setMeta(
    f.db,
    'ozon:settings',
    JSON.stringify({ footer: 'Реклама. https://s.ozon.ru/Other', extraRules: 'Other' }),
  );
  let calls = 0;
  let photo;
  await prepareOzonPost(f.env, created.post, created.references, f.config, {
    complete: async (config, options) => {
      assert.match(options.body.messages[0].content, /Максимальная длина текста 7 000/);
      assert.match(options.body.messages[0].content, /EICM9Xs/);
      if (++calls === 2) assert.equal(config.openrouterModels[0], 'reviewer');
      return completion(
        calls === 1
          ? { text: 'Лампа из белого металла.', imagePrompt: 'На столе' }
          : { approved: true, issues: [] },
      );
    },
    cover: async (config, entry) => {
      photo = { config, entry };
    },
  });
  const saved = getOzonPost(f.db, created.post.id);
  assert.equal(saved.status, 'ready');
  assert.equal(
    saved.message,
    `Лампа из белого металла.\n\n${body.referralUrl}\n\nРеклама. Информация о рекламодателях по ссылке https://s.ozon.ru/EICM9Xs`,
  );
  assert.equal(photo.entry.image.references[0], png);
  assert.match(photo.entry.image.prompt, /Warm natural light/);
  assert.equal(photo.config.staticPhoto, true);
  assert.equal(saved.references[0], 'Товар.png');
  assert.ok(!JSON.stringify(saved).includes('base64'));
});

test('regenerate uses saved style and references, bypasses image cache, preserves text and marking', async (t) => {
  const f = await fixture(t);
  const original = await ready(f, {
    category: 'supplement',
    details: 'Для взрослых по инструкции',
  });
  original.attachment = 'photo-123_5';
  setMeta(f.db, 'ozon:post:' + original.id, JSON.stringify(original));
  f.config.coverPrompt = 'Changed style must not override this draft';
  const claimed = claimOzonImageRegeneration(f.db, original.id, { version: 1 });
  assert.equal(claimed.version, 2);
  assert.equal(claimed.status, 'regenerating');
  assert.throws(() => claimOzonImageRegeneration(f.db, original.id, { version: 2 }));
  await assert.rejects(
    publishOzonPost(f.db, f.env, original.id, { reviewed: true, version: 1 }, { app: f.app }),
  );
  let overlaid = false;
  await regenerateOzonImage(f.env, claimed, {
    app: f.app,
    cover: async (config, entry) => {
      assert.notEqual(entry.postId, original.imageId);
      assert.equal(config.staticPhoto, true);
      assert.equal(entry.image.references[0], png);
      assert.match(entry.image.prompt, /Warm natural light/);
      assert.ok(!entry.image.prompt.includes('Changed style'));
    },
    overlay: async () => {
      overlaid = true;
    },
  });
  const result = getOzonPost(f.db, original.id);
  assert.equal(result.status, 'ready');
  assert.equal(result.message, original.message);
  assert.equal(result.input.markingUrl, original.input.markingUrl);
  assert.notEqual(result.imageId, original.imageId);
  assert.equal(result.attachment, null);
  assert.equal(overlaid, true);
  await assert.rejects(
    publishOzonPost(f.db, f.env, original.id, { reviewed: true, version: 1 }, { app: f.app }),
  );
});
test('failed and interrupted regeneration keep previous photo; published posts cannot regenerate', async (t) => {
  const f = await fixture(t);
  const original = await ready(f);
  let claimed = claimOzonImageRegeneration(f.db, original.id, { version: 1 });
  await regenerateOzonImage(f.env, claimed, {
    app: f.app,
    cover: async () => {
      throw new Error('Provider failure');
    },
  });
  let result = getOzonPost(f.db, original.id);
  assert.equal(result.status, 'ready');
  assert.equal(result.imageId, original.imageId);
  assert.match(result.error, /Предыдущее изображение сохранено/);
  claimed = claimOzonImageRegeneration(f.db, original.id, { version: 2 });
  setMeta(
    f.db,
    'ozon:post:' + original.id,
    JSON.stringify({ ...claimed, leaseUntil: '2000-01-01T00:00:00Z' }),
  );
  result = getOzonPost(f.db, original.id);
  assert.equal(result.status, 'ready');
  assert.equal(result.imageId, original.imageId);
  setMeta(f.db, 'ozon:post:' + original.id, JSON.stringify({ ...result, status: 'sent' }));
  assert.throws(() => claimOzonImageRegeneration(f.db, original.id, { version: 3 }));
});
test('independent review blocks unsupported claims before image generation', async (t) => {
  const f = await fixture(t);
  const created = await createOzonPost(f.db, f.env, input(), f.app);
  let calls = 0;
  await prepareOzonPost(f.env, created.post, created.references, f.config, {
    complete: async () =>
      completion(
        ++calls === 1
          ? { text: 'Лампа.', imagePrompt: 'Фото' }
          : { approved: false, issues: ['Недостоверное свойство'] },
      ),
    cover: async () => assert.fail('Image must not be generated'),
  });
  assert.equal(getOzonPost(f.db, created.post.id).status, 'blocked');
});
test('category disclaimers reach text and image overlay; final length includes footer', async (t) => {
  const f = await fixture(t);
  const post = await ready(f, {
    category: 'supplement',
    details: 'БАД для взрослых, инструкция приложена.',
  });
  assert.match(post.message, /Не является лекарственным средством/);
  assert.throws(() =>
    assembleOzonPost('а'.repeat(6500), {
      ...post,
      input: { ...post.input, markingUrl: 'https://s.ozon.ru/' + 'b'.repeat(1000) },
    }),
  );
});
test('publish requires review and a fresh version; concurrent and repeated requests send once', async (t) => {
  const f = await fixture(t);
  const post = await ready(f);
  let writes = 0;
  let release;
  const block = new Promise((resolve) => {
    release = resolve;
  });
  const dependencies = {
    app: f.app,
    client: {
      accessToken: async () => 'user-token',
      api: async (method, params) => {
        assert.equal(method, 'wall.post');
        assert.equal(params.message, post.message);
        assert.equal(params.guid, post.id);
        writes++;
        await block;
        return { post_id: 44 };
      },
    },
    upload: async () => 'photo-123_5',
  };
  await assert.rejects(publishOzonPost(f.db, f.env, post.id, { reviewed: false }, dependencies));
  await assert.rejects(
    publishOzonPost(f.db, f.env, post.id, { reviewed: true, version: 2 }, dependencies),
  );
  const first = publishOzonPost(f.db, f.env, post.id, { reviewed: true, version: 1 }, dependencies);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    publishOzonPost(f.db, f.env, post.id, { reviewed: true, version: 1 }, dependencies),
  );
  release();
  assert.equal((await first).status, 'sent');
  assert.equal(
    (await publishOzonPost(f.db, f.env, post.id, { reviewed: true, version: 1 }, dependencies)).url,
    'https://vk.ru/wall-123_44',
  );
  assert.equal(writes, 1);
  assert.equal(
    f.db.prepare('SELECT format FROM editions WHERE edition_id=?').get(post.id).format,
    'ozon-advertising',
  );
  assert.equal(
    f.db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE edition_id=?').get(post.id).n,
    1,
  );
});

test('Ozon routes require session and trusted origin; settings and image requests are private', async (t) => {
  const f = await fixture(t);
  const server = startCabinetServer({
    ...f.env,
    BOT_CONFIG_PATH: 'bot/service.json',
    BOT_CABINET_PASSWORD: 'test-password',
    BOT_CABINET_HOST: '127.0.0.1',
    BOT_CABINET_PORT: '0',
  });
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/bot/api/v1`;
  assert.equal((await fetch(base + '/ozon/posts')).status, 401);
  assert.equal((await fetch(base + '/ozon/posts/' + randomUUID() + '/image')).status, 401);
  const login = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { Origin: 'http://127.0.0.1:4321', 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-password' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const settings = await fetch(base + '/ozon/settings', { headers: { Cookie: cookie } });
  assert.equal(settings.status, 200);
  assert.match(settings.headers.get('cache-control'), /private, no-store/);
  assert.equal((await settings.json()).projects.length, 3);
  const payload = JSON.stringify({
    footer: 'Реклама. Информация по ссылке https://s.ozon.ru/Own',
    extraRules: 'Не придумывать личный опыт.',
  });
  assert.equal(
    (
      await fetch(base + '/ozon/settings', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: 'https://evil.test',
          'Content-Type': 'application/json',
        },
        body: payload,
      })
    ).status,
    403,
  );
  const saved = await fetch(base + '/ozon/settings', {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: 'http://127.0.0.1:4321',
      'Content-Type': 'application/json',
    },
    body: payload,
  });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).settings, { extraRules: 'Не придумывать личный опыт.' });
});

test('each post snapshots its own marking URL; old drafts cannot publish with shared marking', async (t) => {
  const f = await fixture(t);
  const first = await ready(f, { markingUrl: 'https://s.ozon.ru/First?erid=A%2BB' });
  const second = await ready(f, { markingUrl: 'https://s.ozon.ru/Second?erid=C%2BD' });
  assert.match(first.message, /First\?erid=A%2BB$/);
  assert.match(second.message, /Second\?erid=C%2BD$/);
  assert.ok(!second.message.includes('First'));
  assert.equal(getOzonPost(f.db, first.id).input.markingUrl, 'https://s.ozon.ru/First?erid=A%2BB');
  delete first.input.markingUrl;
  setMeta(f.db, 'ozon:post:' + first.id, JSON.stringify(first));
  await assert.rejects(
    publishOzonPost(
      f.db,
      f.env,
      first.id,
      { reviewed: true, version: 1 },
      {
        app: f.app,
        client: { accessToken: async () => assert.fail('Old draft must not reach VK') },
      },
    ),
    /отдельной маркировочной ссылки/,
  );
});
test('uncertain VK response persists across reload and cannot be retried', async (t) => {
  const f = await fixture(t);
  const post = await ready(f);
  const dependencies = {
    app: f.app,
    upload: async () => 'photo-123_5',
    client: {
      accessToken: async () => 'token',
      api: async () => {
        throw new Error('timeout');
      },
    },
  };
  const result = await publishOzonPost(
    f.db,
    f.env,
    post.id,
    { reviewed: true, version: 1 },
    dependencies,
  );
  assert.equal(result.status, 'uncertain');
  await assert.rejects(
    publishOzonPost(f.db, f.env, post.id, { reviewed: true, version: 1 }, dependencies),
  );
});
test('expired generation and posting become failed and uncertain rather than another send', async (t) => {
  const f = await fixture(t);
  const post = await ready(f);
  for (const [status, expected] of [
    ['generating', 'failed'],
    ['publishing', 'uncertain'],
  ]) {
    setMeta(
      f.db,
      'ozon:post:' + post.id,
      JSON.stringify({ ...post, status, leaseUntil: '2000-01-01T00:00:00Z' }),
    );
    assert.equal(getOzonPost(f.db, post.id).status, expected);
  }
});
test('image API receives actual references, not filenames, and uses the product prompt', async (t) => {
  const f = await fixture(t);
  const config = {
    ...f.config,
    staticPhoto: true,
    coverMode: 'image',
    imageModel: 'openai/gpt-image-1',
  };
  const entry = {
    postId: 'reference-test',
    image: { text: 'Текст', prompt: 'Точное фото товара', references: [png] },
  };
  await generateCover(config, entry, {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://openrouter.ai/api/v1/images');
      const body = JSON.parse(options.body);
      assert.equal(body.prompt, 'Точное фото товара');
      assert.equal(body.input_references[0].image_url.url, png);
      return { ok: true, json: async () => ({ data: [{ b64_json: png.split(',')[1] }] }) };
    },
    normalize: async (raw, path) => {
      assert.deepEqual(await readFile(raw), Buffer.from(png.split(',')[1], 'base64'));
      const header = Buffer.alloc(24);
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
      header.write('IHDR', 12);
      header.writeUInt32BE(1280, 16);
      header.writeUInt32BE(720, 20);
      await writeFile(path, header);
    },
  });
  assert.equal((await readFile(coverPath(config, entry.postId))).length, 24);
});
test('real image overlay reserves a readable band above the required percentage', async (t) => {
  const f = await fixture(t);
  const image = join(f.root, 'photo.png');
  await mkdir(dirname(image), { recursive: true });
  const execute = promisify(execFile);
  await execute('python3', [
    '-c',
    'from PIL import Image; import sys; Image.new("RGB",(1280,720),"red").save(sys.argv[1])',
    image,
  ]);
  await execute('python3', [
    'bot/cabinet/ozon-disclaimer.py',
    image,
    'Не является лекарственным средством.',
    '0.15',
  ]);
  const { stdout } = await execute('python3', [
    '-c',
    'from PIL import Image; import sys; im=Image.open(sys.argv[1]); assert im.size==(1280,720); assert im.getpixel((1,612))==(255,255,255); assert im.getpixel((1,611))==(255,0,0); print("ok")',
    image,
  ]);
  assert.equal(stdout.trim(), 'ok');
});
