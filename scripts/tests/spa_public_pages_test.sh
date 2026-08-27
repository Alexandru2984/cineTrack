#!/usr/bin/env bash
set -euo pipefail

# The prerendered public pages must be reachable at the address they claim.
#
# `prerender-public-pages.mjs` writes each public route as its own directory —
# `/about/index.html` — so that `/about` can carry its own title, description and
# canonical instead of the homepage's. With `try_files $uri $uri/`, nginx served
# that by redirecting `/about` to `/about/`, and it built the redirect out of the
# container's own address:
#
#   301 -> http://vazute.micutu.com:8080/about/
#
# Wrong scheme, and the internal port leaked into a public response. Following it
# from outside reaches nothing, so the pages the prerendering exists to get
# indexed could not be fetched by anything that followed the redirect. A
# `grep` for `absolute_redirect` would not have found this, because the defect is
# what nginx *does* with a directory, not what the file says.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONF="$ROOT_DIR/frontend/nginx-spa.conf"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "spa public pages: skipped, no usable docker" >&2
  exit 0
fi

WORK_DIR="$(mktemp -d)"
CONTAINER="cinetrack-spa-public-pages-$$"
cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

PORT="$(python3 - <<'PY'
import socket
with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    print(s.getsockname()[1])
PY
)"

# The same shape the build produces: a directory per public route.
mkdir -p "$WORK_DIR/html/about" "$WORK_DIR/html/privacy" "$WORK_DIR/html/assets"
printf '<html><head><title>About</title></head><body>about</body></html>' \
  > "$WORK_DIR/html/about/index.html"
printf '<html><head><title>Privacy</title></head><body>privacy</body></html>' \
  > "$WORK_DIR/html/privacy/index.html"
printf '<html><head><title>Home</title></head><body><div id="root"></div></body></html>' \
  > "$WORK_DIR/html/index.html"
printf 'body{}' > "$WORK_DIR/html/assets/app.css"

{
  echo 'events {}'
  echo 'http {'
  echo '  include /etc/nginx/mime.types;'
  sed "s/listen 8080;/listen $PORT;/" "$CONF"
  echo '}'
} > "$WORK_DIR/nginx.conf"

docker run --detach --name "$CONTAINER" --network host \
  --volume "$WORK_DIR/nginx.conf:/etc/nginx/nginx.conf:ro" \
  --volume "$WORK_DIR/html:/usr/share/nginx/html:ro" \
  nginx:alpine >/dev/null

for _ in $(seq 1 40); do
  curl --silent --max-time 2 "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break
  sleep 0.25
done

failures=0

# A public page answers where it was asked for, without a detour.
for path in /about /privacy; do
  read -r code redirect <<<"$(curl --silent --max-time 5 --output /dev/null \
    --header "Host: vazute.micutu.com" \
    --write-out '%{http_code} %{redirect_url}' "http://127.0.0.1:$PORT$path")"
  if [[ "$code" != 200 ]]; then
    echo "spa public pages: $path answered $code (redirect: ${redirect:-none});" \
         "a prerendered page must be served at its own address" >&2
    failures=$((failures + 1))
  fi
  # Belt and braces: whatever the status, nothing may name the internal port.
  if [[ -n "$redirect" && "$redirect" == *:8080* ]]; then
    echo "spa public pages: $path leaked the container port in $redirect" >&2
    failures=$((failures + 1))
  fi
done

# The SPA fallback still works for client-rendered routes, and assets still 200.
for path in /dashboard /assets/app.css /; do
  code="$(curl --silent --max-time 5 --output /dev/null \
    --header "Host: vazute.micutu.com" \
    --write-out '%{http_code}' "http://127.0.0.1:$PORT$path")"
  if [[ "$code" != 200 ]]; then
    echo "spa public pages: $path answered $code, want 200" >&2
    failures=$((failures + 1))
  fi
done

# And the page served at /about is the prerendered one, not the shell.
body="$(curl --silent --max-time 5 --header "Host: vazute.micutu.com" \
  "http://127.0.0.1:$PORT/about")"
if [[ "$body" != *"<title>About</title>"* ]]; then
  echo "spa public pages: /about served the SPA shell instead of its own page" >&2
  failures=$((failures + 1))
fi

if ((failures > 0)); then
  echo "spa public pages: $failures check(s) failed" >&2
  exit 1
fi

echo "spa public pages: each prerendered page answers at its own address"
