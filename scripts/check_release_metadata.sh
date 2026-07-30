#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 - "$ROOT_DIR" <<'PY'
import json
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])


def load_json(relative_path: str):
    with (root / relative_path).open(encoding="utf-8") as handle:
        return json.load(handle)


def fail(message: str) -> None:
    raise SystemExit(f"release metadata error: {message}")


app = load_json("mobile/app.json")["expo"]
package = load_json("mobile/package.json")
lock = load_json("mobile/package-lock.json")
eas = load_json("mobile/eas.json")

version = app.get("version")
if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
    fail("mobile app version must use MAJOR.MINOR.PATCH")

versions = {
    "mobile/app.json": version,
    "mobile/package.json": package.get("version"),
    "mobile/package-lock.json": lock.get("version"),
    "mobile/package-lock.json root package": lock.get("packages", {}).get("", {}).get("version"),
}
for source, candidate in versions.items():
    if candidate != version:
        fail(f"{source} has {candidate!r}, expected {version!r}")

if app.get("runtimeVersion") != {"policy": "appVersion"}:
    fail("runtimeVersion must use the appVersion policy")

if eas.get("cli", {}).get("appVersionSource") != "remote":
    fail("EAS must manage developer-facing build numbers remotely")

production = eas.get("build", {}).get("production", {})
if production.get("autoIncrement") is not True:
    fail("the production EAS profile must auto-increment build numbers")
if production.get("env", {}).get("EXPO_UPDATES_ENABLED") != "false":
    fail("production OTA updates must remain disabled until signing is configured")

changelog = (root / "CHANGELOG.md").read_text(encoding="utf-8")
entry = re.compile(
    rf"^## \[{re.escape(version)}\] - (?:Unreleased|\d{{4}}-\d{{2}}-\d{{2}})$",
    re.MULTILINE,
)
if entry.search(changelog) is None:
    fail(f"CHANGELOG.md has no current entry for {version}")

print(f"release metadata valid for Văzute {version}")
PY
