# Security headers (Nginx/Caddy draft)

Apply on `www.dvzverev.ru` after VPS audit.

```
Content-Security-Policy: default-src 'self'; script-src 'self' https://mc.yandex.ru https://mc.yandex.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.yandex.ru https://*.yandex.com; font-src 'self'; connect-src 'self' https://*.yandex.ru https://*.yandex.com; frame-src https://mc.yandex.ru https://mc.yandex.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://t.me
Referrer-Policy: strict-origin-when-cross-origin
X-Content-Type-Options: nosniff
Permissions-Policy: camera=(), microphone=(), geolocation=()
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
```

Adjust CSP if inline critical CSS moves to hashed external files.
