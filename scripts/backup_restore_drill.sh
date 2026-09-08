#!/usr/bin/env bash
# Restore the latest backup into a scratch database and check what came back.
#
# The backups were verified readable, never restorable. `backup_to_r2.sh` runs
# `pg_restore --list`, which parses the archive's table of contents — enough to
# catch a truncated upload, and nothing at all about whether restoring it
# produces a working database. `scripts/tests/backup_restore_test.sh` looks like
# it covers this and does not: it stubs `docker`, so it tests the backup
# script's own logic against a mock.
#
# That left the honest status of the backups as "unknown", which is the state
# that turns into a catastrophe on the one day it matters. This answers the
# question by doing the thing: download, decrypt, restore, look at the result,
# throw the scratch database away.
#
# It is deliberately not a CI job. It needs the real archive, the real Age
# identity and the production database container, none of which belong on a
# runner. Run it from cron, or by hand after anything that changes the schema.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../.env.prod}"
DB_CONTAINER="${DB_CONTAINER:-cinetrack-db-1}"
DRILL_DATABASE="${DRILL_DATABASE:-cinetrack_restore_drill}"
STATE_DIR="${BACKUP_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/cinetrack}"
METRICS_FILE="${RESTORE_DRILL_METRICS_FILE:-$STATE_DIR/restore_drill.prom}"
STARTED_AT="$(date +%s)"
SUCCESS=0
TABLES_CHECKED=0
ROWS_RESTORED=0

if [[ -r "$ENV_FILE" ]]; then
  # Only the variables this script needs. Values are never printed.
  # shellcheck disable=SC1090
  source <(grep -E '^POSTGRES_(USER|DB)=' "$ENV_FILE" || true)
fi
POSTGRES_USER="${POSTGRES_USER:-cinetrack_user}"
POSTGRES_DB="${POSTGRES_DB:-cinetrack}"

if [[ "$DRILL_DATABASE" == "$POSTGRES_DB" ]]; then
  echo "the drill database must not be the production database" >&2
  exit 1
fi

psql_in() {
  local database="$1"; shift
  docker exec "$DB_CONTAINER" psql --username="$POSTGRES_USER" --dbname="$database" \
    --tuples-only --no-align --quiet "$@"
}

write_metrics() {
  local finished_at duration tmp
  finished_at="$(date +%s)"
  duration="$((finished_at - STARTED_AT))"
  mkdir -p "$(dirname "$METRICS_FILE")" || return 0
  tmp="$(mktemp "${METRICS_FILE}.tmp.XXXXXX")" || return 0
  {
    printf '# HELP cinetrack_restore_drill_success Whether the last restore drill restored a usable database.\n'
    printf '# TYPE cinetrack_restore_drill_success gauge\n'
    printf 'cinetrack_restore_drill_success %s\n' "$SUCCESS"
    printf '# HELP cinetrack_restore_drill_timestamp_seconds Start time of the last restore drill.\n'
    printf '# TYPE cinetrack_restore_drill_timestamp_seconds gauge\n'
    printf 'cinetrack_restore_drill_timestamp_seconds %s\n' "$STARTED_AT"
    printf '# HELP cinetrack_restore_drill_duration_seconds Duration of the last restore drill.\n'
    printf '# TYPE cinetrack_restore_drill_duration_seconds gauge\n'
    printf 'cinetrack_restore_drill_duration_seconds %s\n' "$duration"
    printf '# HELP cinetrack_restore_drill_tables Tables compared against production.\n'
    printf '# TYPE cinetrack_restore_drill_tables gauge\n'
    printf 'cinetrack_restore_drill_tables %s\n' "$TABLES_CHECKED"
    printf '# HELP cinetrack_restore_drill_rows Rows counted in the restored database.\n'
    printf '# TYPE cinetrack_restore_drill_rows gauge\n'
    printf 'cinetrack_restore_drill_rows %s\n' "$ROWS_RESTORED"
  } > "$tmp"
  if ! mv "$tmp" "$METRICS_FILE"; then
    rm -f "$tmp"
  fi
}

cleanup() {
  # The scratch database goes whatever happened. Leaving it behind is how a
  # drill turns into a second copy of production nobody remembers creating.
  docker exec "$DB_CONTAINER" dropdb --username="$POSTGRES_USER" --if-exists --force "$DRILL_DATABASE" \
    >/dev/null 2>&1 || true
  write_metrics
}
trap cleanup EXIT

fail() {
  echo "restore drill failed: $*" >&2
  exit 1
}

