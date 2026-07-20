#!/usr/bin/env bash
# EXPLAIN ANALYZE the predicates behind the hot read paths.
#
# Wall-clock time on its own hides the thing that actually bites in production:
# a query that is fast on a seeded laptop because the planner sequential-scans a
# small table will fall off a cliff once the table is real. So each query is
# reported with its execution time *and* whether it sequential-scanned one of
# the tables that grows without bound. A Seq Scan on watch_history, user_media
# or episodes is the finding; the milliseconds are context.
#
# Usage: explain_hot_queries.sh <user_id> [output_file]

set -euo pipefail

USER_ID="${1:?usage: explain_hot_queries.sh <user_id> [output_file]}"
OUT="${2:-/dev/stdout}"
YEAR="$(date +%Y)"
TODAY="$(date +%F)"

CONTAINER="$(docker ps -qf publish=55433)"
if [[ -z "$CONTAINER" ]]; then
  echo "test database container is not running on 55433" >&2
  exit 1
fi

# Tables whose growth is unbounded; a sequential scan here is the alarm.
GROWING='watch_history|user_media|episodes'

psql() {
  docker exec -i "$CONTAINER" psql -U test_user -d cinetrack_test -X -q "$@"
}

run_case() {
  local name="$1" sql="$2" plan seq_tables ms
  plan="$(psql -c "EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) $sql" 2>&1)" || {
    printf '%-28s ERROR\n%s\n' "$name" "$plan"
    return 1
  }

  ms="$(sed -n 's/.*Execution Time: \([0-9.]*\) ms/\1/p' <<<"$plan")"
  # Only flag a Seq Scan when it lands on an unbounded table. grep exits 1 when
  # it finds none, which is the good case, so it must not abort the run.
  seq_tables="$(grep -oE "Seq Scan on ($GROWING)" <<<"$plan" | awk '{print $4}' | sort -u | paste -sd, - || true)"

  if [[ -n "$seq_tables" ]]; then
    printf '%-28s %8s ms   SEQ SCAN: %s\n' "$name" "${ms:-?}" "$seq_tables"
  else
    printf '%-28s %8s ms   indexed\n' "$name" "${ms:-?}"
  fi

  {
    printf '\n===== %s =====\n' "$name"
    printf '%s\n' "$sql"
    printf -- '-----\n%s\n' "$plan"
  } >>"$PLAN_LOG"
}

PLAN_LOG="$(mktemp)"
REPORT="$(mktemp)"
trap 'rm -f "$PLAN_LOG" "$REPORT"' EXIT

{
  echo "Hot query plans — user $USER_ID"
  echo

  # Library list, the Library tab's main query.
  run_case "tracking: watching" "
    SELECT um.*, m.title, m.poster_path, m.media_type
    FROM user_media um JOIN media m ON m.id = um.media_id
    WHERE um.user_id = '$USER_ID' AND um.status = 'watching'
    ORDER BY um.updated_at DESC LIMIT 50;"

  run_case "tracking: completed page" "
    SELECT um.*, m.title, m.poster_path
    FROM user_media um JOIN media m ON m.id = um.media_id
    WHERE um.user_id = '$USER_ID' AND um.status = 'completed'
    ORDER BY um.updated_at DESC LIMIT 20 OFFSET 40;"

  # Heatmap: one row per active day across the whole history.
  run_case "stats: heatmap" "
    SELECT date_trunc('day', wh.watched_at AT TIME ZONE 'UTC') AS day, count(*)
    FROM watch_history wh
    WHERE wh.user_id = '$USER_ID'
    GROUP BY 1 ORDER BY 1;"

  # Wrapped: the sargable date-range form that replaced EXTRACT(YEAR ...).
  run_case "stats: wrapped range" "
    SELECT count(*), count(DISTINCT wh.media_id)
    FROM watch_history wh
    WHERE wh.user_id = '$USER_ID'
      AND wh.watched_at >= ('$YEAR-01-01'::date::timestamp AT TIME ZONE 'UTC')
      AND wh.watched_at <  (('$YEAR-12-31'::date + 1)::timestamp AT TIME ZONE 'UTC');"

  # The non-sargable form kept as a control, to show the index still matters.
  run_case "stats: wrapped (EXTRACT)" "
    SELECT count(*)
    FROM watch_history wh
    WHERE wh.user_id = '$USER_ID'
      AND EXTRACT(YEAR FROM wh.watched_at AT TIME ZONE 'UTC')::int = $YEAR;"

  run_case "stats: totals" "
    SELECT count(*) AS watches, count(DISTINCT wh.media_id) AS titles
    FROM watch_history wh WHERE wh.user_id = '$USER_ID';"

  run_case "stats: top genres" "
    SELECT g.value->>'name' AS genre, count(*)
    FROM watch_history wh
    JOIN media m ON m.id = wh.media_id
    CROSS JOIN LATERAL jsonb_array_elements(m.genres) g
    WHERE wh.user_id = '$USER_ID'
    GROUP BY 1 ORDER BY 2 DESC LIMIT 10;"

  # Season episode list with watched flags — what opening a season actually
  # runs. It is scoped to one show's season, the way the handler resolves it;
  # querying every season 1 across the catalogue would measure a shape the
  # application never issues.
  run_case "episodes: season list" "
    SELECT ep.id, ep.episode_number, ep.air_date,
           COALESCE(h.watch_count, 0) > 0 AS is_watched
    FROM episodes ep
    JOIN seasons se ON se.id = ep.season_id
    JOIN media m ON m.id = se.media_id
    LEFT JOIN LATERAL (
      SELECT count(*) AS watch_count FROM watch_history wh
      WHERE wh.user_id = '$USER_ID' AND wh.episode_id = ep.id
    ) h ON TRUE
    WHERE m.tmdb_id = 9000001 AND se.season_number = 1
    ORDER BY ep.episode_number;"

  # Up Next: the next unwatched episode per in-progress show.
  run_case "calendar: up next" "
    SELECT m.id, min(ep.air_date)
    FROM user_media um
    JOIN media m ON m.id = um.media_id
    JOIN seasons se ON se.media_id = m.id
    JOIN episodes ep ON ep.season_id = se.id
    WHERE um.user_id = '$USER_ID' AND um.status = 'watching'
      AND ep.air_date <= '$TODAY'
      AND NOT EXISTS (
        SELECT 1 FROM watch_history wh
        WHERE wh.user_id = um.user_id AND wh.episode_id = ep.id)
    GROUP BY m.id LIMIT 20;"

  echo
  echo "Full plans:"
  cat "$PLAN_LOG"
} > "$REPORT"

cat "$REPORT"
[[ "$OUT" != "/dev/stdout" ]] && cp "$REPORT" "$OUT"
exit 0
