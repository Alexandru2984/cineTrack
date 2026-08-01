#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

for config in \
  "$ROOT_DIR/nginx/vazute.micutu.com.conf" \
  "$ROOT_DIR/nginx/nginx.conf"; do
  grep -Fq 'location = /.well-known/security.txt' "$config"
  grep -Fq 'Contact: mailto:' "$config"
  grep -Fq 'Expires: 2027-07-27T23:59:59Z' "$config"
  grep -Fq 'Canonical: https://vazute.micutu.com/.well-known/security.txt' "$config"
  grep -Fq 'Policy: https://vazute.micutu.com/privacy' "$config"
done

VHOST="$ROOT_DIR/nginx/vazute.micutu.com.conf"
FRONTEND_VHOST="$ROOT_DIR/frontend/nginx-spa.conf"

# The origin must not be reachable directly, and an attacker-supplied XFF chain
# must never be forwarded to Actix as the rate-limit identity.
# shellcheck disable=SC2016 # These are literal nginx variable references.
grep -Fq 'if ($from_cloudflare_origin = 0) { return 403; }' "$VHOST"
# shellcheck disable=SC2016 # These are literal nginx variable references.
grep -Fq 'proxy_set_header X-Forwarded-For $remote_addr;' "$VHOST"
if grep -Fq 'proxy_add_x_forwarded_for' "$VHOST"; then
  echo "edge security error: the client-supplied X-Forwarded-For chain must not be trusted" >&2
  exit 1
fi

# Keep oversized bodies and expensive endpoints bounded before they reach the
# application. The app applies its own item/count limits as a second layer.
grep -Fq 'client_max_body_size 64k;' "$VHOST"
grep -Fq 'client_max_body_size 25M;' "$VHOST"
grep -Fq 'client_max_body_size 4M;' "$VHOST"
grep -Fq 'limit_req zone=vazute_auth burst=10 nodelay;' "$VHOST"
grep -Fq 'limit_req zone=vazute_import burst=2 nodelay;' "$VHOST"
grep -Fq 'limit_conn vazute_api_conn 20;' "$VHOST"

# Keep Cloudflare from injecting a per-request inline bot-detection bootstrap
# into the SPA shell. Its volatile contents cannot be safely hash-allowlisted,
# and weakening script-src with unsafe-inline is not acceptable.
python3 - "$FRONTEND_VHOST" <<'PY'
import pathlib
import re
import sys

text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
for location in ("/", "= /index.html"):
    block = re.search(
        rf"location {re.escape(location)} \{{(?P<body>.*?)\n    \}}",
        text,
        re.DOTALL,
    )
    assert block is not None, f"frontend location {location} is missing"
    assert (
        'add_header Cache-Control "no-cache, no-transform" always;'
        in block.group("body")
    ), f"frontend location {location} permits CDN HTML transformation"
PY

# A calendar-feed URL contains a bearer credential. Neither access nor error
# logs may persist that path. The CSP deliberately permits only named script
# origins; inline JavaScript and eval remain forbidden.
python3 - "$VHOST" <<'PY'
import pathlib
import re
import sys

text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")

feed = re.search(
    r"location \^~ /api/calendar/feed/ \{(?P<body>.*?)\n    \}",
    text,
    re.DOTALL,
)
assert feed is not None, "calendar feed location is missing"
assert "access_log off;" in feed.group("body"), "calendar token access logging is enabled"
assert "error_log /dev/null crit;" in feed.group("body"), "calendar token error logging is enabled"

csp = re.search(r'add_header Content-Security-Policy "(?P<value>[^"]+)" always;', text)
assert csp is not None, "Content-Security-Policy is missing"
value = csp.group("value")
script = re.search(r"(?:^|;)\s*script-src (?P<value>[^;]+)", value)
assert script is not None, "script-src is missing"
script_value = script.group("value")
assert "'unsafe-inline'" not in script_value, "inline scripts must remain blocked"
assert "'unsafe-eval'" not in script_value, "eval must remain blocked"
assert "https://analytics.micutu.com" in script_value
assert "https://static.cloudflareinsights.com" in script_value

assert "limit_conn_zone $binary_remote_addr zone=vazute_assets_conn:10m;" in text
for path in ("/api/img/", "/api/assets/"):
    location = re.search(
        rf"location {re.escape(path)} \{{(?P<body>.*?)\n    \}}",
        text,
        re.DOTALL,
    )
    assert location is not None, f"{path} location is missing"
    body = location.group("body")
    assert "limit_req zone=vazute_assets burst=100 nodelay;" in body
    assert "limit_conn vazute_assets_conn 128;" in body
    assert "limit_conn vazute_api_conn" not in body, (
        f"{path} still shares the interactive API connection ceiling"
    )
PY

# On the production host, make configuration drift fail the local operations
# gate. GitHub runners do not have the host file, so CI still validates the
# repository copy and the invariant checks above.
HOST_VHOST="/etc/nginx/sites-available/vazute.micutu.com"
if [ -r "$HOST_VHOST" ] && ! cmp -s "$VHOST" "$HOST_VHOST"; then
  echo "edge security error: repository and deployed Văzute vhosts differ" >&2
  exit 1
fi

echo "Edge security and configuration-drift checks passed"
