#!/usr/bin/env bash
# Download and validate a CineTrack R2 backup. Restoring data requires an
# explicit mode and target database; production is protected by a second guard.
set -Eeuo pipefail

usage() {
  echo "Usage:" >&2
  echo "  $0 verify [latest|R2_KEY]" >&2
  echo "  $0 restore TARGET_DATABASE [latest|R2_KEY]" >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
MODE="$1"
shift
TARGET_DATABASE=""
case "$MODE" in
  verify)
    (( $# <= 1 )) || usage
    OBJECT_SELECTOR="${1:-latest}"
    ;;
  restore)
    (( $# >= 1 && $# <= 2 )) || usage
    TARGET_DATABASE="$1"
    OBJECT_SELECTOR="${2:-latest}"
    ;;
  *) usage ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../.env.prod}"
DB_CONTAINER="${DB_CONTAINER:-cinetrack-db-1}"
BACKUP_PREFIX="${BACKUP_PREFIX:-backups/}"
TMP_DIR=""
CREATED_DATABASE=0

cleanup() {
  local status=$?
  trap - EXIT
  if (( status != 0 && CREATED_DATABASE == 1 )); then
    echo "restore failed; removing newly created database ${TARGET_DATABASE}." >&2
    docker exec "$DB_CONTAINER" dropdb --username="$POSTGRES_USER" --if-exists --force "$TARGET_DATABASE" || true
  fi
  [[ -z "$TMP_DIR" ]] || rm -rf "$TMP_DIR"
  exit "$status"
}
trap cleanup EXIT

umask 077
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source <(grep -E '^(BACKUP_|R2_|POSTGRES_)' "$ENV_FILE" || true)
  set +a
fi

dedicated_count=0
for variable in BACKUP_R2_S3_API BACKUP_R2_ACCESS_KEY_ID BACKUP_R2_SECRET_ACCESS_KEY BACKUP_R2_BUCKET; do
  [[ -z "${!variable:-}" ]] || dedicated_count=$((dedicated_count + 1))
done
if (( dedicated_count != 0 && dedicated_count != 4 )); then
  echo "set all BACKUP_R2_* variables or none of them" >&2
  exit 1
fi
if (( dedicated_count == 4 )); then
  ENDPOINT="$BACKUP_R2_S3_API"
  ACCESS_KEY_ID="$BACKUP_R2_ACCESS_KEY_ID"
  SECRET_ACCESS_KEY="$BACKUP_R2_SECRET_ACCESS_KEY"
  BUCKET="$BACKUP_R2_BUCKET"
else
  : "${R2_S3_API:?R2_S3_API not set}"
  : "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID not set}"
  : "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY not set}"
  : "${R2_BUCKET:?R2_BUCKET not set}"
  ENDPOINT="$R2_S3_API"
  ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
  SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
  BUCKET="$R2_BUCKET"
fi
: "${POSTGRES_USER:?POSTGRES_USER not set}"
: "${POSTGRES_DB:?POSTGRES_DB not set}"
if [[ ! "$BACKUP_PREFIX" =~ ^[A-Za-z0-9._/-]+/$ ]] || [[ "$BACKUP_PREFIX" == /* || "$BACKUP_PREFIX" == *..* ]]; then
  echo "BACKUP_PREFIX must be a relative R2 prefix ending in /" >&2
  exit 1
fi
if [[ "$OBJECT_SELECTOR" != latest && ( "$OBJECT_SELECTOR" != "$BACKUP_PREFIX"* || "$OBJECT_SELECTOR" == *..* ) ]]; then
  echo "the requested object must be inside ${BACKUP_PREFIX}" >&2
  exit 1
fi
command -v docker >/dev/null
command -v python3 >/dev/null

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cinetrack-restore.XXXXXX")"
DOWNLOAD_FILE="$TMP_DIR/archive"
KEY_FILE="$TMP_DIR/key"

R2_S3_API="$ENDPOINT" R2_ACCESS_KEY_ID="$ACCESS_KEY_ID" \
R2_SECRET_ACCESS_KEY="$SECRET_ACCESS_KEY" R2_BUCKET="$BUCKET" \
BACKUP_PREFIX="$BACKUP_PREFIX" SELECTOR="$OBJECT_SELECTOR" \
LOCAL="$DOWNLOAD_FILE" KEY_FILE="$KEY_FILE" python3 - <<'PY'
import hashlib
import os

import boto3
from botocore.config import Config

s3 = boto3.client(
    "s3",
    endpoint_url=os.environ["R2_S3_API"],
    aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
    region_name="auto",
    config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
)
bucket = os.environ["R2_BUCKET"]
selector = os.environ["SELECTOR"]
if selector == "latest":
    candidates = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=os.environ["BACKUP_PREFIX"]):
        candidates.extend(
            item
            for item in page.get("Contents", [])
            if item["Key"].endswith((".dump", ".dump.age"))
        )
    if not candidates:
        raise RuntimeError("no custom-format backup found")
    key = max(candidates, key=lambda item: item["LastModified"])["Key"]
else:
    key = selector

head = s3.head_object(Bucket=bucket, Key=key)
expected_digest = head.get("Metadata", {}).get("sha256")
if not expected_digest:
    raise RuntimeError("backup has no sha256 metadata")
s3.download_file(bucket, key, os.environ["LOCAL"])
if os.path.getsize(os.environ["LOCAL"]) != head["ContentLength"]:
    raise RuntimeError("downloaded backup size does not match R2 metadata")
with open(os.environ["LOCAL"], "rb") as source:
    digest = hashlib.file_digest(source, "sha256").hexdigest()
if digest != expected_digest:
    raise RuntimeError("downloaded backup hash does not match R2 metadata")
with open(os.environ["KEY_FILE"], "w", encoding="utf-8") as destination:
    destination.write(key)
print(f"downloaded and verified {key} (sha256={digest[:12]}...)")
PY

OBJECT_KEY="$(<"$KEY_FILE")"
DUMP_FILE="$DOWNLOAD_FILE"
if [[ "$OBJECT_KEY" == *.age ]]; then
  : "${BACKUP_AGE_IDENTITY_FILE:?BACKUP_AGE_IDENTITY_FILE is required for encrypted backups}"
  if [[ ! -f "$BACKUP_AGE_IDENTITY_FILE" ]]; then
    echo "age identity file does not exist" >&2
    exit 1
  fi
  case "$(stat -c %a "$BACKUP_AGE_IDENTITY_FILE")" in
    400|600) ;;
    *) echo "BACKUP_AGE_IDENTITY_FILE must have mode 400 or 600" >&2; exit 1 ;;
  esac
  command -v age >/dev/null
  DUMP_FILE="$TMP_DIR/database.dump"
  age --decrypt --identity "$BACKUP_AGE_IDENTITY_FILE" --output "$DUMP_FILE" "$DOWNLOAD_FILE"
elif [[ "$OBJECT_KEY" != *.dump ]]; then
  echo "unsupported backup format: ${OBJECT_KEY}" >&2
  exit 1
fi

test -s "$DUMP_FILE"
docker exec -i "$DB_CONTAINER" pg_restore --list < "$DUMP_FILE" >/dev/null
echo "validated PostgreSQL custom archive ${OBJECT_KEY}."

if [[ "$MODE" == verify ]]; then
  exit 0
fi
if [[ ! "$TARGET_DATABASE" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]]; then
  echo "TARGET_DATABASE contains unsupported characters" >&2
  exit 1
fi
if [[ "$TARGET_DATABASE" == "$POSTGRES_DB" && "${ALLOW_PRODUCTION_RESTORE:-}" != I_UNDERSTAND_THE_RISK ]]; then
  echo "refusing to restore over production without ALLOW_PRODUCTION_RESTORE=I_UNDERSTAND_THE_RISK" >&2
  exit 1
fi

database_exists="$(docker exec "$DB_CONTAINER" psql --username="$POSTGRES_USER" --dbname=postgres --tuples-only --no-align \
  --command="SELECT 1 FROM pg_database WHERE datname = '${TARGET_DATABASE}'")"
restore_options=(--username="$POSTGRES_USER" --dbname="$TARGET_DATABASE" --no-owner --no-privileges --exit-on-error --single-transaction)
if [[ "$database_exists" == 1 ]]; then
  if [[ "${ALLOW_EXISTING_RESTORE_TARGET:-}" != I_UNDERSTAND_THE_RISK ]]; then
    echo "target database exists; set ALLOW_EXISTING_RESTORE_TARGET=I_UNDERSTAND_THE_RISK to replace its objects" >&2
    exit 1
  fi
  restore_options+=(--clean --if-exists)
else
  docker exec "$DB_CONTAINER" createdb --username="$POSTGRES_USER" "$TARGET_DATABASE"
  CREATED_DATABASE=1
fi

docker exec -i "$DB_CONTAINER" pg_restore "${restore_options[@]}" < "$DUMP_FILE"
docker exec "$DB_CONTAINER" psql --username="$POSTGRES_USER" --dbname="$TARGET_DATABASE" \
  --tuples-only --no-align --command='SELECT COUNT(*) FROM _sqlx_migrations' >/dev/null
CREATED_DATABASE=0
echo "restore completed and migration metadata verified in ${TARGET_DATABASE}."
