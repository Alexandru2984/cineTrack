#!/usr/bin/env bash
set -euo pipefail

# The site moved from vazute.micutu.com to vazute.com. One server block answers
# all three names, and two maps decide what each host gets:
#
# - vazute.com serves everything;
# - www.vazute.com redirects everything to vazute.com;
# - vazute.micutu.com redirects pages, but keeps serving /api/ for installed
#   Android builds and subscribed calendars, /.well-known/ for app-link
#   verification, and a retiring service worker at /sw.js.
#
# Each exception exists because a redirect there breaks a client that cannot
# follow it, and each is one character of regex away from being wrong in a way
# `nginx -t` accepts. So this starts a real nginx on the vhost text and asks.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VHOST="$ROOT_DIR/nginx/vazute.com.conf"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "nginx domain move: skipped, no usable docker" >&2
  exit 0
fi

WORK_DIR="$(mktemp -d)"
CONTAINER="cinetrack-domain-move-$$"
STUBS_PID=""
cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if [[ -n "$STUBS_PID" ]]; then
    kill "$STUBS_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# Held open together so the kernel cannot hand the same port out twice.
read -r EDGE_PORT BACKEND_PORT FRONTEND_PORT <<<"$(python3 - <<'PY'
import socket

held = []
for _ in range(3):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    held.append(sock)
print(" ".join(str(sock.getsockname()[1]) for sock in held))
for sock in held:
    sock.close()
PY
)"

cat > "$WORK_DIR/stubs.py" <<PY
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer


def handler(name):
    class Stub(BaseHTTPRequestHandler):
        def do_GET(self):
            body = f"{name} {self.path}".encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    return Stub


def listen(port, name):
    for _ in range(50):
        try:
            return HTTPServer(("127.0.0.1", port), handler(name))
        except OSError:
            time.sleep(0.1)
    raise SystemExit(f"stub {name} could not bind 127.0.0.1:{port}")


for port, name in (($BACKEND_PORT, "backend"), ($FRONTEND_PORT, "frontend")):
    server = listen(port, name)
    threading.Thread(target=server.serve_forever, daemon=True).start()

threading.Event().wait()
PY

python3 "$WORK_DIR/stubs.py" &
STUBS_PID=$!

# The maps, the redirect and the service-worker locations are lifted out of the
# vhost verbatim, so this exercises the text that ships.
# shellcheck disable=SC2016 # Literal nginx variable names, not shell expansion.
{
  echo 'events {}'
  echo 'http {'
  sed -n '/^map \$host \$vazute_legacy_host {/,/^}/p' "$VHOST"
  sed -n '/^map "\$host\$uri" \$vazute_moved {/,/^}/p' "$VHOST"
  echo '  server {'
  echo "    listen $EDGE_PORT;"
  grep -E '^    server_name ' "$VHOST" | head -n 1
  grep -F 'if ($vazute_moved)' "$VHOST"
  sed -n '/^    location = \/\.well-known\/security\.txt {/,/^    }/p' "$VHOST"
  sed -n '/^    location = \/sw\.js {/,/^    location = \/api\/import\/tvtime {/p' "$VHOST" \
    | sed -e "s/127\.0\.0\.1:8091/127.0.0.1:$FRONTEND_PORT/g" \
          -e '/^    location = \/api\/import\/tvtime {/d'
  echo "    location /api/ { proxy_pass http://127.0.0.1:$BACKEND_PORT; }"
  echo "    location / { proxy_pass http://127.0.0.1:$FRONTEND_PORT; }"
  echo '  }'
  echo '}'
} > "$WORK_DIR/nginx.conf"

# shellcheck disable=SC2016 # grep patterns naming nginx variables, not shell ones.
for required in 'map \$host \$vazute_legacy_host' 'map "\$host\$uri" \$vazute_moved' \
                'server_name vazute.com www.vazute.com vazute.micutu.com;' \
                'if (\$vazute_moved) { return 301 https://vazute.com\$request_uri; }' \
                'location = /sw.js' 'location = /legacy-sw.js' \
                'location = /.well-known/security.txt'; do
  if ! grep -q "$required" "$WORK_DIR/nginx.conf"; then
    echo "nginx domain move: the vhost no longer contains $required;" \
         "this test is extracting the wrong text and would pass vacuously" >&2
    exit 1
  fi
done

docker run --detach --name "$CONTAINER" --network host \
  --volume "$WORK_DIR/nginx.conf:/etc/nginx/nginx.conf:ro" \
  nginx:alpine >/dev/null

