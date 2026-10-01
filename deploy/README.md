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
networks and other applications are not modified. No server-side Node is needed.
Nginx serves gzip precompressed assets; the stock image does not support Brotli.

Initial publication still requires a separately reviewed Caddy route for
`www.dvzverev.ru` and an apex redirect, DNS and TLS. A Caddy container cannot
reach the host using its own `127.0.0.1`; routing needs a verified host gateway
or a dedicated shared network. Do not blindly paste a localhost upstream.

Updates have a brief interruption for this landing only while its container is
replaced. A lock prevents overlapping deployments. Deploy from a clean checkout
to make the commit label match the uploaded content. Base image uses a mutable
stable tag; pin a tested digest for reproducible deployments.
