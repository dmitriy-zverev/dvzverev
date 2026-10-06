#!/usr/bin/env bash
# Build poster image, upload config/data bundle, restart poster + cabinet on cloudru.
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_HOST="${1:-cloudru}"
PROXY_URL="${POSTER_HTTP_PROXY:-http://127.0.0.1:3129}"
TAG="$(git -C "$PROJECT_ROOT" rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M%S)"
IMAGE="dvzverev-poster:${TAG}"

cd "$PROJECT_ROOT"
node --test tests/bot/cabinet.test.mjs
docker buildx build --platform linux/amd64 -t "$IMAGE" -f bot/Dockerfile bot/

STAGING="$(mktemp -d /tmp/dvzverev-poster.XXXXXX)"
trap 'rm -rf "$STAGING"' EXIT
python3 deploy/prepare-poster.py "$STAGING" --image "$IMAGE" --proxy "$PROXY_URL"

echo "Loading image on ${DEPLOY_HOST}..."
docker save "$IMAGE" | gzip | ssh -o BatchMode=yes "$DEPLOY_HOST" 'gunzip | docker load'

REMOTE="/opt/dvzverev-poster"
ssh -o BatchMode=yes "$DEPLOY_HOST" "mkdir -p '$REMOTE/backups' && cd '$REMOTE' && docker compose stop poster cabinet 2>/dev/null || docker compose stop poster || true"
BACKUP="$REMOTE/backups/pre-${TAG}.tgz"
ssh -o BatchMode=yes "$DEPLOY_HOST" "cd '$REMOTE' && tar -czf '$BACKUP' .env compose.yaml service.json data 2>/dev/null || true"

scp "$STAGING/configuration.tar.gz" "$DEPLOY_HOST:/tmp/dvzverev-poster-config.tgz"
scp "$STAGING/.env" "$DEPLOY_HOST:/tmp/dvzverev-poster.env"
ssh -o BatchMode=yes "$DEPLOY_HOST" "cd '$REMOTE' && tar -xzf /tmp/dvzverev-poster-config.tgz && rm /tmp/dvzverev-poster-config.tgz && install -m 600 /tmp/dvzverev-poster.env .env && rm /tmp/dvzverev-poster.env"

echo "Migrating cabinet DB..."
ssh -o BatchMode=yes "$DEPLOY_HOST" "cd '$REMOTE' && docker compose run --rm --no-deps cabinet node bot/cabinet/migrate.mjs"

ssh -o BatchMode=yes "$DEPLOY_HOST" "cd '$REMOTE' && docker compose up -d --no-deps poster cabinet"
ssh -o BatchMode=yes "$DEPLOY_HOST" "cd '$REMOTE' && docker compose ps && docker compose exec -T poster node bot/run.mjs --project dark-academia --status"

echo "Poster release $IMAGE deployed. Rollback: set BOT_IMAGE to previous tag in $REMOTE/.env and compose up -d."
