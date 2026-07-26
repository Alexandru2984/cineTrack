# nginx / edge topology

Văzute serves from **host nginx** (systemd on the VPS), fronted by Cloudflare.
There is intentionally **no nginx container** in `docker-compose.prod.yml`; the
compose stack only exposes the backend and the static frontend on loopback:

```
Cloudflare ──TLS──▶ host nginx (443) ──▶ 127.0.0.1:8090  (backend, actix)
                                      └─▶ 127.0.0.1:8091  (frontend, static nginx in container)
```

## Files in this directory

| File | Role |
|------|------|
| `vazute.micutu.com.conf` | **The deployed edge vhost.** Mirror of `/etc/nginx/sites-available/vazute.micutu.com`. Per-route rate limits, Cloudflare-origin gate, security headers + CSP, LetsEncrypt TLS. |
| `nginx.conf` | **Validation fixture only** for `nginx -t`. Not deployed. See the header in that file. |

## Host dependencies (NOT in this repo — live under `/etc/nginx`)

The deployed vhost `include`s and relies on these host-level files. They are
shared across every site on the VPS, so they live on the host rather than in
this project repo. To rebuild the edge on a fresh host, recreate them:

| Host path | Purpose | Regenerate |
|-----------|---------|------------|
| `conf.d/cloudflare-realip.conf` | `set_real_ip_from <CF ranges>; real_ip_header CF-Connecting-IP;` — restores the true client IP (anti-spoofed: only trusted from CF edge peers). Applied **globally** in the `http` block, so it covers this vhost. | `scripts/update-cloudflare-ips.sh` (host) from cloudflare.com/ips-v4 and /ips-v6 |
| `conf.d/cloudflare-origin-guard.conf` | `geo $realip_remote_addr $from_cloudflare_origin { ... }` — set to 1 only when the raw TCP peer is a Cloudflare edge (or loopback). The vhost returns 403 when it is 0, so the origin cannot be reached directly, bypassing Cloudflare. | same script |
| `snippets/block-dotfiles.conf` | `location ~ /\.(?!well-known).* { deny all; }` — blocks dotfile probing while allowing `/.well-known`. | static |
| `snippets/robots.conf` | serves a shared `robots.txt`. | static |
| `scripts/update-cloudflare-ips.sh` | refreshes the two Cloudflare range files above. | run on the host, `nginx -t && systemctl reload nginx` |

## Why the client IP is correct (rate limiting & audit)

Because `conf.d/cloudflare-realip.conf` sets `real_ip_header CF-Connecting-IP`
globally and only trusts that header from Cloudflare's published ranges,
`$remote_addr` becomes the **real client IP** before nginx `limit_req_zone`
keys on it and before the vhost forwards `X-Forwarded-For $remote_addr` to the
backend. So both nginx and the backend rate-limit and log per real user, not
per Cloudflare edge IP. The origin guard keys on `$realip_remote_addr` (the
pre-rewrite peer), so it still authenticates the Cloudflare hop itself.

## Deploy / reload

```bash
sudo cp nginx/vazute.micutu.com.conf /etc/nginx/sites-available/vazute.micutu.com
sudo nginx -t && sudo systemctl reload nginx
```

When changing the CSP, deploy the **backend first** (so `/api/csp-report`
exists) and the vhost second, so violation reports are not POSTed to a 404.
