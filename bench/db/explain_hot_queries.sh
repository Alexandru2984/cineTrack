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
DB_PORT="${BENCH_DB_PORT:-55433}"
YEAR="$(date +%Y)"

CONTAINER="${BENCH_DB_CONTAINER:-$(docker ps -qf "publish=$DB_PORT" | head -n 1)}"
if [[ -z "$CONTAINER" ]]; then
  echo "test database container is not running on $DB_PORT" >&2
  exit 1
fi

# These queries are copies of what the application runs, and a copy has a shelf
# life. `calendar: up next` measured `air_date <= today` for weeks after the
# application had moved to `episode_has_aired(...)`, so the check reported a
# healthy 21ms for a query nothing executed while the real one took thirteen
# seconds in production. A benchmark that drifts from its subject is worse than
# none: it reports success on work nobody does.
#
# When a hot query changes, change it here. There is no mechanism that will
# notice for you.

# Tables whose growth is unbounded; a sequential scan here is the alarm.
GROWING='watch_history|user_media|episodes|direct_messages'

# The other alarm: wall-clock time.
#
# A plan can use every index correctly and still be slow. `calendar: up next`
# went from 110ms to 13.6 seconds on production data without changing its plan
# at all — a predicate moved into a SQL function carrying a `SET` clause, which
# Postgres cannot inline, so the body ran once per row.
#
# Be clear about what this budget does and does not do, because the temptation
# is to believe it covers more than it can. Measured here, that same fault costs
# 116ms against 16ms healthy: a sevenfold regression that any budget loose
# enough to survive a shared runner will wave through. It was thirteen seconds
# in production only because that library is larger and busier than anything
# seeded.
#
# So this catches a catastrophe — a query that has fallen off a cliff — and
# nothing subtler. The guard for that specific fault is a test in the backend
# suite asserting these functions carry no `SET` clause and stay inlinable,
# which is deterministic and cannot flake. Two instruments, different jobs.
#
# 250ms is an order of magnitude above the slowest healthy query measured here
# (~23ms), which is the most a timing check on shared hardware can honestly
# claim.
BUDGET_MS="${BENCH_QUERY_BUDGET_MS:-250}"
TIME_FAILURES=0

psql() {
  docker exec -i "$CONTAINER" psql -U test_user -d cinetrack_test -X -q "$@"
}

