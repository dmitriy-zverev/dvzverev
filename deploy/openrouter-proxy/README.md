# OpenRouter through the Latvia VPS

Dedicated Squid forward proxy for the Telegram reading bot in this repository.
This is separate from the Astro static site deployment. The bot runtime and
scheduler will run server-side; API keys must never enter the Astro client bundle.

The supplied configuration is intended for a Debian/Ubuntu VPS with the `squid`
package. Confirm OS and installed Squid version before installing it. It listens
on **127.0.0.1:3129** and permits only CONNECT to **openrouter.ai:443**.
OpenRouter receives the VPS's outbound IP. TLS remains end-to-end; Squid sees
the CONNECT destination, not the API key or prompt. This does not guarantee
account or model availability. OpenRouter's model restrictions still apply:
https://openrouter.ai/terms (section 5.7).

## Install on the VPS

Copy this directory to the VPS first, then run these commands from that directory.
Installing the distro package may also start its default `squid` service; inspect
that service and its listeners before installation. This dedicated configuration
does not replace `/etc/squid/squid.conf` or alter an existing proxy service.

```sh
sudo apt-get update
sudo apt-get install squid
sudo install -m 644 squid.conf /etc/squid/openrouter.conf
sudo /usr/sbin/squid -k parse -f /etc/squid/openrouter.conf
sudo install -m 644 squid-openrouter.service /etc/systemd/system/squid-openrouter.service
sudo systemctl daemon-reload
sudo systemctl enable --now squid-openrouter
sudo systemctl status squid-openrouter --no-pager
sudo ss -ltnp
```

Verify port 3129 listens only on 127.0.0.1. The SSH alias is `myvps`. The VPS OS has not yet been checked, so this setup
has not been deployed or validated on the server.

## Connect from another machine

Use the supplied SSH alias `myvps`. Keep the tunnel running;
production needs a supervised tunnel or a private network configuration.

```sh
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -L 127.0.0.1:13129:127.0.0.1:3129 myvps
```

On the client, the proxy URL is `http://127.0.0.1:13129`. A bot running directly
on the VPS uses `http://127.0.0.1:3129` instead. A container's localhost refers
to the container; container access needs an explicit host/private network route.

## Smoke checks through the tunnel

These calls need no API key and do not publish Telegram messages.

```sh
# Expect HTTPS 200 and the model catalog.
curl --noproxy '' --proxy http://127.0.0.1:13129 \
  --connect-timeout 10 --max-time 30 \
  --output /dev/null --write-out '%{http_code}\n' \
  https://openrouter.ai/api/v1/models

# Expect CONNECT rejection (403). curl exits nonzero on the rejected tunnel.
curl --noproxy '' --proxy http://127.0.0.1:13129 \
  --connect-timeout 10 --max-time 30 https://example.com

# Expect 403: ordinary HTTP is not allowed.
curl --noproxy '' --proxy http://127.0.0.1:13129 \
  --connect-timeout 10 --max-time 30 \
  --output /dev/null --write-out '%{http_code}\n' http://openrouter.ai
```

The LLM client must explicitly support an HTTP CONNECT proxy. Do not assume that
setting `HTTPS_PROXY` makes every Node.js fetch/SDK implementation use it. Apply
proxy transport only to LLM calls; feed collection and Telegram use their own
connections. If the tunnel fails, fail the LLM task rather than silently switching
to a direct connection.

## Operations

```sh
sudo journalctl -u squid-openrouter -n 100 --no-pager
sudo tail -n 100 /var/log/squid/openrouter-cache.log
sudo /usr/sbin/squid -k parse -f /etc/squid/openrouter.conf
sudo systemctl reload squid-openrouter
sudo /usr/sbin/squid -k rotate -f /etc/squid/openrouter.conf
```

Schedule log rotation with the server's existing operations tooling. To stop this
dedicated proxy, run `sudo systemctl disable --now squid-openrouter`. Keep public
port 3129 closed. Direct remote access requires a separately configured private
listener and client ACL; do not change the listener to 0.0.0.0 without them.
