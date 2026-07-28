#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APK_PATH="${1:-$ROOT_DIR/android/app/build/outputs/apk/release/app-release.apk}"
MAESTRO_VERSION="2.7.0"
MAESTRO_SHA256="a4ccab6b604617e7aef6db4f885666056eabe5cfa32befaa3bc994041b8fcbb5"
MAESTRO_URL="https://github.com/mobile-dev-inc/Maestro/releases/download/cli-${MAESTRO_VERSION}/maestro.zip"
ARTIFACT_DIR="${MAESTRO_ARTIFACT_DIR:-$ROOT_DIR/artifacts/maestro}"
TEMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

for command_name in adb curl grep java node sha256sum sleep tee unzip; do
  command -v "$command_name" >/dev/null || {
    echo "${command_name} is required for the Android smoke test" >&2
    exit 1
  }
done

APP_ID="$(node -p 'require(process.argv[1]).expo.android.package' "$ROOT_DIR/app.json")"
EXPECTED_VERSION="$(node -p 'require(process.argv[1]).expo.version' "$ROOT_DIR/app.json")"

[[ -f "$APK_PATH" ]] || {
  echo "Android release APK not found: ${APK_PATH}" >&2
  exit 1
}

connected_devices="$(
  adb devices | awk 'NR > 1 && $2 == "device" { count += 1 } END { print count + 0 }'
)"
if [[ "$connected_devices" != 1 ]]; then
  echo "exactly one ready Android device or emulator is required" >&2
  exit 1
fi

DEVICE_SERIAL="$(
  adb devices | awk 'NR > 1 && $2 == "device" { print $1; exit }'
)"

wait_for_android_device() {
  local timeout_seconds="${1:-60}"
  local deadline=$((SECONDS + timeout_seconds))
  local boot_completed

  while ((SECONDS < deadline)); do
    if [[ "$(adb -s "$DEVICE_SERIAL" get-state 2>/dev/null || true)" == "device" ]]; then
      boot_completed="$(
        adb -s "$DEVICE_SERIAL" shell getprop sys.boot_completed 2>/dev/null \
          | tr -d '\r' \
          || true
      )"
      if [[ "$boot_completed" == "1" ]]; then
        return 0
      fi
    fi
    sleep 2
  done

  echo "Android device ${DEVICE_SERIAL} did not become ready within ${timeout_seconds}s" >&2
  adb devices -l >&2 || true
  return 1
}

curl --fail --silent --show-error --location --retry 3 \
  --output "$TEMP_DIR/maestro.zip" "$MAESTRO_URL"
printf '%s  %s\n' "$MAESTRO_SHA256" "$TEMP_DIR/maestro.zip" | sha256sum --check
unzip -q "$TEMP_DIR/maestro.zip" -d "$TEMP_DIR"

mkdir -p "$ARTIFACT_DIR"
wait_for_android_device 60
adb -s "$DEVICE_SERIAL" install -r "$APK_PATH"
wait_for_android_device 60

export MAESTRO_CLI_NO_ANALYTICS=1
export MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
export ANDROID_SERIAL="$DEVICE_SERIAL"

run_maestro() {
  local attempt="$1"
  local output_dir="$ARTIFACT_DIR/output/run-$$/$attempt"

  mkdir -p "$output_dir"
  "$TEMP_DIR/maestro/bin/maestro" test \
    --platform android \
    --env "APP_ID=$APP_ID" \
    --format JUNIT \
    --output "$ARTIFACT_DIR/junit.xml" \
    --test-output-dir "$output_dir" \
    "$ROOT_DIR/maestro" \
    2>&1 | tee "$TEMP_DIR/maestro-${attempt}.log"
}

first_attempt_output="$ARTIFACT_DIR/output/run-$$/attempt-1"
if ! run_maestro "attempt-1"; then
  if grep --recursive --extended-regexp --quiet \
    "device offline|Device server died" "$first_attempt_output" 2>/dev/null; then
    echo "Maestro lost the Android device; waiting for ADB and retrying once" >&2
    adb reconnect offline >/dev/null 2>&1 || true
    wait_for_android_device 60
    run_maestro "attempt-2"
  else
    exit 1
  fi
fi

installed_version="$(
  adb -s "$DEVICE_SERIAL" shell dumpsys package "$APP_ID" \
    | awk -F= '/versionName=/{ print $2; exit }' \
    | tr -d '\r'
)"
[[ "$installed_version" == "$EXPECTED_VERSION" ]] || {
  echo "unexpected installed app version: ${installed_version:-missing}" >&2
  exit 1
}
