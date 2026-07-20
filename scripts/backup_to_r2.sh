#!/usr/bin/env bash
# Create a consistent PostgreSQL archive, optionally encrypt it with age, upload
# it to Cloudflare R2, verify the remote object, and apply retention.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../.env.prod}"

# Only import the variables used by this script. Values are never printed.
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source <(grep -E '^(BACKUP_|R2_|POSTGRES_|REQUIRE_(ENCRYPTED_BACKUPS|DEDICATED_BACKUP_CREDENTIALS))' "$ENV_FILE" || true)
  set +a
fi

DB_CONTAINER="${DB_CONTAINER:-cinetrack-db-1}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
BACKUP_PREFIX="${BACKUP_PREFIX:-backups/}"
STATE_DIR="${BACKUP_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/cinetrack}"
LOCK_FILE="${LOCK_FILE:-$STATE_DIR/backup.lock}"
METRICS_FILE="${BACKUP_METRICS_FILE:-$STATE_DIR/backup.prom}"
REQUIRE_ENCRYPTION="${REQUIRE_ENCRYPTED_BACKUPS:-false}"
REQUIRE_DEDICATED_CREDENTIALS="${REQUIRE_DEDICATED_BACKUP_CREDENTIALS:-false}"

umask 077
mkdir -p "$STATE_DIR"

# A stable user-owned state directory also works from cron when /run/user/$UID
# does not exist. A concurrent invocation leaves the running backup untouched.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[$(date -u +%FT%TZ)] another backup is already running; skipping."
  exit 0
fi

STARTED_AT="$(date +%s)"
LAST_SUCCESS_FILE="$STATE_DIR/backup.last_success"
SUCCESS=0
SIZE_BYTES=0
ENCRYPTED=0
DEDICATED_CREDENTIALS=0
TMP_DIR=""

write_metrics() {
  local finished_at last_success duration tmp
  finished_at="$(date +%s)"
  duration="$((finished_at - STARTED_AT))"
  last_success=0
  if [[ -r "$LAST_SUCCESS_FILE" ]]; then
    read -r last_success < "$LAST_SUCCESS_FILE" || last_success=0
  fi
  [[ "$last_success" =~ ^[0-9]+$ ]] || last_success=0

  mkdir -p "$(dirname "$METRICS_FILE")" || return 1
  tmp="$(mktemp "${METRICS_FILE}.tmp.XXXXXX")" || return 1
  {
    printf '# HELP cinetrack_backup_last_run_success Whether the last completed backup run succeeded.\n'
    printf '# TYPE cinetrack_backup_last_run_success gauge\n'
    printf 'cinetrack_backup_last_run_success %s\n' "$SUCCESS"
    printf '# HELP cinetrack_backup_last_run_timestamp_seconds Start time of the last backup run.\n'
    printf '# TYPE cinetrack_backup_last_run_timestamp_seconds gauge\n'
    printf 'cinetrack_backup_last_run_timestamp_seconds %s\n' "$STARTED_AT"
    printf '# HELP cinetrack_backup_last_success_timestamp_seconds Completion time of the last successful backup.\n'
    printf '# TYPE cinetrack_backup_last_success_timestamp_seconds gauge\n'
    printf 'cinetrack_backup_last_success_timestamp_seconds %s\n' "$last_success"
    printf '# HELP cinetrack_backup_duration_seconds Duration of the last backup run.\n'
    printf '# TYPE cinetrack_backup_duration_seconds gauge\n'
    printf 'cinetrack_backup_duration_seconds %s\n' "$duration"
    printf '# HELP cinetrack_backup_size_bytes Size of the last uploaded archive.\n'
    printf '# TYPE cinetrack_backup_size_bytes gauge\n'
    printf 'cinetrack_backup_size_bytes %s\n' "$SIZE_BYTES"
    printf '# HELP cinetrack_backup_encrypted Whether the last archive was encrypted before upload.\n'
    printf '# TYPE cinetrack_backup_encrypted gauge\n'
    printf 'cinetrack_backup_encrypted %s\n' "$ENCRYPTED"
    printf '# HELP cinetrack_backup_dedicated_credentials Whether dedicated R2 credentials were used.\n'
    printf '# TYPE cinetrack_backup_dedicated_credentials gauge\n'
    printf 'cinetrack_backup_dedicated_credentials %s\n' "$DEDICATED_CREDENTIALS"
  } > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$METRICS_FILE"
}

finish() {
  local status=$?
  trap - EXIT
  [[ -z "$TMP_DIR" ]] || rm -rf "$TMP_DIR"
  if (( status != 0 )); then
    echo "[$(date -u +%FT%TZ)] backup failed with exit code ${status}." >&2
  fi
  if ! write_metrics; then
    echo "[$(date -u +%FT%TZ)] warning: could not write backup metrics to ${METRICS_FILE}." >&2
  fi
  exit "$status"
}
trap finish EXIT

