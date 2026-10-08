"""Release preparation retains server OAuth config without importing user tokens."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class ReleaseEnvironmentTest(unittest.TestCase):
    def test_preserves_server_oauth_and_excludes_user_tokens(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'deploy').mkdir()
            (root / 'bot/prompts').mkdir(parents=True)
            script = root / 'deploy/prepare-poster.py'
            shutil.copyfile(Path(__file__).resolve().parents[1] / 'deploy/prepare-poster.py', script)
            (root / 'bot/.env').write_text(
                'VK_ACCESS_TOKEN=community-test\nVK_PHOTOS_ACCESS_TOKEN=local-user-test\n'
                'VK_OAUTH_CLIENT_ID=local-app\nVK_LEGACY_OAUTH_ENABLED=false\n'
            )
            (root / 'bot/compose.production.yaml').write_text('services: {}\n')
            (root / 'bot/service.json').write_text(json.dumps({'projects': {}}))
            (root / 'bot/posts.example.json').write_text('[]')
            server = root / 'server.env'
            server.write_text(
                'VK_OAUTH_CLIENT_ID=server-app\nVK_OAUTH_ENCRYPTION_KEY=server-key\n'
                'VK_OAUTH_ALLOWED_USER_ID=owner\nVK_LEGACY_OAUTH_ENABLED=true\n'
                'VK_LEGACY_CLIENT_ID=legacy-app\nVK_WEEKLY_OAUTH_ENABLED=true\n'
                'VK_WEEKLY_CLIENT_ID=weekly-app\nBOT_CABINET_MEMORY_LIMIT=256m\n'
                'VK_USER_ACCESS_TOKEN=remote-user-test\nVK_OAUTH_ACCESS_TOKEN=unexpected-token\n'
            )
            subprocess.run(
                ['python3', str(script), str(root / 'output'), '--image', 'release-test',
                 '--proxy', 'http://proxy.test', '--preserve-env', str(server)],
                check=True, capture_output=True,
            )
            result = (root / 'output/.env').read_text()
            self.assertIn('VK_OAUTH_CLIENT_ID=server-app\n', result)
            self.assertIn('VK_OAUTH_ENCRYPTION_KEY=server-key\n', result)
            self.assertIn('VK_OAUTH_ALLOWED_USER_ID=owner\n', result)
            self.assertIn('VK_LEGACY_OAUTH_ENABLED=true\n', result)
            self.assertIn('VK_LEGACY_CLIENT_ID=legacy-app\n', result)
            self.assertIn('VK_WEEKLY_OAUTH_ENABLED=true\n', result)
            self.assertIn('VK_WEEKLY_CLIENT_ID=weekly-app\n', result)
            self.assertIn('BOT_CABINET_MEMORY_LIMIT=256m\n', result)
            self.assertNotIn('local-app', result)
            self.assertNotIn('user-test', result)
            self.assertNotIn('unexpected-token', result)
            self.assertEqual(result.count('VK_LEGACY_OAUTH_ENABLED='), 1)
            no_proxy = next(line for line in result.splitlines() if line.startswith('NO_PROXY='))
            self.assertIn('api.vk.com', no_proxy)
            self.assertIn('.vk.com', no_proxy)
            self.assertIn('.vk.ru', no_proxy)
            self.assertIn('.vkuserphoto.ru', no_proxy)


if __name__ == '__main__':
    unittest.main()
