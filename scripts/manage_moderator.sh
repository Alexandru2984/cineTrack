#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACTION="${1:-}"
USERNAME="${2:-}"
ENV_FILE="${3:-$ROOT_DIR/.env.prod}"
DB_CONTAINER="${DB_CONTAINER:-cinetrack-db-1}"

if [[ "$ACTION" != "grant" && "$ACTION" != "revoke" ]]; then
  echo "Usage: $0 grant|revoke <username> [env-file]" >&2
  exit 1
fi
if [[ ! "$USERNAME" =~ ^[A-Za-z0-9_.-]{3,50}$ ]]; then
  echo "Username has an invalid shape" >&2
  exit 1
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Environment file not found: $ENV_FILE" >&2
  exit 1
fi
if ! docker inspect "$DB_CONTAINER" >/dev/null 2>&1; then
  echo "Database container not found: $DB_CONTAINER" >&2
  exit 1
fi

operator="${SUDO_USER:-${USER:-operator}}"
if [[ ! "$operator" =~ ^[A-Za-z0-9_.-]{1,100}$ ]]; then
  operator="operator"
fi

if [[ "$ACTION" == "grant" ]]; then
  {
    printf "\\set target_username '%s'\n" "$USERNAME"
    printf "\\set grant_source '%s'\n" "$operator"
    cat <<'SQL'
SELECT id AS user_id
FROM users
WHERE LOWER(username) = LOWER(:'target_username')
  AND email_verified
  AND totp_enabled
\gset target_

\if :{?target_user_id}
INSERT INTO moderators (user_id, granted_by)
VALUES (:'target_user_id', :'grant_source')
ON CONFLICT (user_id) DO UPDATE
SET granted_at = NOW(), granted_by = EXCLUDED.granted_by;
\else
\echo 'Moderator grant refused: account missing, email unverified, or 2FA disabled.'
\quit 1
\endif
SQL
  } | docker exec -i "$DB_CONTAINER" sh -c '
    exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"
  '
  echo "Moderator access granted to $USERNAME."
else
  {
    printf "\\set target_username '%s'\n" "$USERNAME"
    cat <<'SQL'
DELETE FROM moderators
WHERE user_id = (
    SELECT id FROM users WHERE LOWER(username) = LOWER(:'target_username')
);
SQL
  } | docker exec -i "$DB_CONTAINER" sh -c '
    exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"
  '
  echo "Moderator access revoked from $USERNAME."
fi
