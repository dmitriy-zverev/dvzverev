# Preview deploy

## Cloudflare Pages (recommended)

1. Create Pages project `dvzverev`.
2. Add repository secrets:
   - `CLOUDFLARE_API_TOKEN`
3. Add repository variable:
   - `CLOUDFLARE_ACCOUNT_ID`
4. Open PR — workflow `.github/workflows/preview.yml` runs `pnpm verify`, uploads `dist/`, deploys preview.

Headers for Pages: [`public/_headers`](../public/_headers).

## Local production check

```bash
pnpm verify
pnpm lighthouse
pnpm preview
```

## VPS release

```bash
chmod +x deploy/release.sh
RELEASES_DIR=/var/www/dvzverev/releases CURRENT_LINK=/var/www/dvzverev/current ./deploy/release.sh
```

Nginx template: [`deploy/nginx.conf`](../deploy/nginx.conf)  
Security headers reference: [`docs/security-headers.md`](./security-headers.md)
