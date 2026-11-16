> **Topology, checked 2026-11-15 on the host.** Traffic reaches this host only
> through a Cloudflare Tunnel. `cloudflared` runs as a systemd service
> (`tunnel run`, config in `/etc/cloudflared/config.yml`, which is shared by
> every site on the VPS and is not in this repository). Văzute has no ingress
> rule of its own: it falls to the catch-all, which sends the request to host
> nginx at `https://127.0.0.1:443`, and nginx picks the vhost by `Host`. ufw
> does not admit 80 or 443 from outside, so nginx is not reachable directly
> even though it binds both. An earlier version of this note, from 2026-09-05,
> said there was no tunnel; that is no longer true.

# nginx / edge topology

Văzute serves from **host nginx** (systemd on the VPS), fronted by Cloudflare.
There is intentionally **no nginx container** in `docker-compose.prod.yml`; the
compose stack only exposes the backend and the static frontend on loopback:

```
Cloudflare edge ──tunnel──▶ cloudflared ──▶ host nginx (127.0.0.1:443) ──▶ 127.0.0.1:8090  (backend, actix)
                                                                      └─▶ 127.0.0.1:8091  (frontend, static nginx in container)
```

The tunnel's catch-all reaches nginx over loopback with `noTLSVerify`, since
the connection never leaves the machine. ACME challenges have their own ingress
rule to port 80, where certbot answers them.

**What loopback trust means here.** Every request nginx sees arrives from
`127.0.0.1`, the tunnel's address. So both host files below trust loopback
alongside Cloudflare's ranges: the origin guard has to admit it, and the
real-IP file has to read `CF-Connecting-IP` from it to recover the client.
The consequence is that any process on this host can connect to nginx and state
whatever client address it likes. Nothing outside can, because only the tunnel
and SSH reach the host. Keep that in mind before running untrusted code here.

## Files in this directory

| File | Role |
|------|------|
| `vazute.com.conf` | **The deployed edge vhost.** Exact mirror of `/etc/nginx/sites-available/vazute.com`. Serves `vazute.com`. `www.vazute.com` and the pre-move `vazute.micutu.com` redirect to it with a 301, except that the old host still serves `/api/`, `/.well-known/` and a retiring `/sw.js` for clients installed before the move. Per-route rate limits, Cloudflare-origin gate, security headers + CSP, LetsEncrypt TLS (one certificate for all three names). The local operations gate fails when the two readable files drift. |
| `nginx.conf` | **Validation fixture only** for `nginx -t`. Not deployed. See the header in that file. |

## Host dependencies (NOT in this repo — live under `/etc/nginx`)

The deployed vhost `include`s and relies on these host-level files. They are
shared across every site on the VPS, so they live on the host rather than in
this project repo. To rebuild the edge on a fresh host, recreate them:

| Host path | Purpose | Regenerate |
|-----------|---------|------------|
| `conf.d/cloudflare-realip.conf` | `set_real_ip_from <CF ranges>; real_ip_header CF-Connecting-IP;` plus `set_real_ip_from 127.0.0.1` and `::1` for the tunnel — restores the true client IP; the header is trusted only from Cloudflare's ranges and loopback. Applied **globally** in the `http` block, so it covers this vhost. | `scripts/update-cloudflare-ips.sh` (host) from cloudflare.com/ips-v4 and /ips-v6 |
| `conf.d/cloudflare-origin-guard.conf` | `geo $realip_remote_addr $from_cloudflare_origin { ... }` — set to 1 only when the raw TCP peer is a Cloudflare edge or loopback (the tunnel). The vhost returns 403 when it is 0. With ufw closing 80/443 this is a second layer, not the only one. | same script |
| `snippets/block-dotfiles.conf` | `location ~ /\.(?!well-known).* { deny all; }` — blocks dotfile probing while allowing `/.well-known`. | static |
| `snippets/robots.conf` | serves a shared `robots.txt`. | static |
| `scripts/update-cloudflare-ips.sh` | refreshes the two Cloudflare range files above. | run on the host, `nginx -t && systemctl reload nginx` |
| `nginx.conf` → `variables_hash_max_size 2048;` | The link-preview `map` in this vhost added one variable and took the default 1024 past optimal, so nginx warned on every reload — for all ~68 sites, not just this one. The hash is per-instance, which is why the fix is not in the vhost. | add beside the existing `types_hash_max_size 2048;` in the `http` block |

## Why the client IP is correct (rate limiting & audit)

Because `conf.d/cloudflare-realip.conf` sets `real_ip_header CF-Connecting-IP`
globally and trusts that header only from loopback (the tunnel) and
Cloudflare's published ranges, `$remote_addr` becomes the **real client IP** before nginx `limit_req_zone`
keys on it and before the vhost forwards `X-Forwarded-For $remote_addr` to the
backend. So both nginx and the backend rate-limit and log per real user, not
per Cloudflare edge IP. The origin guard keys on `$realip_remote_addr` (the
pre-rewrite peer), so it judges the hop that actually connected: through the
tunnel, that is loopback.

## Deploy / reload

```bash
sudo cp nginx/vazute.com.conf /etc/nginx/sites-available/vazute.com
sudo nginx -t && sudo systemctl reload nginx
```

When changing the CSP, deploy the **backend first** (so `/api/csp-report`
exists) and the vhost second, so violation reports are not POSTed to a 404.