case "$REQUIRE_ENCRYPTION" in true|false) ;; *) echo "REQUIRE_ENCRYPTED_BACKUPS must be true or false" >&2; exit 1 ;; esac
case "$REQUIRE_DEDICATED_CREDENTIALS" in true|false) ;; *) echo "REQUIRE_DEDICATED_BACKUP_CREDENTIALS must be true or false" >&2; exit 1 ;; esac
if [[ ! "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || (( RETENTION_DAYS < 1 || RETENTION_DAYS > 3650 )); then
  echo "RETENTION_DAYS must be between 1 and 3650" >&2
  exit 1
fi
if [[ ! "$BACKUP_PREFIX" =~ ^[A-Za-z0-9._/-]+/$ ]] || [[ "$BACKUP_PREFIX" == /* || "$BACKUP_PREFIX" == *..* ]]; then
  echo "BACKUP_PREFIX must be a relative R2 prefix ending in /" >&2
  exit 1
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
  DEDICATED_CREDENTIALS=1
else
  : "${R2_S3_API:?R2_S3_API not set}"
  : "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID not set}"
  : "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY not set}"
  : "${R2_BUCKET:?R2_BUCKET not set}"
  ENDPOINT="$R2_S3_API"
  ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
  SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
  BUCKET="$R2_BUCKET"
  echo "[$(date -u +%FT%TZ)] warning: using shared R2 application credentials for backup." >&2
fi
if [[ "$REQUIRE_DEDICATED_CREDENTIALS" == true && "$DEDICATED_CREDENTIALS" != 1 ]]; then
  echo "dedicated backup credentials are required" >&2
  exit 1
fi

: "${POSTGRES_USER:?POSTGRES_USER not set}"
: "${POSTGRES_DB:?POSTGRES_DB not set}"
if [[ ! "$POSTGRES_DB" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]]; then
  echo "POSTGRES_DB contains unsupported characters" >&2
  exit 1
fi
command -v docker >/dev/null
command -v python3 >/dev/null

STAMP="$(date -u +%Y%m%d_%H%M%S)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cinetrack-backup.XXXXXX")"
DUMP_FILE="$TMP_DIR/${POSTGRES_DB}_${STAMP}.dump"
UPLOAD_FILE="$DUMP_FILE"
KEY="${BACKUP_PREFIX}${POSTGRES_DB}_${STAMP}.dump"
CONTENT_TYPE="application/vnd.postgresql.custom"

echo "[$(date -u +%FT%TZ)] creating a consistent custom-format dump of ${POSTGRES_DB}."
docker exec "$DB_CONTAINER" pg_dump \
  --username="$POSTGRES_USER" \
  --dbname="$POSTGRES_DB" \
  --format=custom \
  --compress=9 \
  --serializable-deferrable \
  --no-owner \
  --no-privileges > "$DUMP_FILE"
test -s "$DUMP_FILE"
docker exec -i "$DB_CONTAINER" pg_restore --list < "$DUMP_FILE" >/dev/null

if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  command -v age >/dev/null
  UPLOAD_FILE="${DUMP_FILE}.age"
  age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$UPLOAD_FILE" "$DUMP_FILE"
  test -s "$UPLOAD_FILE"
  head -n 1 "$UPLOAD_FILE" | grep -qx 'age-encryption.org/v1'
  rm -f "$DUMP_FILE"
  KEY="${KEY}.age"
  CONTENT_TYPE="application/vnd.age"
  ENCRYPTED=1
else
  echo "[$(date -u +%FT%TZ)] warning: BACKUP_AGE_RECIPIENT is unset; archive is not encrypted." >&2
  if [[ "$REQUIRE_ENCRYPTION" == true ]]; then
    echo "encrypted backups are required" >&2
    exit 1
  fi
fi

SIZE_BYTES="$(stat -c %s "$UPLOAD_FILE")"
echo "[$(date -u +%FT%TZ)] uploading ${SIZE_BYTES} bytes to r2://${BUCKET}/${KEY}."

R2_S3_API="$ENDPOINT" R2_ACCESS_KEY_ID="$ACCESS_KEY_ID" \
R2_SECRET_ACCESS_KEY="$SECRET_ACCESS_KEY" R2_BUCKET="$BUCKET" \
KEY="$KEY" LOCAL="$UPLOAD_FILE" RETENTION_DAYS="$RETENTION_DAYS" \
BACKUP_PREFIX="$BACKUP_PREFIX" CONTENT_TYPE="$CONTENT_TYPE" \
ENCRYPTED="$ENCRYPTED" DATABASE="$POSTGRES_DB" python3 - <<'PY'
import datetime
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
key = os.environ["KEY"]
local_path = os.environ["LOCAL"]
local_size = os.path.getsize(local_path)
with open(local_path, "rb") as source:
    digest = hashlib.file_digest(source, "sha256").hexdigest()
    source.seek(0)
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=source,
        ContentType=os.environ["CONTENT_TYPE"],
        Metadata={
            "sha256": digest,
            "database": os.environ["DATABASE"],
            "format": "postgres-custom-v1",
            "encrypted": os.environ["ENCRYPTED"],
        },
    )

head = s3.head_object(Bucket=bucket, Key=key)
metadata = head.get("Metadata", {})
if head["ContentLength"] != local_size or metadata.get("sha256") != digest:
    raise RuntimeError("uploaded backup failed size/hash verification")
if metadata.get("format") != "postgres-custom-v1":
    raise RuntimeError("uploaded backup metadata verification failed")
print(f"  upload verified (sha256={digest[:12]}...)")

cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(
    days=int(os.environ["RETENTION_DAYS"])
)
deleted = 0
paginator = s3.get_paginator("list_objects_v2")
for page in paginator.paginate(Bucket=bucket, Prefix=os.environ["BACKUP_PREFIX"]):
    for item in page.get("Contents", []):
        if item["LastModified"] < cutoff:
            s3.delete_object(Bucket=bucket, Key=item["Key"])
            deleted += 1
print(f"  pruned {deleted} expired backup object(s)")
PY

SUCCESS=1
printf '%s\n' "$(date +%s)" > "$LAST_SUCCESS_FILE"
echo "[$(date -u +%FT%TZ)] backup complete."
