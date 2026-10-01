#!/usr/bin/env bash
# Local: bash deploy/vps.sh [SSH alias]. No changes to the shared proxy.
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_HOST="${1:-cloudru}"
RELEASE_ID="$(git -C "$PROJECT_ROOT" rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M%S)"
cd "$PROJECT_ROOT"
pnpm build
pnpm precompress
pnpm size-budget
pnpm check-bundle
ARCHIVE="$(mktemp /tmp/dvzverev-release.XXXXXX)"
trap 'rm -f "$ARCHIVE"' EXIT
tar -czf "$ARCHIVE" dist deploy/Dockerfile deploy/nginx-container.conf deploy/install-container.sh
ssh -o BatchMode=yes "$DEPLOY_HOST" "mkdir -p /opt/dvzverev/releases/$RELEASE_ID"
scp "$ARCHIVE" "$DEPLOY_HOST:/opt/dvzverev/releases/$RELEASE_ID/release.tgz"
ssh -o BatchMode=yes "$DEPLOY_HOST" "cd /opt/dvzverev/releases/$RELEASE_ID && tar -xzf release.tgz && bash deploy/install-container.sh '$RELEASE_ID'"
