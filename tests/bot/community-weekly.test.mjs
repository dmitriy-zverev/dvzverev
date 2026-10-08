import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CommunityWeeklyPublisher } from '../../bot/vk-oauth/community-weekly.mjs';

test('community publisher requires bindGroup before api calls', async () => {
  const publisher = new CommunityWeeklyPublisher(
    {},
    [
      {
        destinationId: 'things-vk',
        credentialEnv: 'VK_THINGS_ACCESS_TOKEN',
        groupIdEnv: 'VK_THINGS_GROUP_ID',
        groupId: '242058626',
        token: 'vk1.a.test-token',
      },
    ],
    async () => ({
      ok: true,
      json: async () => ({ response: [] }),
    }),
  );
  assert.equal(publisher.status().canPrepare, true);
  await assert.rejects(publisher.api('wall.getById', { posts: '-242058626_1' }), /group_not_selected/);
  publisher.bindGroup('242058626');
  await publisher.api('wall.getById', { posts: '-242058626_1' });
});

test('community status reports missing credentials without exposing tokens', () => {
  const publisher = new CommunityWeeklyPublisher(
    { BOT_CONFIG_PATH: join(process.cwd(), 'bot/service.json') },
    [
      {
        destinationId: 'things-vk',
        credentialEnv: 'VK_THINGS_ACCESS_TOKEN',
        groupIdEnv: 'VK_THINGS_GROUP_ID',
        groupId: '',
        token: '',
      },
      {
        destinationId: 'connaissance-vk',
        credentialEnv: 'VK_DARK_ACADEMIA_ACCESS_TOKEN',
        groupIdEnv: 'VK_DARK_ACADEMIA_GROUP_ID',
        groupId: '194579254',
        token: 'vk1.a.present',
      },
    ],
  );
  const status = publisher.status();
  assert.equal(status.canPrepare, false);
  assert.deepEqual(status.missingCredentials, ['VK_THINGS_ACCESS_TOKEN']);
  assert.equal(JSON.stringify(status).includes('vk1.a'), false);
});

test('community uploadWeeklyImage goes straight to docs with GIF config', async () => {
  const seen = [];
  const publisher = new CommunityWeeklyPublisher(
    {},
    [
      {
        destinationId: 'things-vk',
        credentialEnv: 'VK_THINGS_ACCESS_TOKEN',
        groupIdEnv: 'VK_THINGS_GROUP_ID',
        groupId: '42',
        token: 'community-token',
      },
    ],
    fetch,
    async (config, entry) => {
      seen.push({ config, entry });
      return 'doc-42_9';
    },
  );
  publisher.bindGroup('42');
  const attachment = await publisher.uploadWeeklyImage(
    { staticPhoto: true, vkPhotosToken: 'ignored', vkToken: '' },
    { postId: 'p1', vkGroupId: '42' },
  );
  assert.equal(attachment, 'doc-42_9');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].config.staticPhoto, false);
  assert.equal(seen[0].config.vkToken, 'community-token');
  assert.equal(seen[0].config.vkPhotosToken, '');
  assert.equal(seen[0].entry.vkGroupId, '42');
});
