#!/usr/bin/env bash
set -euo pipefail

# What this proves, and why grep could not.
#
# The vhost sends link-preview crawlers to the backend's card handlers and
# everybody else to the application. The first attempt spelled that the obvious
# way:
#
#     location ~ "^/media/([0-9]+)$" {
#         if ($vazute_unfurler) { proxy_pass http://127.0.0.1:8090/unfurl/media/$1; }
#         proxy_pass http://127.0.0.1:8091;
#     }
#
# `nginx -t` accepts it. It is also wrong: `proxy_pass` inside `if` runs in an
# implicit nested location that does not inherit the enclosing regex captures,
# so `$1` is empty and every shared link reaches `/unfurl/media/` with the id
# dropped. A static check reads that config as correct, because the text says
# exactly what it should say — the defect is in what nginx does with it.
#
# So this starts a real nginx on the real vhost text, points it at two stub
# upstreams that report which one answered and on what path, and asks.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VHOST="$ROOT_DIR/nginx/vazute.micutu.com.conf"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "nginx unfurl routing: skipped, no usable docker" >&2
  exit 0
fi

WORK_DIR="$(mktemp -d)"
CONTAINER="cinetrack-unfurl-routing-$$"
STUBS_PID=""
cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  [[ -n "$STUBS_PID" ]] && kill "$STUBS_PID" 2>/dev/null || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# Ports nothing else on the machine is holding. A developer box and a runner
# both host plenty; picking blind makes this fail for reasons unrelated to nginx.
free_port() {
  python3 - <<'PY'
import socket
with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    print(s.getsockname()[1])
PY
}
EDGE_PORT="$(free_port)"
BACKEND_PORT="$(free_port)"
FRONTEND_PORT="$(free_port)"

cat > "$WORK_DIR/stubs.py" <<PY
import threading
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


for port, name in (($BACKEND_PORT, "backend"), ($FRONTEND_PORT, "frontend")):
    server = HTTPServer(("127.0.0.1", port), handler(name))
    threading.Thread(target=server.serve_forever, daemon=True).start()

threading.Event().wait()
PY

python3 "$WORK_DIR/stubs.py" &
STUBS_PID=$!

# The map and the three preview locations are lifted out of the vhost verbatim,
# so this exercises the text that ships rather than a copy that can drift from it.
{
  echo 'events {}'
  echo 'http {'
  # shellcheck disable=SC2016 # Literal nginx variable names, not shell expansion.
  sed -n '/^map \$http_user_agent \$vazute_unfurler {/,/^}/p' "$VHOST"
  echo '  server {'
  echo "    listen $EDGE_PORT;"
  sed -n '/^    location ~ "\^\/lists\//,/^    location \/ {/p' "$VHOST" \
    | sed -e "s/127\.0\.0\.1:8090/127.0.0.1:$BACKEND_PORT/g" \
          -e "s/127\.0\.0\.1:8091/127.0.0.1:$FRONTEND_PORT/g" \
          -e '/^    location \/ {/d'
  echo "    location / { proxy_pass http://127.0.0.1:$FRONTEND_PORT; }"
  echo '  }'
  echo '}'
} > "$WORK_DIR/nginx.conf"

for required in 'location ~ "\^/lists/' 'location ~ "\^/media/' \
                'location ~ "\^/profile/' 'location \^~ /unfurl/'; do
  if ! grep -q "$required" "$WORK_DIR/nginx.conf"; then
    echo "nginx unfurl routing: the vhost no longer contains $required;" \
         "this test is extracting the wrong text and would pass vacuously" >&2
    exit 1
  fi
done

docker run --detach --name "$CONTAINER" --network host \
  --volume "$WORK_DIR/nginx.conf:/etc/nginx/nginx.conf:ro" \
  nginx:alpine >/dev/null

for _ in $(seq 1 40); do
  curl --silent --max-time 2 "http://127.0.0.1:$EDGE_PORT/" >/dev/null 2>&1 && break
  sleep 0.25
done

BROWSER="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36"
LIST_ID="9d9a1f2e-0000-4000-8000-000000000000"
failures=0

expect() { # description user-agent path expected-answer
  local got
  got="$(curl --silent --max-time 5 --user-agent "$2" "http://127.0.0.1:$EDGE_PORT$3")"
  if [[ "$got" != "$4" ]]; then
    printf 'nginx unfurl routing: %s\n  request %s as %s\n  want %s\n  got  %s\n' \
      "$2" "$3" "$1" "$4" "$got" >&2
    failures=$((failures + 1))
  fi
}

# A crawler must receive the card for the thing that was actually shared. An
# empty id here is the original defect.
expect "a film"    "Discordbot/2.0"          "/media/550"       "backend /unfurl/media/550"
expect "a profile" "facebookexternalhit/1.1" "/profile/micutu"  "backend /unfurl/profile/micutu"
expect "a list"    "WhatsApp/2.23"           "/lists/$LIST_ID"  "backend /unfurl/list/$LIST_ID"
expect "a film with its type" "Twitterbot/1.0" "/media/550?type=movie" \
  "backend /unfurl/media/550?type=movie"

# A reader must be unaffected. Being wrong about a user agent should cost a
# preview, never a page.
expect "a browser"   "$BROWSER"      "/media/550"      "frontend /media/550"
expect "a browser"   "$BROWSER"      "/profile/micutu" "frontend /profile/micutu"
expect "a browser"   "$BROWSER"      "/lists/$LIST_ID" "frontend /lists/$LIST_ID"
# Search engines index the application, not the card: the card is a summary and
# would be thin, duplicate content under the same canonical.
expect "a search engine" "Googlebot/2.1" "/media/550"  "frontend /media/550"

# Only the three shapes worth previewing are diverted.
expect "a sub-page"     "Discordbot/2.0" "/media/550/cast" "frontend /media/550/cast"
expect "a non-numeric"  "Discordbot/2.0" "/media/abc"      "frontend /media/abc"
expect "a short id"     "Discordbot/2.0" "/lists/abc"      "frontend /lists/abc"
expect "the homepage"   "Discordbot/2.0" "/"               "frontend /"

# The card is not a page of its own: a second public address for the same
# content is exactly what the canonical work was meant to stop.
direct="$(curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' \
  --user-agent "$BROWSER" "http://127.0.0.1:$EDGE_PORT/unfurl/media/550")"
if [[ "$direct" != 404 ]]; then
  echo "nginx unfurl routing: /unfurl/ answered $direct directly; it must be internal" >&2
  failures=$((failures + 1))
fi

if ((failures > 0)); then
  echo "nginx unfurl routing: $failures check(s) failed" >&2
  exit 1
fi

echo "nginx unfurl routing: crawlers get the shared thing, readers get the app"
