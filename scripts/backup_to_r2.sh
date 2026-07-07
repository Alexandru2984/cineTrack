#!/usr/bin/env bash
#
# Dump the production Postgres database and upload a compressed snapshot to
# Cloudflare R2, then prune snapshots older than the retention window.
#
# Reads R2 credentials from cineTrack/.env.prod (git-ignored) by default, or
# from the environment. Intended to run on the host that runs the prod stack.
#
# Cron (daily at 03:30):
#   30 3 * * * /home/micu/vazute/cineTrack/scripts/backup_to_r2.sh >> /var/log/vazute-backup.log 2>&1
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../.env.prod}"
DB_CONTAINER="${DB_CONTAINER:-cinetrack-db-1}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

# Load R2_* and POSTGRES_* from .env.prod without leaking them into the log.
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source <(grep -E '^(R2_|POSTGRES_)' "$ENV_FILE")
  set +a
fi

: "${R2_S3_API:?R2_S3_API not set}"
: "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID not set}"
: "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY not set}"
: "${R2_BUCKET:?R2_BUCKET not set}"
: "${POSTGRES_USER:?POSTGRES_USER not set}"
: "${POSTGRES_DB:?POSTGRES_DB not set}"

STAMP="$(date -u +%Y%m%d_%H%M%S)"
KEY="backups/${POSTGRES_DB}_${STAMP}.sql.gz"
TMP="$(mktemp --suffix=.sql.gz)"
trap 'rm -f "$TMP"' EXIT

echo "[$(date -u +%FT%TZ)] dumping ${POSTGRES_DB} from ${DB_CONTAINER}…"
docker exec "$DB_CONTAINER" pg_dump -U "$POSTGRES_USER" --no-owner --no-privileges "$POSTGRES_DB" \
  | gzip -9 > "$TMP"
SIZE="$(du -h "$TMP" | cut -f1)"
echo "  dump size: ${SIZE} -> r2://${R2_BUCKET}/${KEY}"

R2_S3_API="$R2_S3_API" R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" R2_BUCKET="$R2_BUCKET" \
KEY="$KEY" LOCAL="$TMP" RETENTION_DAYS="$RETENTION_DAYS" python3 - <<'PY'
import os, datetime, boto3
from botocore.config import Config
s3 = boto3.client("s3",
    endpoint_url=os.environ["R2_S3_API"],
    aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
    region_name="auto",
    config=Config(signature_version="s3v4", s3={"addressing_style": "path"}))
bucket = os.environ["R2_BUCKET"]
with open(os.environ["LOCAL"], "rb") as f:
    s3.put_object(Bucket=bucket, Key=os.environ["KEY"], Body=f,
                  ContentType="application/gzip")
print("  uploaded OK")

# Retention: delete backups/ objects older than RETENTION_DAYS.
cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=int(os.environ["RETENTION_DAYS"]))
deleted = 0
paginator = s3.get_paginator("list_objects_v2")
for page in paginator.paginate(Bucket=bucket, Prefix="backups/"):
    for obj in page.get("Contents", []):
        if obj["LastModified"] < cutoff:
            s3.delete_object(Bucket=bucket, Key=obj["Key"])
            deleted += 1
print(f"  pruned {deleted} snapshot(s) older than {os.environ['RETENTION_DAYS']} days")
PY

echo "[$(date -u +%FT%TZ)] backup complete."
