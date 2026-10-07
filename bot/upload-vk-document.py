import json
import secrets
import sys
import urllib.parse
import urllib.request
from pathlib import Path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


try:
    request = json.load(sys.stdin)
    if request.get('operation') == 'api':
        method = request['method']
        if method not in ('docs.getWallUploadServer', 'docs.save', 'photos.getWallUploadServer', 'photos.saveWallPhoto'):
            raise ValueError('Invalid API method')
        api_request = urllib.request.Request('https://api.vk.ru/method/' + method,
            data=urllib.parse.urlencode(request['params']).encode())
        opener = urllib.request.build_opener(NoRedirect)
        with opener.open(api_request, timeout=25) as response:
            result = json.loads(response.read(1_000_000))
        # Return only fields needed by the caller; error request_params can contain the token.
        if 'error' in result:
            result = {'error': {'error_code': result['error'].get('error_code')}}
        print(json.dumps(result))
        sys.exit(0)
    url = urllib.parse.urlsplit(request['url'])
    host = url.hostname or ''
    allowed = ('vk.ru', 'vk.com', 'vkuserphoto.ru', 'vkuserphoto.net')
    if (url.scheme != 'https' or url.username or url.password or url.port
            or not any(host == item or host.endswith('.' + item) for item in allowed)):
        raise ValueError('Invalid destination')
    data = Path(request['path']).read_bytes()
    boundary = 'vkdoc' + secrets.token_hex(12)
    photo = request.get('kind') == 'photo'
    field, filename, mime = ('photo', 'cover.png', 'image/png') if photo else ('file', 'cover.gif', 'image/gif')
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; '
            f'filename="{filename}"\r\nContent-Type: {mime}\r\n\r\n').encode()
    body += data + f'\r\n--{boundary}--\r\n'.encode()
    upload = urllib.request.Request(request['url'], data=body, headers={
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': str(len(body)),
    })
    opener = urllib.request.build_opener(NoRedirect)
    with opener.open(upload, timeout=30) as response:
        result = json.loads(response.read(1_000_000))
    if photo:
        if not result.get('photo') or not isinstance(result.get('server'), int) or not isinstance(result.get('hash'), str):
            raise ValueError('No uploaded photo')
        print(json.dumps({key: result[key] for key in ('photo', 'server', 'hash')}))
        sys.exit(0)
    if not isinstance(result.get('file'), str) or not result['file']:
        raise ValueError('No uploaded document')
    print(json.dumps({'file': result['file']}))
except Exception:
    # Signed upload URLs and server responses must not appear in diagnostics.
    sys.stderr.write('VK document upload failed\n')
    sys.exit(1)
