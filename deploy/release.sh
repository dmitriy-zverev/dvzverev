#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RELEASES_DIR="${RELEASES_DIR:-/var/www/dvzverev/releases}"
CURRENT_LINK="${CURRENT_LINK:-/var/www/dvzverev/current}"
BUILD_ID="$(date +%Y%m%d%H%M%S)"
TARGET="${RELEASES_DIR}/${BUILD_ID}"

cd "$ROOT"
pnpm build
pnpm precompress

mkdir -p "$TARGET"
rsync -a --delete dist/ "$TARGET/"
ln -sfn "$TARGET" "$CURRENT_LINK"

echo "Deployed release ${BUILD_ID} -> ${CURRENT_LINK}"
