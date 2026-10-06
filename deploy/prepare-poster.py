"""Prepare private release inputs; never copy legacy VK user authorization."""
import argparse
import json
import os
import secrets
from pathlib import Path
from urllib.parse import quote
import shutil
import tarfile

parser = argparse.ArgumentParser()
parser.add_argument('output')
parser.add_argument('--image', required=True)
parser.add_argument('--proxy', required=True)
args = parser.parse_args()
os.umask(0o077)
root = Path(__file__).resolve().parents[1]
bot = root / 'bot'
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)
excluded = {'VK_PHOTOS_ACCESS_TOKEN', 'VK_USER_ACCESS_TOKEN', 'VK_ACCESS_TOKEN_USER', 'VK_REFRESH_TOKEN', 'VK_DEVICE_ID', 'VK_OAUTH_CLIENT_ID', 'VK_OAUTH_CLIENT_SECRET', 'BOT_ENV_FILE', 'NODE_OPTIONS', 'BOT_IMAGE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY'}
lines = []
for line in (bot / '.env').read_text().splitlines():
    if not line.strip() or line.lstrip().startswith('#'):
        continue
    if '=' not in line:
        raise ValueError('Unsupported multiline environment file')
    key = line.split('=', 1)[0].strip()
    if key in excluded or key.startswith('VKID_') or ('VK' in key and any(x in key for x in ['USER', 'REFRESH', 'PHOTOS', 'DEVICE'])):
      continue
    if key == 'BOT_IMAGE':
      continue
    lines.append(line)
lines += ['BOT_IMAGE=' + args.image, 'HTTP_PROXY=' + args.proxy, 'HTTPS_PROXY=' + args.proxy,
          'NO_PROXY=localhost,127.0.0.1,api.vk.com,api.vk.ru,.vk.com,.vk.ru,.vkuserphoto.ru,.vkuserphoto.net',
          'NODE_USE_ENV_PROXY=1']
redis_password = os.environ.get('BOT_REDIS_PASSWORD', '').strip()
if not any(line.startswith('BOT_REDIS_PASSWORD=') for line in lines):
    if not redis_password:
        redis_password = secrets.token_urlsafe(32)
    lines.append('BOT_REDIS_PASSWORD=' + redis_password)
else:
    for line in lines:
        if line.startswith('BOT_REDIS_PASSWORD='):
            redis_password = line.split('=', 1)[1].strip()
            break
if not any(line.startswith('BOT_REDIS_URL=') for line in lines):
    lines.append('BOT_REDIS_URL=redis://:' + quote(redis_password, safe='') + '@redis:6379')

def set_env(key, value):
    global lines
    lines = [line for line in lines if not line.startswith(key + '=')]
    lines.append(key + '=' + value)

for key, value in {
    'BOT_CABINET_DB_PATH': '/app/data/cabinet.sqlite',
    'BOT_CABINET_SECURE_COOKIES': 'true',
    'BOT_CABINET_ALLOWED_ORIGINS': 'https://www.dvzverev.ru,https://dvzverev.ru',
}.items():
    set_env(key, value)

cabinet_hash = os.environ.get('BOT_CABINET_PASSWORD_HASH', '').strip()
cabinet_password = os.environ.get('BOT_CABINET_PASSWORD', '').strip()
lines = [line for line in lines if not line.startswith('BOT_CABINET_PASSWORD=') and not line.startswith('BOT_CABINET_PASSWORD_HASH=')]
if cabinet_hash:
    set_env('BOT_CABINET_PASSWORD_HASH', cabinet_hash)
elif cabinet_password:
    set_env('BOT_CABINET_PASSWORD', cabinet_password)
else:
    set_env('BOT_CABINET_PASSWORD', secrets.token_urlsafe(24))

(output / '.env').write_text('\n'.join(lines) + '\n')
os.chmod(output / '.env', 0o600)
with tarfile.open(output / 'configuration.tar.gz', 'w:gz') as archive:
    archive.add(bot / 'compose.production.yaml', arcname='compose.yaml')
    archive.add(bot / 'service.json', arcname='service.json')
    archive.add(bot / 'prompts', arcname='prompts')
    archive.add(bot / 'posts.example.json', arcname='content/posts.json')
with tarfile.open(output / 'data.tar.gz', 'w:gz') as archive:
    service = json.loads((bot / 'service.json').read_text())
    allowed = ['state.json', 'state.json.errors.json', 'analytics.json', 'analytics.json.errors.json',
               'generation-costs.jsonl', 'generation-costs.jsonl.meta.json', 'generation-costs.jsonl.errors.json']
    for project_id, project in service['projects'].items():
        if not project['enabled']:
            continue
        directory = (bot / project['statePath']).parent
        for name in allowed:
            path = directory / name
            if path.exists():
                archive.add(path, arcname=str(path.relative_to(bot)))
        images = directory / 'images'
        for path in images.glob('*'):
            if path.is_file() and (path.name.endswith('.gif') or path.name.endswith('.gif.video.json')):
                archive.add(path, arcname=str(path.relative_to(bot)))
print(json.dumps({'prepared': True, 'projects': list(service['projects']), 'vkUserAuthorizationIncluded': False}))
