# Isolated VPS deployment

Run `bash deploy/vps.sh cloudru` locally with pnpm, SSH and SCP installed.
The first-time prerequisite is an owned `/opt/dvzverev/releases` directory:
`sudo install -d -o zverev -g zverev -m 755 /opt/dvzverev /opt/dvzverev/releases`.
The script builds and checks the static site, uploads a new directory under
`/opt/dvzverev/releases`, builds an Nginx image on the VPS, checks a candidate
container, and replaces only the labelled `dvzverev-web` container.
On failed startup it attempts to restore the previous image. Images and release
directories are retained; there is no global Docker cleanup.

The endpoint is **127.0.0.1:18082**, not a public port. Shared Caddy, databases,
and other applications are not modified. The script creates/uses the isolated
`dvzverev_edge` network. No server-side Node is needed.
Nginx serves gzip precompressed assets; the stock image does not support Brotli.

Production Caddy routes were installed on 2026-10-01 (see `Caddyfile.snippet`).
`mayak-caddy-1` and `dvzverev-web` are connected to `dvzverev_edge`.
The original Caddy configuration is backed up on the VPS at
`/opt/mayak/deploy/Caddyfile.before-dvzverev-20261001`.
The www hostname serves the landing; the apex redirects to www once its DNS
resolves. TLS is managed by Caddy.

Important: the Caddy network attachment survives restart, but not container
recreation. Before redeploying Mayak, preserve these routes in its source
Caddyfile and declare `dvzverev_edge` as an external network attached to its
Caddy service. This landing deployment does not edit the Mayak project.

Updates have a brief interruption for this landing only while its container is
replaced. A lock prevents overlapping deployments. Deploy from a clean checkout
to make the commit label match the uploaded content. Base image uses a mutable
stable tag; pin a tested digest for reproducible deployments.