ready=0
for _ in $(seq 1 40); do
  if [ "$(curl --silent --output /dev/null --write-out '%{http_code}' \
      --max-time 2 --header 'Host: vazute.com' "http://127.0.0.1:$EDGE_PORT/")" = "200" ]; then
    ready=1
    break
  fi
  sleep 0.25
done
if [ "$ready" -ne 1 ]; then
  echo "nginx domain move: the edge never answered 200 on 127.0.0.1:$EDGE_PORT;" \
       "this is a harness failure, not a routing one" >&2
  docker logs "$CONTAINER" >&2 2>&1 | tail -5 || true
  exit 1
fi

failures=0

served() { # host path expected-body
  local got
  got="$(curl --silent --max-time 5 --header "Host: $1" "http://127.0.0.1:$EDGE_PORT$2")"
  if [[ "$got" != "$3" ]]; then
    printf 'nginx domain move: %s%s\n  want %s\n  got  %s\n' "$1" "$2" "$3" "$got" >&2
    failures=$((failures + 1))
  fi
}

moved() { # host path expected-location
  local got
  got="$(curl --silent --max-time 5 --output /dev/null \
    --write-out '%{http_code} %{redirect_url}' \
    --header "Host: $1" "http://127.0.0.1:$EDGE_PORT$2")"
  if [[ "$got" != "301 $3" ]]; then
    printf 'nginx domain move: %s%s\n  want 301 %s\n  got  %s\n' "$1" "$2" "$3" "$got" >&2
    failures=$((failures + 1))
  fi
}

# The site itself.
served vazute.com "/"                         "frontend /"
served vazute.com "/media/550?type=movie"     "frontend /media/550?type=movie"
served vazute.com "/api/health"               "backend /api/health"
served vazute.com "/sw.js"                    "frontend /sw.js"

# www is only ever a way to the apex, API included: no client was given it.
moved www.vazute.com "/"                      "https://vazute.com/"
moved www.vazute.com "/about?x=1"             "https://vazute.com/about?x=1"
moved www.vazute.com "/api/health"            "https://vazute.com/api/health"

# The old host's pages move, path and query intact, so search engines carry
# what they indexed across and shared links still land on the right page.
moved vazute.micutu.com "/"                   "https://vazute.com/"
moved vazute.micutu.com "/media/550?type=tv"  "https://vazute.com/media/550?type=tv"
moved vazute.micutu.com "/ro/film/550-x"      "https://vazute.com/ro/film/550-x"
moved vazute.micutu.com "/sitemap.xml"        "https://vazute.com/sitemap.xml"
moved vazute.micutu.com "/robots.txt"         "https://vazute.com/robots.txt"
# Only the exact exceptions, not their lookalikes.
moved vazute.micutu.com "/apis"               "https://vazute.com/apis"
moved vazute.micutu.com "/api"                "https://vazute.com/api"
moved vazute.micutu.com "/sw.js.map"          "https://vazute.com/sw.js.map"

# What older clients still need from the old host is answered there.
served vazute.micutu.com "/api/health"        "backend /api/health"
served vazute.micutu.com "/api/calendar/feed/abc.ics" "backend /api/calendar/feed/abc.ics"
served vazute.micutu.com "/.well-known/assetlinks.json" \
  "frontend /.well-known/assetlinks.json"

# security.txt names both places it is served from.
security="$(curl --silent --max-time 5 --header 'Host: vazute.micutu.com' \
  "http://127.0.0.1:$EDGE_PORT/.well-known/security.txt")"
for line in 'Canonical: https://vazute.com/.well-known/security.txt' \
            'Canonical: https://vazute.micutu.com/.well-known/security.txt'; do
  if ! grep -Fxq "$line" <<<"$security"; then
    echo "nginx domain move: security.txt on the old host lacks '$line'" >&2
    failures=$((failures + 1))
  fi
done

# The old host's service worker is replaced by one that retires it. It must be
# served as a script, uncached, and must unregister; anything else leaves an
# installed web app answering from its cache on the old host for good.
headers="$(curl --silent --max-time 5 --dump-header - --output "$WORK_DIR/legacy-sw.js" \
  --header 'Host: vazute.micutu.com' "http://127.0.0.1:$EDGE_PORT/sw.js")"
if ! grep -qi '^content-type: application/javascript' <<<"$headers"; then
  echo "nginx domain move: the retiring worker is not served as JavaScript" >&2
  failures=$((failures + 1))
fi
if ! grep -qi '^cache-control: no-cache' <<<"$headers"; then
  echo "nginx domain move: the retiring worker may be cached" >&2
  failures=$((failures + 1))
fi
for needle in 'self.skipWaiting()' 'caches.delete(name)' \
              'self.registration.unregister()' 'client.navigate(client.url)'; do
  if ! grep -Fq "$needle" "$WORK_DIR/legacy-sw.js"; then
    echo "nginx domain move: the retiring worker lost $needle" >&2
    failures=$((failures + 1))
  fi
done
if command -v node >/dev/null 2>&1 && ! node --check "$WORK_DIR/legacy-sw.js"; then
  echo "nginx domain move: the retiring worker is not valid JavaScript" >&2
  failures=$((failures + 1))
fi

# The retiring worker has no public address of its own.
direct="$(curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' \
  --header 'Host: vazute.com' "http://127.0.0.1:$EDGE_PORT/legacy-sw.js")"
if [[ "$direct" != 404 ]]; then
  echo "nginx domain move: /legacy-sw.js answered $direct directly; it must be internal" >&2
  failures=$((failures + 1))
fi

if ((failures > 0)); then
  echo "nginx domain move: $failures check(s) failed" >&2
  exit 1
fi

echo "nginx domain move: vazute.com serves, www and the old host's pages redirect, old clients keep their API"
