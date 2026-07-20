#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
  echo "backup/restore test failed: $*" >&2
  exit 1
}

test_invalid_config_writes_failure_metric() {
  local state status
  state="$TMP_ROOT/invalid-state"
  mkdir -p "$state"
  set +e
  ENV_FILE=/dev/null BACKUP_STATE_DIR="$state" RETENTION_DAYS=0 \
    "$ROOT_DIR/scripts/backup_to_r2.sh" >"$state/output" 2>&1
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail "invalid retention was accepted"
  grep -q 'cinetrack_backup_last_run_success 0' "$state/backup.prom" \
    || fail "failure metric was not written"
}

install_backup_fakes() {
  local fake_bin="$1"
  mkdir -p "$fake_bin"
  cat >"$fake_bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *" pg_dump "* ]]; then
  printf 'PGDMP-fake-archive'
elif [[ "$*" == *" pg_restore --list"* ]]; then
  cat >/dev/null
else
  echo "unexpected docker invocation: $*" >&2
  exit 1
fi
SH
  cat >"$fake_bin/age" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
output=''
input=''
while (($#)); do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --recipient) shift 2 ;;
    --encrypt) shift ;;
    *) input="$1"; shift ;;
  esac
done
printf 'age-encryption.org/v1\n' >"$output"
cat "$input" >>"$output"
SH
  cat >"$fake_bin/python3" <<'SH'
#!/usr/bin/env bash
cat >/dev/null
SH
  chmod +x "$fake_bin/docker" "$fake_bin/age" "$fake_bin/python3"
}

test_encrypted_backup_uses_dedicated_credentials() {
  local fake_bin state
  fake_bin="$TMP_ROOT/backup-bin"
  state="$TMP_ROOT/success-state"
  install_backup_fakes "$fake_bin"
  mkdir -p "$state"

  PATH="$fake_bin:$PATH" ENV_FILE=/dev/null BACKUP_STATE_DIR="$state" \
    BACKUP_R2_S3_API=https://r2.invalid BACKUP_R2_ACCESS_KEY_ID=test \
    BACKUP_R2_SECRET_ACCESS_KEY=test BACKUP_R2_BUCKET=test-backups \
    BACKUP_AGE_RECIPIENT=age1test POSTGRES_USER=test POSTGRES_DB=cinetrack \
    REQUIRE_ENCRYPTED_BACKUPS=true REQUIRE_DEDICATED_BACKUP_CREDENTIALS=true \
    "$ROOT_DIR/scripts/backup_to_r2.sh" >"$state/output" 2>&1

  grep -q 'cinetrack_backup_last_run_success 1' "$state/backup.prom" \
    || fail "success metric was not written"
  grep -q 'cinetrack_backup_encrypted 1' "$state/backup.prom" \
    || fail "encrypted metric was not written"
  grep -q 'cinetrack_backup_dedicated_credentials 1' "$state/backup.prom" \
    || fail "dedicated credential metric was not written"
  [[ -s "$state/backup.last_success" ]] || fail "last-success timestamp is missing"
}

install_restore_fakes() {
  local fake_bin="$1"
  mkdir -p "$fake_bin"
  cat >"$fake_bin/python3" <<'SH'
#!/usr/bin/env bash
cat >/dev/null
printf 'PGDMP-fake-archive' >"$LOCAL"
printf '%s' "$SELECTOR" >"$KEY_FILE"
SH
  cat >"$fake_bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$DOCKER_LOG"
if [[ "$*" == *" pg_restore --list"* ]]; then
  cat >/dev/null
  exit 0
fi
echo "unexpected database access" >&2
exit 1
SH
  chmod +x "$fake_bin/python3" "$fake_bin/docker"
}

restore_environment() {
  local fake_bin="$1"
  shift
  PATH="$fake_bin:$PATH" ENV_FILE=/dev/null \
    BACKUP_R2_S3_API=https://r2.invalid BACKUP_R2_ACCESS_KEY_ID=test \
    BACKUP_R2_SECRET_ACCESS_KEY=test BACKUP_R2_BUCKET=test-backups \
    POSTGRES_USER=test POSTGRES_DB=cinetrack DOCKER_LOG="$TMP_ROOT/docker.log" \
    "$@"
}

test_restore_verification_and_production_guard() {
  local fake_bin status
  fake_bin="$TMP_ROOT/restore-bin"
  install_restore_fakes "$fake_bin"

  restore_environment "$fake_bin" "$ROOT_DIR/scripts/restore_from_r2.sh" \
    verify backups/cinetrack_test.dump >/dev/null

  : >"$TMP_ROOT/docker.log"
  set +e
  restore_environment "$fake_bin" "$ROOT_DIR/scripts/restore_from_r2.sh" \
    restore cinetrack backups/cinetrack_test.dump >"$TMP_ROOT/restore-output" 2>&1
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail "production restore was accepted without confirmation"
  grep -q 'refusing to restore over production' "$TMP_ROOT/restore-output" \
    || fail "production restore guard did not report its refusal"
  ! grep -q ' psql ' "$TMP_ROOT/docker.log" \
    || fail "restore guard ran a production SQL command"
}

test_invalid_config_writes_failure_metric
test_encrypted_backup_uses_dedicated_credentials
test_restore_verification_and_production_guard
echo "backup/restore safety tests passed"