# A third argument names tables this particular case is expected to scan, and
# why must be written above the call. It exists for one shape: a periodic job
# whose driving set *is* a whole table, where reading all of it is the correct
# plan and no index can change that. Every other case leaves it empty, and a
# case that scans something the exemption does not name still fails.
#
# Do not reach for this to quiet a request path. The rule it bends is the one
# this file exists to enforce.
run_case() {
  local name="$1" sql="$2" expected_seq="${3:-}" plan seq_tables unexpected ms
  plan="$(psql -c "EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) $sql" 2>&1)" || {
    printf '%-28s ERROR\n%s\n' "$name" "$plan"
    return 1
  }

  ms="$(sed -n 's/.*Execution Time: \([0-9.]*\) ms/\1/p' <<<"$plan")"
  # Only flag a Seq Scan when it lands on an unbounded table. grep exits 1 when
  # it finds none, which is the good case, so it must not abort the run.
  seq_tables="$(grep -oE "Seq Scan on ($GROWING)" <<<"$plan" | awk '{print $4}' | sort -u | paste -sd, - || true)"

  # Whatever it scanned that this case did not declare.
  #
  # Set arithmetic, done with arrays rather than by piping a comma-separated
  # string through `grep -vxE`. That was the first version and it exempted
  # everything: the here-string appends a newline, `grep` reads a newline in a
  # pattern as separating alternatives, and one of the alternatives was then the
  # empty string — which matches every line. It reported an undeclared
  # sequential scan of `episodes` as "by design" and only a mutation test caught
  # it.
  local -a scanned=() allowed=() unexpected_list=() stale_list=()
  [[ -n "$seq_tables" ]] && IFS=',' read -r -a scanned <<<"$seq_tables"
  [[ -n "$expected_seq" ]] && IFS=',' read -r -a allowed <<<"$expected_seq"

  local table declared found
  for table in "${scanned[@]}"; do
    found=""
    for declared in "${allowed[@]}"; do
      [[ "$table" == "$declared" ]] && found=yes && break
    done
    [[ -z "$found" ]] && unexpected_list+=("$table")
  done

  # A declared table that is no longer scanned is a failure too, for the same
  # reason `check_audit_exceptions.py` fails on one: an exemption nobody has to
  # revisit outlives the reasoning behind it, and the next real scan of that
  # table then passes unnoticed.
  for declared in "${allowed[@]}"; do
    found=""
    for table in "${scanned[@]}"; do
      [[ "$table" == "$declared" ]] && found=yes && break
    done
    [[ -z "$found" ]] && stale_list+=("$declared")
  done

  local unexpected="" stale=""
  (( ${#unexpected_list[@]} )) && unexpected="$(IFS=,; echo "${unexpected_list[*]}")"
  (( ${#stale_list[@]} )) && stale="$(IFS=,; echo "${stale_list[*]}")"

  local verdict="indexed"
  if [[ -n "$expected_seq" && -z "$unexpected" ]]; then
    verdict="indexed (scans $expected_seq by design)"
  fi
  if [[ -n "$unexpected" ]]; then
    verdict="SEQ SCAN: $unexpected"
    PLAN_FAILURES=$((PLAN_FAILURES + 1))
  fi
  if [[ -n "$stale" ]]; then
    verdict="$verdict, STALE EXEMPTION: $stale no longer scanned"
    PLAN_FAILURES=$((PLAN_FAILURES + 1))
  fi

  # Compared as integers: the shell cannot do decimals, and a budget precise to
  # the millisecond would be false precision on a shared runner anyway.
  if [[ -n "$ms" ]] && (( ${ms%%.*} > BUDGET_MS )); then
    verdict="$verdict, OVER BUDGET (${BUDGET_MS}ms)"
    TIME_FAILURES=$((TIME_FAILURES + 1))
  fi

  printf '%-28s %8s ms   %s\n' "$name" "${ms:-?}" "$verdict"

  {
    printf '\n===== %s =====\n' "$name"
    printf '%s\n' "$sql"
    printf -- '-----\n%s\n' "$plan"
  } >>"$PLAN_LOG"
}

PLAN_LOG="$(mktemp)"
REPORT="$(mktemp)"
PLAN_FAILURES=0
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
      AND episode_has_aired(ep.air_date, m.origin_country)
      AND NOT EXISTS (
        SELECT 1 FROM watch_history wh
        WHERE wh.user_id = um.user_id AND wh.episode_id = ep.id)
    GROUP BY m.id LIMIT 20;"

  # Season backfill: which started shows are missing episodes.
  #
  # Not a request path — it runs hourly — but it was 17.6% of all database time
  # on production, more than any single query a person waits for. It got there
  # by aggregating every season against every episode before narrowing to the
  # handful of shows anybody watches, which is the fault this whole file exists
  # to catch. Measured here so the shape cannot quietly come back.
  #
  # `user_media` is scanned by design and cannot be otherwise: this job asks
  # "which tracked show is missing episodes" for every member at once, so every
  # undropped row is in the answer's domain. There is no predicate to index —
  # `status <> 'dropped'` excludes almost nothing — and no per-user key to seek
  # on, because there is no user. Everything the scan feeds is indexed.
  run_case "schedule: season backfill" "
    WITH started AS (
      SELECT DISTINCT m.id AS media_id, m.tmdb_id
      FROM user_media um
      JOIN media m ON m.id = um.media_id AND m.media_type = 'tv'
      JOIN LATERAL (
        SELECT 1 FROM watch_history wh
        WHERE wh.user_id = um.user_id AND wh.media_id = um.media_id
        LIMIT 1
      ) AS started_probe ON TRUE
      WHERE um.status <> 'dropped'
    )
    SELECT started.media_id, started.tmdb_id, se.season_number
    FROM started
    JOIN seasons se ON se.media_id = started.media_id AND se.season_number > 0
    JOIN LATERAL (
      SELECT count(*) AS cached FROM episodes e WHERE e.season_id = se.id
    ) AS held ON TRUE
    WHERE (se.episode_count IS NULL AND held.cached = 0)
       OR (se.episode_count IS NOT NULL AND held.cached < se.episode_count)
    ORDER BY started.media_id, se.season_number
    LIMIT 40;" "user_media"

  # Inbox: rank the newest message and unread total for each peer. This is the
  # most expensive message read because it spans every conversation.
  run_case "messages: conversations" "
    WITH message_rows AS (
      SELECT
        message.*,
        CASE
          WHEN message.sender_id = '$USER_ID' THEN message.recipient_id
          ELSE message.sender_id
        END AS peer_id,
        ROW_NUMBER() OVER (
          PARTITION BY CASE
            WHEN message.sender_id = '$USER_ID' THEN message.recipient_id
            ELSE message.sender_id
          END
          ORDER BY message.created_at DESC, message.id DESC
        ) AS row_number,
        COUNT(*) FILTER (
          WHERE message.recipient_id = '$USER_ID' AND message.read_at IS NULL
        ) OVER (
          PARTITION BY CASE
            WHEN message.sender_id = '$USER_ID' THEN message.recipient_id
            ELSE message.sender_id
          END
        ) AS unread_count
      FROM direct_messages message
      WHERE message.sender_id = '$USER_ID' OR message.recipient_id = '$USER_ID'
    )
    SELECT peer_id, id, body, created_at, unread_count
    FROM message_rows
    WHERE row_number = 1
    ORDER BY created_at DESC, id DESC
    LIMIT 30;"

  run_case "messages: unread summary" "
    SELECT COUNT(*)
    FROM direct_messages
    WHERE recipient_id = '$USER_ID' AND read_at IS NULL;"

  run_case "messages: send rate window" "
    SELECT
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 minute'),
      COUNT(*)
    FROM direct_messages
    WHERE sender_id = '$USER_ID'
      AND created_at >= NOW() - INTERVAL '24 hours';"

  run_case "messages: user quota count" "
    SELECT COUNT(*)
    FROM direct_messages
    WHERE sender_id = '$USER_ID' OR recipient_id = '$USER_ID';"

  run_case "messages: recent thread" "
    SELECT id, sender_id, recipient_id, body, read_at, created_at
    FROM (
      SELECT id, sender_id, recipient_id, body, read_at, created_at
      FROM direct_messages
      WHERE
        (sender_id = '$USER_ID' AND recipient_id = (
          SELECT id FROM users
          WHERE email LIKE 'bench-bg-%@mailbox.dev'
          ORDER BY email LIMIT 1
        ))
        OR (recipient_id = '$USER_ID' AND sender_id = (
          SELECT id FROM users
          WHERE email LIKE 'bench-bg-%@mailbox.dev'
          ORDER BY email LIMIT 1
        ))
      ORDER BY created_at DESC, id DESC
      LIMIT 50
    ) recent
    ORDER BY created_at, id;"

  echo
  echo "Full plans:"
  cat "$PLAN_LOG"
} > "$REPORT"

cat "$REPORT"
[[ "$OUT" != "/dev/stdout" ]] && cp "$REPORT" "$OUT"
if (( PLAN_FAILURES > 0 )); then
  echo "query-plan regression: $PLAN_FAILURES hot path(s) sequentially scanned a growing table" >&2
fi
if (( TIME_FAILURES > 0 )); then
  echo "query-time regression: $TIME_FAILURES hot path(s) took longer than ${BUDGET_MS}ms" >&2
fi
if (( PLAN_FAILURES > 0 || TIME_FAILURES > 0 )); then
  exit 1
fi
