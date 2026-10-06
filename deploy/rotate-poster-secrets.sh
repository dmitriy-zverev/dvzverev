#!/usr/bin/env bash
# Rotate Redis + cabinet credentials in /opt/dvzverev-poster/.env (run ON the VPS or via ssh).
# Does not print secret values — only confirms keys updated.
set -euo pipefail

REMOTE_DIR="${1:-/opt/dvzverev-poster}"
cd "$REMOTE_DIR"

ENV_FILE="$REMOTE_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi

NEW_REDIS="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
NEW_CABINET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
CABINET_ONCE="$REMOTE_DIR/.cabinet-login-password.new"
umask 077
printf '%s\n' "$NEW_CABINET" >"$CABINET_ONCE"
NEW_HASH="$(printf '%s' "$NEW_CABINET" | docker compose run --rm --no-deps -i cabinet node --input-type=module -e "
import { scryptSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
const password = readFileSync(0, 'utf8').trim();
const salt = randomBytes(16);
const derived = scryptSync(password, salt, 64);
process.stdout.write('scrypt:' + salt.toString('base64') + ':' + derived.toString('base64'));
")"
ENC_REDIS="$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$NEW_REDIS")"

python3 <<PY
from pathlib import Path
import re

path = Path("$ENV_FILE")
lines = path.read_text().splitlines()
out = []
keys = {
    "BOT_REDIS_PASSWORD": "$NEW_REDIS",
    "BOT_REDIS_URL": "redis://:$ENC_REDIS@redis:6379",
    "BOT_CABINET_PASSWORD_HASH": "$NEW_HASH",
}
skip = {"BOT_CABINET_PASSWORD"}
for line in lines:
    if not line.strip() or line.lstrip().startswith("#"):
        out.append(line)
        continue
    key = line.split("=", 1)[0].strip()
    if key in skip:
        continue
    if key in keys:
        out.append(f"{key}={keys[key]}")
        keys.pop(key, None)
        continue
    out.append(line)
for key, value in keys.items():
    out.append(f"{key}={value}")
path.write_text("\\n".join(out) + "\\n")
path.chmod(0o600)
PY

docker compose stop redis poster cabinet 2>/dev/null || true
docker compose rm -f redis poster cabinet 2>/dev/null || true
docker compose up -d redis poster cabinet
echo "Rotated BOT_REDIS_PASSWORD, BOT_REDIS_URL, BOT_CABINET_PASSWORD_HASH."
echo "Cabinet login (read once on VPS, then delete): cat $CABINET_ONCE && shred -u $CABINET_ONCE"
echo "Redis password in .env: grep '^BOT_REDIS_PASSWORD=' '$ENV_FILE'"