echo "restoring the latest backup into ${DRILL_DATABASE}"
ALLOW_EXISTING_RESTORE_TARGET=I_UNDERSTAND_THE_RISK \
  "$SCRIPT_DIR/restore_from_r2.sh" restore "$DRILL_DATABASE" latest \
  || fail "restore_from_r2.sh could not restore the latest archive"

# What follows is deliberately not "compare the restore against production".
#
# The first version did exactly that, and it failed on its first real run:
# three tables held rows in production and none in the restore. All three had
# gained their first row that morning, hours after the archive was taken. The
# archive was perfect and the check was wrong — it was comparing a point in
# time against a moving target, so any table that received its first row
# between the backup and the drill read as data loss.
#
# A drill that cries wolf is one nobody runs twice, so the assertions below are
# all race-free: each is true of a good archive no matter how much production
# has moved on since.

# 1. Migrations: every one applied cleanly, and none the archive should not have.
#    A backup can only be missing migrations applied after it, never carry extra
#    ones, so the restore's versions must be a subset of production's.
failed_migrations="$(psql_in "$DRILL_DATABASE" --command='SELECT COUNT(*) FROM _sqlx_migrations WHERE NOT success')"
[[ "$failed_migrations" == 0 ]] || fail "$failed_migrations migrations are marked unsuccessful in the restore"

prod_versions="$(psql_in "$POSTGRES_DB" --command='SELECT version FROM _sqlx_migrations ORDER BY version')"
drill_versions="$(psql_in "$DRILL_DATABASE" --command='SELECT version FROM _sqlx_migrations ORDER BY version')"
unexpected="$(comm -13 <(echo "$prod_versions") <(echo "$drill_versions") | tr '\n' ' ')"
[[ -z "${unexpected// /}" ]] || fail "the restore carries migrations production does not have: $unexpected"

drill_migrations="$(echo "$drill_versions" | grep -c . || true)"
(( drill_migrations > 0 )) || fail "the restore has no migration history at all"

# 2. The tables that carry this product. A schema-only archive restores
#    without error and looks like a database; an empty `users` is what tells
#    the difference. Named explicitly rather than discovered, because the list
#    has to mean "these must never be empty" — which is a claim about the
#    product, not about whatever production happens to hold today.
#
#    Seven tables rather than all forty, and that is not a weaker check than it
#    looks. `restore_from_r2.sh` restores with `--single-transaction
#    --exit-on-error`, so a restore is all or nothing: there is no state where
#    half the tables arrived. What is left to distinguish is a corrupt archive
#    (pg_restore fails), a schema-only one (these come back empty), the wrong
#    database (the tables are missing), and a bad migration history (checked
#    above) — and every one of those shows here.
CORE_TABLES=(users media seasons episodes user_media watch_history _sqlx_migrations)
TABLES_CHECKED=0
ROWS_RESTORED=0
empty=()
for table in "${CORE_TABLES[@]}"; do
  present="$(psql_in "$DRILL_DATABASE" --command="SELECT COUNT(*) FROM pg_tables WHERE schemaname='public' AND tablename='$table'")"
  [[ "$present" == 1 ]] || fail "core table $table is missing from the restore"
  rows="$(psql_in "$DRILL_DATABASE" --command="SELECT COUNT(*) FROM \"$table\"")"
  TABLES_CHECKED=$((TABLES_CHECKED + 1))
  ROWS_RESTORED=$((ROWS_RESTORED + rows))
  (( rows > 0 )) || empty+=("$table")
done
(( ${#empty[@]} == 0 )) || fail "core tables restored empty: ${empty[*]}"

# 3. Nothing the archive should have is absent. Compared the safe way round:
#    a table missing from the restore is only news if production has not added
#    one since, and a migration is what adds one — so this compares table
#    counts only when the migration histories agree.
prod_versions_count="$(echo "$prod_versions" | grep -c . || true)"
if [[ "$drill_migrations" == "$prod_versions_count" ]]; then
  prod_tables="$(psql_in "$POSTGRES_DB" --command="SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")"
  drill_tables="$(psql_in "$DRILL_DATABASE" --command="SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")"
  missing="$(comm -23 <(echo "$prod_tables") <(echo "$drill_tables") | tr '\n' ' ')"
  [[ -z "${missing// /}" ]] || fail "tables missing from the restore: $missing"
else
  echo "note: production is $((prod_versions_count - drill_migrations)) migration(s) ahead of this archive; skipping the table-list comparison"
fi

SUCCESS=1
echo "restore drill passed: ${drill_migrations} migrations, ${TABLES_CHECKED} core tables, ${ROWS_RESTORED} rows in them"
