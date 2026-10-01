#!/usr/bin/env bash
# Run inside an uploaded release directory. Operates only on dvzverev containers.
set -euo pipefail
exec 9>/opt/dvzverev/deploy.lock
flock -n 9 || { echo 'Another deployment is running'; exit 1; }
RELEASE_ID="${1:?release id required}"
[[ "$RELEASE_ID" =~ ^[a-zA-Z0-9-]+$ ]] || exit 2
IMAGE="dvzverev:$RELEASE_ID"
NAME="dvzverev-web"
CANDIDATE="dvzverev-check-$RELEASE_ID"
docker build -t "$IMAGE" -f deploy/Dockerfile .
docker run --rm "$IMAGE" nginx -t
PREVIOUS="$(docker inspect "$NAME" --format '{{.Config.Image}}' 2>/dev/null || true)"
if [[ -n "$PREVIOUS" ]]; then
  [[ "$(docker inspect "$NAME" --format '{{index .Config.Labels "app"}}')" == dvzverev ]] || { echo 'Container ownership mismatch'; exit 1; }
fi
if [[ -z "$PREVIOUS" ]] && ss -ltn | grep -q ':18082 '; then
  echo 'Port 18082 is already in use; no changes made.' >&2
  exit 1
fi
cleanup() { docker rm -f "$CANDIDATE" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "$CANDIDATE" --label app=dvzverev "$IMAGE"
healthy() {
  local container="$1"
  for ((attempt=0; attempt<15; attempt++)); do
    if docker exec "$container" wget -q -O /dev/null http://127.0.0.1:8080/healthz; then return 0; fi
    sleep 1
  done
  return 1
}
healthy "$CANDIDATE" || { echo 'Candidate failed; current release untouched'; exit 1; }
start() {
  docker network inspect dvzverev_edge >/dev/null 2>&1 || docker network create dvzverev_edge >/dev/null
  docker run -d --name "$NAME" --label app=dvzverev --restart unless-stopped \
    --network dvzverev_edge \
    --memory 128m --cpus 0.5 --security-opt no-new-privileges:true \
    --log-opt max-size=5m --log-opt max-file=2 \
    -p 127.0.0.1:18082:8080 "$1"
}
if [[ -n "$PREVIOUS" ]]; then docker rm -f "$NAME"; fi
if ! start "$IMAGE" || ! healthy "$NAME" || ! curl -fsS http://127.0.0.1:18082/ >/dev/null; then
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if [[ -n "$PREVIOUS" ]]; then start "$PREVIOUS"; healthy "$NAME"; fi
  echo 'Deployment failed; attempted rollback to previous image' >&2
  exit 1
fi
echo "Ready: $IMAGE at 127.0.0.1:18082. Shared proxy was not changed."
