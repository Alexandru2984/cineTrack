#!/usr/bin/env bash
set -euo pipefail

# What this proves, and why grep could not.
#
# nginx inherits `proxy_set_header` from an enclosing level only while the child
# level declares none of its own. Declare one, and the whole inherited set is
# replaced. The SSE location declared exactly one — `Connection ""` — and
# thereby dropped `Host`, `X-Real-IP`, `X-Forwarded-For` and
# `X-Forwarded-Proto` on the one route a client can hold open indefinitely.
#
# The consequence is not cosmetic: the backend derives the rate-limit key from
# the forwarded address, so a client-supplied `X-Forwarded-For` reached it
# unrewritten there. A grep for the directives finds them in the server block
# and reports the vhost as fine, because the text is fine; the defect is in what
# nginx does with it.
#
# So this runs real nginx on the real vhost text, points it at a stub that
# reports the headers it was given, and sends a spoofed `X-Forwarded-For` to
# both an ordinary API route and the SSE route.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VHOST="$ROOT_DIR/nginx/vazute.micutu.com.conf"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "nginx proxy headers: skipped, no usable docker" >&2
  exit 0
fi

WORK_DIR="$(mktemp -d)"
CONTAINER="cinetrack-proxy-headers-$$"
STUB_PID=""
cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  [[ -n "$STUB_PID" ]] && kill "$STUB_PID" 2>/dev/null
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

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

cat > "$WORK_DIR/stub.py" <<PY
from http.server import BaseHTTPRequestHandler, HTTPServer


class Stub(BaseHTTPRequestHandler):
    def do_GET(self):
        body = "\n".join(
            f"{name}: {self.headers.get(name, '<absent>')}"
            for name in ("X-Forwarded-For", "X-Real-IP", "X-Forwarded-Proto", "Host")
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


HTTPServer(("127.0.0.1", $BACKEND_PORT), Stub).serve_forever()
PY

python3 "$WORK_DIR/stub.py" &
STUB_PID=$!

# The server-level headers and the SSE location are lifted from the vhost
# verbatim, so this exercises the text that ships rather than a copy of it.
{
  echo 'events {}'
  echo 'http {'
  echo '  server {'
  echo "    listen $EDGE_PORT;"
  grep -E '^\s+proxy_set_header ' "$VHOST" | head -4
  sed -n '/location = \/api\/events {/,/^    }/p' "$VHOST" \
    | sed -e "s/127\.0\.0\.1:8090/127.0.0.1:$BACKEND_PORT/g" \
          -e '/limit_conn/d' -e '/limit_req/d'
  echo "    location / { proxy_pass http://127.0.0.1:$BACKEND_PORT; }"
  echo '  }'
  echo '}'
} > "$WORK_DIR/nginx.conf"

if ! grep -q 'location = /api/events' "$WORK_DIR/nginx.conf"; then
  echo "nginx proxy headers: the vhost no longer contains the SSE location;" \
       "this test is extracting the wrong text and would pass vacuously" >&2
  exit 1
fi

docker run --detach --name "$CONTAINER" --network host \
  --volume "$WORK_DIR/nginx.conf:/etc/nginx/nginx.conf:ro" \
  nginx:alpine >/dev/null

for _ in $(seq 1 40); do
  curl --silent --max-time 2 "http://127.0.0.1:$EDGE_PORT/" >/dev/null 2>&1 && break
  sleep 0.25
done

SPOOFED="203.0.113.7"
failures=0
for path in "/" "/api/events"; do
  observed="$(curl --silent --max-time 5 \
    --header "X-Forwarded-For: $SPOOFED" \
    "http://127.0.0.1:$EDGE_PORT$path" || true)"

  forwarded="$(sed -n 's/^X-Forwarded-For: //p' <<<"$observed")"
  if [[ "$forwarded" == *"$SPOOFED"* ]]; then
    echo "nginx proxy headers: $path handed the upstream the client's own" \
         "X-Forwarded-For ($forwarded); the rate limiter would key on it" >&2
    failures=$((failures + 1))
  fi
  for header in X-Real-IP X-Forwarded-Proto Host; do
    if grep -q "^$header: <absent>" <<<"$observed"; then
      echo "nginx proxy headers: $path did not set $header" >&2
      failures=$((failures + 1))
    fi
  done
done

if (( failures > 0 )); then
  echo "nginx proxy headers: $failures problem(s)" >&2
  exit 1
fi

echo "nginx proxy headers: every proxied location rewrites the forwarded address"
