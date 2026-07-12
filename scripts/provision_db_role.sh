#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-$ROOT_DIR/.env.prod}"
DB_CONTAINER="${DB_CONTAINER:-cinetrack-db-1}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Environment file not found: $ENV_FILE" >&2
  exit 1
fi

read_env_value() {
  local key="$1"
  awk -v key="$key" '
    index($0, key "=") == 1 { value = substr($0, length(key) + 2) }
    END { print value }
  ' "$ENV_FILE"
}

APP_ROLE="${APP_DATABASE_USER:-$(read_env_value APP_DATABASE_USER)}"
APP_ROLE="${APP_ROLE:-cinetrack_app}"
APP_PASSWORD="${APP_DATABASE_PASSWORD:-$(read_env_value APP_DATABASE_PASSWORD)}"

if [[ ! "$APP_ROLE" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; then
  echo "APP_DATABASE_USER must be a simple PostgreSQL role name" >&2
  exit 1
fi

if [[ -z "$APP_PASSWORD" ]]; then
  APP_PASSWORD="$(openssl rand -hex 32)"
fi
if [[ ! "$APP_PASSWORD" =~ ^[A-Za-z0-9._~-]{32,128}$ ]]; then
  echo "APP_DATABASE_PASSWORD must be 32-128 URL-safe characters" >&2
  exit 1
fi

# Keep exactly one copy of each runtime credential and never print the secret.
umask 077
tmp_env="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"
trap 'rm -f "$tmp_env"' EXIT
awk '!/^APP_DATABASE_USER=/ && !/^APP_DATABASE_PASSWORD=/' "$ENV_FILE" > "$tmp_env"
printf '\nAPP_DATABASE_USER=%s\nAPP_DATABASE_PASSWORD=%s\n' \
  "$APP_ROLE" "$APP_PASSWORD" >> "$tmp_env"
chmod 600 "$tmp_env"
mv "$tmp_env" "$ENV_FILE"
trap - EXIT

if ! docker inspect "$DB_CONTAINER" >/dev/null 2>&1; then
  echo "Database container not found: $DB_CONTAINER" >&2
  exit 1
fi

{
  printf "\\set app_role '%s'\n" "$APP_ROLE"
  printf "\\set app_password '%s'\n" "$APP_PASSWORD"
  cat <<'SQL'
SELECT format(
    'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20',
    :'app_role', :'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role')
\gexec

SELECT format(
    'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20',
    :'app_role', :'app_password'
)
\gexec

SELECT format('REVOKE %I FROM %I', parent.rolname, :'app_role')
FROM pg_auth_members membership
JOIN pg_roles parent ON parent.oid = membership.roleid
JOIN pg_roles member ON member.oid = membership.member
WHERE member.rolname = :'app_role'
\gexec

-- Transfer only user-space objects in this database. REASSIGN OWNED is not used:
-- the bootstrap administrator can own cluster-required/shared objects that must
-- never move to the application role.
SELECT format(
    'ALTER %s %I.%I OWNER TO %I',
    CASE relation.relkind
        WHEN 'S' THEN 'SEQUENCE'
        WHEN 'v' THEN 'VIEW'
        WHEN 'm' THEN 'MATERIALIZED VIEW'
        WHEN 'f' THEN 'FOREIGN TABLE'
        ELSE 'TABLE'
    END,
    namespace.nspname,
    relation.relname,
    :'app_role'
)
FROM pg_class relation
JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
  AND namespace.nspname !~ '^pg_toast'
  AND relation.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
  AND pg_get_userbyid(relation.relowner) = CURRENT_USER
\gexec

SELECT format(
    'ALTER %s %I.%I(%s) OWNER TO %I',
    CASE routine.prokind
        WHEN 'p' THEN 'PROCEDURE'
        WHEN 'a' THEN 'AGGREGATE'
        ELSE 'FUNCTION'
    END,
    namespace.nspname,
    routine.proname,
    pg_get_function_identity_arguments(routine.oid),
    :'app_role'
)
FROM pg_proc routine
JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
  AND namespace.nspname !~ '^pg_toast'
  AND pg_get_userbyid(routine.proowner) = CURRENT_USER
\gexec

SELECT format('ALTER DATABASE %I OWNER TO %I', CURRENT_DATABASE(), :'app_role')
\gexec
SELECT format('ALTER SCHEMA public OWNER TO %I', :'app_role')
\gexec
SQL
} | docker exec -i "$DB_CONTAINER" sh -c '
  exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"
'

restricted="$(docker exec "$DB_CONTAINER" sh -c '
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
    SELECT NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid)
    FROM pg_roles r WHERE r.rolname = '\''$1'\''
  "
' sh "$APP_ROLE")"

if [[ "$restricted" != "t" ]]; then
  echo "Runtime role privilege verification failed" >&2
  exit 1
fi

echo "Restricted database runtime role provisioned: $APP_ROLE"
