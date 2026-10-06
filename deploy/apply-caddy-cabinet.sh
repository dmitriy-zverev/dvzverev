#!/usr/bin/env bash
# Patch shared Caddy on VPS with /bot/api reverse_proxy (run once after first cabinet deploy).
set -euo pipefail
DEPLOY_HOST="${1:-cloudru}"
MARKER='handle /bot/api/*'
SNIPPET="$(cd "$(dirname "$0")/.." && pwd)/deploy/Caddyfile.snippet"

ssh -o BatchMode=yes "$DEPLOY_HOST" "grep -q '${MARKER}' /opt/mayak/deploy/Caddyfile" && {
  echo 'Caddy already routes /bot/api — skip.'
  exit 0
}

echo 'Update /opt/mayak/deploy/Caddyfile on the server manually from deploy/Caddyfile.snippet, then reload Caddy.'
echo "Reference: $SNIPPET"
exit 1
