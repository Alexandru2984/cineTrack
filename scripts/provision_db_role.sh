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

validate_role() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; then
    echo "$name must be a simple PostgreSQL role name" >&2
    exit 1
  fi
}

validate_password() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[A-Za-z0-9._~-]{32,128}$ ]]; then
    echo "$name must be 32-128 URL-safe characters" >&2
    exit 1
  fi
}

validate_database() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[A-Za-z_][A-Za-z0-9._~-]{0,62}$ ]]; then
    echo "$name must be a URL-safe PostgreSQL database name" >&2
    exit 1
  fi
}

APP_ROLE="${APP_DATABASE_USER:-$(read_env_value APP_DATABASE_USER)}"
APP_ROLE="${APP_ROLE:-cinetrack_app}"
APP_PASSWORD="${APP_DATABASE_PASSWORD:-$(read_env_value APP_DATABASE_PASSWORD)}"
MIGRATION_ROLE="${MIGRATION_DATABASE_USER:-$(read_env_value MIGRATION_DATABASE_USER)}"
MIGRATION_ROLE="${MIGRATION_ROLE:-cinetrack_migrator}"
MIGRATION_PASSWORD="${MIGRATION_DATABASE_PASSWORD:-$(read_env_value MIGRATION_DATABASE_PASSWORD)}"
DATABASE_NAME="${POSTGRES_DB:-$(read_env_value POSTGRES_DB)}"

validate_role "APP_DATABASE_USER" "$APP_ROLE"
validate_role "MIGRATION_DATABASE_USER" "$MIGRATION_ROLE"
validate_database "POSTGRES_DB" "$DATABASE_NAME"
if [[ "$APP_ROLE" == "$MIGRATION_ROLE" ]]; then
  echo "Runtime and migration roles must be different" >&2
  exit 1
fi

APP_PASSWORD="${APP_PASSWORD:-$(openssl rand -hex 32)}"
MIGRATION_PASSWORD="${MIGRATION_PASSWORD:-$(openssl rand -hex 32)}"
validate_password "APP_DATABASE_PASSWORD" "$APP_PASSWORD"
validate_password "MIGRATION_DATABASE_PASSWORD" "$MIGRATION_PASSWORD"
DATABASE_SCHEME="postgresql"
DATABASE_ENDPOINT="db:5432"
printf -v APP_DATABASE_URL '%s://%s:%s@%s/%s' \
  "$DATABASE_SCHEME" "$APP_ROLE" "$APP_PASSWORD" "$DATABASE_ENDPOINT" "$DATABASE_NAME"
printf -v MIGRATION_DATABASE_URL '%s://%s:%s@%s/%s' \
  "$DATABASE_SCHEME" "$MIGRATION_ROLE" "$MIGRATION_PASSWORD" "$DATABASE_ENDPOINT" "$DATABASE_NAME"

# Keep exactly one copy of each credential and connection string. Never print them.
umask 077
tmp_env="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"
trap 'rm -f "$tmp_env"' EXIT
awk '
  !/^APP_DATABASE_USER=/ &&
  !/^APP_DATABASE_PASSWORD=/ &&
  !/^APP_DATABASE_URL=/ &&
  !/^MIGRATION_DATABASE_USER=/ &&
  !/^MIGRATION_DATABASE_PASSWORD=/ &&
  !/^MIGRATION_DATABASE_URL=/
' "$ENV_FILE" > "$tmp_env"
{
  printf '\nAPP_DATABASE_USER=%s\nAPP_DATABASE_PASSWORD=%s\n' \
    "$APP_ROLE" "$APP_PASSWORD"
  printf 'APP_DATABASE_URL=%s\n' "$APP_DATABASE_URL"
  printf 'MIGRATION_DATABASE_USER=%s\nMIGRATION_DATABASE_PASSWORD=%s\n' \
    "$MIGRATION_ROLE" "$MIGRATION_PASSWORD"
  printf 'MIGRATION_DATABASE_URL=%s\n' "$MIGRATION_DATABASE_URL"
} >> "$tmp_env"
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
  printf "\\set migration_role '%s'\n" "$MIGRATION_ROLE"
  printf "\\set migration_password '%s'\n" "$MIGRATION_PASSWORD"
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

SELECT format(
    'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5',
    :'migration_role', :'migration_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'migration_role')
\gexec

SELECT format(
    'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5',
    :'migration_role', :'migration_password'
)
\gexec

SELECT format('REVOKE %I FROM %I', parent.rolname, member.rolname)
FROM pg_auth_members membership
JOIN pg_roles parent ON parent.oid = membership.roleid
JOIN pg_roles member ON member.oid = membership.member
WHERE member.rolname IN (:'app_role', :'migration_role')
\gexec

BEGIN;

-- The migration role owns only this application's database objects. Extension
-- members remain owned by the bootstrap administrator.
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
    :'migration_role'
)
FROM pg_class relation
JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = 'public'
  AND relation.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
  AND pg_get_userbyid(relation.relowner) <> :'migration_role'
  AND NOT EXISTS (
      SELECT 1
      FROM pg_depend dependency
      WHERE dependency.classid = 'pg_class'::regclass
        AND dependency.objid = relation.oid
        AND dependency.deptype = 'e'
  )
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
    :'migration_role'
)
FROM pg_proc routine
JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
WHERE namespace.nspname = 'public'
  AND pg_get_userbyid(routine.proowner) <> :'migration_role'
  AND NOT EXISTS (
      SELECT 1
      FROM pg_depend dependency
      WHERE dependency.classid = 'pg_proc'::regclass
        AND dependency.objid = routine.oid
        AND dependency.deptype = 'e'
  )
