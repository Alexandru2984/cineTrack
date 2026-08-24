#!/usr/bin/env bash
# What is actually slow in production, ranked by total time spent.
#
# The benchmark in `bench/db` measures fourteen queries chosen by hand against
# seeded data. This reads what really ran: every statement the application
# issued, how often, and how much of the database's time each consumed. The two
# answer different questions, and this is the one that notices a query nobody
# thought to benchmark.
#
# Ranked by total rather than mean on purpose. A query taking 400ms once a week
# matters less than one taking 8ms fifty times a second, and sorting by mean
# puts the wrong one on top.
#
# Usage: scripts/slow_queries.sh [rows]           (default 15)
#        scripts/slow_queries.sh --reset          start a fresh measuring window
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB_USER="$(grep -oP '(?<=^POSTGRES_USER=).*' .env.prod)"
DB_NAME="$(grep -oP '(?<=^POSTGRES_DB=).*' .env.prod)"
CONTAINER="${DB_CONTAINER:-cinetrack-db-1}"

psql() { docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -X -q "$@"; }

if ! psql -tAc "SELECT 1 FROM pg_extension WHERE extname='pg_stat_statements'" | grep -q 1; then
  cat >&2 <<'MISSING'
pg_stat_statements is not installed.

It is preloaded by docker-compose.prod.yml, but creating the extension needs
superuser and so is not something a migration can do. Once, after the database
has restarted with the new configuration:

  docker exec -i cinetrack-db-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements;'
MISSING
  exit 1
fi

if [[ "${1:-}" == "--reset" ]]; then
  psql -c "SELECT pg_stat_statements_reset();" >/dev/null
  echo "measuring window reset; let real traffic run before reading it again"
  exit 0
fi

ROWS="${1:-15}"

psql -c "
SELECT
  ROUND(total_exec_time)::text || ' ms' AS total,
  calls,
  ROUND(mean_exec_time::numeric, 2)::text || ' ms' AS mean,
  ROUND(100 * total_exec_time / NULLIF(SUM(total_exec_time) OVER (), 0))::text || '%' AS share,
  LEFT(REGEXP_REPLACE(query, '\s+', ' ', 'g'), 90) AS statement
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = CURRENT_DATABASE())
ORDER BY total_exec_time DESC
LIMIT $ROWS;"
