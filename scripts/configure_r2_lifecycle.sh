#!/usr/bin/env bash
# Keep TMDB-derived poster cache inside the provider's maximum retention.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../.env.prod}"
POSTER_RETENTION_DAYS="${POSTER_RETENTION_DAYS:-175}"
EXPORT_RETENTION_DAYS="${EXPORT_RETENTION_DAYS:-90}"
DRY_RUN="${DRY_RUN:-0}"

if [[ ! "$POSTER_RETENTION_DAYS" =~ ^[0-9]+$ ]] \
    || (( POSTER_RETENTION_DAYS < 1 || POSTER_RETENTION_DAYS > 175 )); then
  echo "POSTER_RETENTION_DAYS must be between 1 and 175" >&2
  exit 1
fi
if [[ ! "$EXPORT_RETENTION_DAYS" =~ ^[0-9]+$ ]] \
    || (( EXPORT_RETENTION_DAYS < 1 || EXPORT_RETENTION_DAYS > 175 )); then
  echo "EXPORT_RETENTION_DAYS must be between 1 and 175" >&2
  exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source <(grep -E '^(R2_)' "$ENV_FILE")
  set +a
fi

: "${R2_S3_API:?R2_S3_API not set}"
: "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID not set}"
: "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY not set}"
: "${R2_BUCKET:?R2_BUCKET not set}"

R2_S3_API="$R2_S3_API" R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" R2_BUCKET="$R2_BUCKET" \
POSTER_RETENTION_DAYS="$POSTER_RETENTION_DAYS" \
EXPORT_RETENTION_DAYS="$EXPORT_RETENTION_DAYS" DRY_RUN="$DRY_RUN" python3 - <<'PY'
import os

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

rule_id = "CineTrack poster cache retention"
retention_days = int(os.environ["POSTER_RETENTION_DAYS"])
export_rule_id = "CineTrack catalog export retention"
export_retention_days = int(os.environ["EXPORT_RETENTION_DAYS"])
s3 = boto3.client(
    "s3",
    endpoint_url=os.environ["R2_S3_API"],
    aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
    region_name="auto",
    config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
)
bucket = os.environ["R2_BUCKET"]

try:
    current = s3.get_bucket_lifecycle_configuration(Bucket=bucket).get("Rules", [])
except ClientError as error:
    if error.response.get("Error", {}).get("Code") == "NoSuchLifecycleConfiguration":
        current = []
    else:
        raise

poster_rule = {
    "ID": rule_id,
    "Status": "Enabled",
    "Filter": {"Prefix": "posters/"},
    "Expiration": {"Days": retention_days},
}
export_rule = {
    "ID": export_rule_id,
    "Status": "Enabled",
    "Filter": {"Prefix": "catalog/exports/"},
    "Expiration": {"Days": export_retention_days},
}
managed_ids = {rule_id, export_rule_id}
rules = [existing for existing in current if existing.get("ID") not in managed_ids]
rules.extend([poster_rule, export_rule])

if os.environ["DRY_RUN"] == "1":
    print(f"dry-run: would configure {rule_id!r} at {retention_days} days")
    print(f"dry-run: would configure {export_rule_id!r} at {export_retention_days} days")
else:
    s3.put_bucket_lifecycle_configuration(
        Bucket=bucket,
        LifecycleConfiguration={"Rules": rules},
    )
    configured = s3.get_bucket_lifecycle_configuration(Bucket=bucket).get("Rules", [])
    configured_by_id = {candidate.get("ID"): candidate for candidate in configured}
    if configured_by_id.get(rule_id) != poster_rule:
        raise RuntimeError("R2 poster lifecycle verification failed")
    if configured_by_id.get(export_rule_id) != export_rule:
        raise RuntimeError("R2 catalog lifecycle verification failed")
    print(f"configured {rule_id!r} at {retention_days} days")
    print(f"configured {export_rule_id!r} at {export_retention_days} days")
    print(f"preserved {len(rules) - 2} other lifecycle rule(s)")
PY