\gexec

SELECT format('ALTER DATABASE %I OWNER TO %I', CURRENT_DATABASE(), :'migration_role')
\gexec
SELECT format('ALTER SCHEMA public OWNER TO %I', :'migration_role')
\gexec

SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC', CURRENT_DATABASE())
\gexec
SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I', CURRENT_DATABASE(), :'app_role')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', CURRENT_DATABASE(), :'app_role')
\gexec

REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC;
SELECT format('REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I', :'app_role')
\gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_role')
\gexec

SELECT format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', :'app_role')
\gexec
SELECT format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I',
    :'app_role'
)
\gexec

SELECT format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I', :'app_role')
\gexec
SELECT format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', :'app_role')
\gexec

SELECT format(
    'REVOKE ALL PRIVILEGES ON %s %I.%I(%s) FROM PUBLIC, %I',
    CASE routine.prokind
        WHEN 'p' THEN 'PROCEDURE'
        ELSE 'FUNCTION'
    END,
    namespace.nspname,
    routine.proname,
    pg_get_function_identity_arguments(routine.oid),
    :'app_role'
)
FROM pg_proc routine
JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
WHERE namespace.nspname = 'public'
  AND NOT EXISTS (
      SELECT 1
      FROM pg_depend dependency
      WHERE dependency.classid = 'pg_proc'::regclass
        AND dependency.objid = routine.oid
        AND dependency.deptype = 'e'
  )
\gexec

SELECT format(
    'GRANT EXECUTE ON %s %I.%I(%s) TO %I',
    CASE routine.prokind
        WHEN 'p' THEN 'PROCEDURE'
        ELSE 'FUNCTION'
    END,
    namespace.nspname,
    routine.proname,
    pg_get_function_identity_arguments(routine.oid),
    :'app_role'
)
FROM pg_proc routine
JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
WHERE namespace.nspname = 'public'
  AND NOT EXISTS (
      SELECT 1
      FROM pg_depend dependency
      WHERE dependency.classid = 'pg_proc'::regclass
        AND dependency.objid = routine.oid
        AND dependency.deptype = 'e'
  )
\gexec

-- Runtime may inspect migration state, but it must never forge it.
SELECT format(
    'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public._sqlx_migrations FROM %I',
    :'app_role'
)
WHERE to_regclass('public._sqlx_migrations') IS NOT NULL
\gexec
SELECT format('GRANT SELECT ON TABLE public._sqlx_migrations TO %I', :'app_role')
WHERE to_regclass('public._sqlx_migrations') IS NOT NULL
\gexec

SELECT format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC',
    :'migration_role'
)
\gexec
SELECT format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
    :'migration_role', :'app_role'
)
\gexec
SELECT format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC',
    :'migration_role'
)
\gexec
SELECT format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I',
    :'migration_role', :'app_role'
)
\gexec
SELECT format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    :'migration_role'
)
\gexec
SELECT format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO %I',
    :'migration_role', :'app_role'
)
\gexec

COMMIT;
SQL
} | docker exec -i "$DB_CONTAINER" sh -c '
  exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"
'

verification="$(
  {
    printf "\\set app_role '%s'\n" "$APP_ROLE"
    printf "\\set migration_role '%s'\n" "$MIGRATION_ROLE"
    cat <<'SQL'
SELECT
  'runtime',
  NOT (
    role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
    OR role.rolreplication OR role.rolbypassrls
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_auth_members membership WHERE membership.member = role.oid
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_database database
    WHERE database.datname = CURRENT_DATABASE() AND database.datdba = role.oid
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_namespace namespace
    WHERE namespace.nspname = 'public' AND namespace.nspowner = role.oid
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relowner = role.oid
      AND relation.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
  )
  AND has_database_privilege(:'app_role', CURRENT_DATABASE(), 'CONNECT')
  AND NOT has_database_privilege(:'app_role', CURRENT_DATABASE(), 'CREATE')
  AND NOT has_database_privilege(:'app_role', CURRENT_DATABASE(), 'TEMP')
  AND has_schema_privilege(:'app_role', 'public', 'USAGE')
  AND NOT has_schema_privilege(:'app_role', 'public', 'CREATE')
  AND has_table_privilege(
    :'app_role',
    'public.users',
    'SELECT,INSERT,UPDATE,DELETE'
  )
  AND NOT has_table_privilege(
    :'app_role',
    'public.users',
    'TRUNCATE,REFERENCES,TRIGGER'
  )
FROM pg_roles role
WHERE role.rolname = :'app_role';

SELECT
  'migration',
  NOT (
    role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
    OR role.rolreplication OR role.rolbypassrls
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_auth_members membership WHERE membership.member = role.oid
  )
  AND EXISTS (
    SELECT 1 FROM pg_database database
    WHERE database.datname = CURRENT_DATABASE() AND database.datdba = role.oid
  )
FROM pg_roles role
WHERE role.rolname = :'migration_role';
SQL
  } | docker exec -i "$DB_CONTAINER" sh -c '
    exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F "|"
  '
)"

if ! grep -qx 'runtime|t' <<<"$verification" ||
  ! grep -qx 'migration|t' <<<"$verification"; then
  echo "Database role privilege verification failed" >&2
  exit 1
fi

echo "Restricted database roles provisioned: runtime=$APP_ROLE migration=$MIGRATION_ROLE"
