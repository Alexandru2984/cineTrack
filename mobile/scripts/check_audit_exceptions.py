#!/usr/bin/env python3
"""Fail on npm audit findings that have not been reviewed and accepted here.

`npm audit` cannot express "known, assessed, and accepted", so a single
unfixable advisory in a transitive build dependency blocks every pull request
in the repository. This wraps the audit instead: anything not listed below is
still a failure, and the listing is deliberately brittle so an accepted risk
cannot quietly outlive the reasoning behind it.

An exception is keyed by package and advisory, and pinned to the exact version
that was reviewed. Bumping the dependency invalidates the entry and forces the
assessment to happen again rather than inheriting the old decision. A listed
advisory that no longer appears is also an error, so entries get deleted when
upstream fixes them instead of accumulating forever.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

MOBILE = Path(__file__).resolve().parent.parent
LOCKFILE = MOBILE / "package-lock.json"
AUDIT_LEVEL = "high"

# Running `npm audit` safely — bounding the call, retrying an outage, and
# telling "no advisories" apart from "no answer" — is the same problem in both
# clients and lives in one place. See `scripts/npm_audit.py` for why each of
# those three is necessary; all three were learned the same morning.
_RUNNER = Path(__file__).resolve().parents[2] / "scripts/npm_audit.py"
_SPEC = importlib.util.spec_from_file_location("npm_audit", _RUNNER)
assert _SPEC is not None and _SPEC.loader is not None
npm_audit = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(npm_audit)

AuditUnavailable = npm_audit.AuditUnavailable

# (package, advisory) -> (reviewed version, why it is accepted)
#
# The two image-size advisories that used to open this list are gone, not
# accepted: metro dropped image-size in 0.84.5, and the last copy came from the
# older metro the lockfile still carried for react-native's CLI plugin.
ACCEPTED = {
    # node-forge was published on 2026-10-02 with no patched release: the
    # vulnerable range ends at the latest version on npm. Reviewed that day.
    #
    # node-forge is pulled in by @expo/cli and by expo-updates' code-signing
    # helper, @expo/code-signing-certificates. Both run on a developer machine
    # or in EAS. The app's expo-updates runtime never imports it (its build/
    # output has no reference), and over-the-air updates are disabled outright
    # (app.config.js refuses them without a signing certificate), so the flawed
    # signature check has nothing to verify in the shipped app.
    ("node-forge", "GHSA-86w9-cpqp-85rv"): (
        "1.4.0",
        "CLI-side update signing for disabled OTA updates; not in the app runtime",
    ),
    # zod 3.25.76 is @expo/cli's own copy (expo/node_modules/zod), which
    # validates the CLI's configuration on a developer machine or in EAS. The
    # app imports the root zod, which is 4.6.7 and patched; the advisory has no
    # fixed 3.x release. Its out-of-memory case needs an attacker-sized array,
    # and the CLI only ever parses the project's own files. Reviewed 2026-10-25.
    ("zod", "GHSA-mrhx-c7xc-m3w5"): (
        "3.25.76|4.6.7",
        "Expo CLI's copy validates project config at build time; app zod is patched",
    ),
}


def installed_version(package: str) -> str | None:
    """Resolve what the lockfile actually pins, so an upgrade breaks the entry."""
    lock = json.loads(LOCKFILE.read_text())
    suffix = f"node_modules/{package}"
    versions = {
        entry.get("version")
        for path, entry in lock.get("packages", {}).items()
        if path == suffix or path.endswith(f"/{suffix}")
    }
    versions.discard(None)
    if len(versions) == 1:
        return versions.pop()
    # Several copies of the same package means the reviewed version is no longer
    # the whole story; report it rather than picking one.
    return None if not versions else "|".join(sorted(versions))


def audit_findings() -> dict[tuple[str, str], str]:
    """Map (package, advisory) -> title for every high or critical finding."""
    report = npm_audit.audit(MOBILE, AUDIT_LEVEL)
    return npm_audit.findings(report, AUDIT_LEVEL)


def main() -> int:
    try:
        findings = audit_findings()
    except AuditUnavailable as error:
        npm_audit.warn_unavailable(error)
        return 0

    errors: list[str] = []

    for key, title in sorted(findings.items()):
        package, advisory = key
        if key not in ACCEPTED:
            errors.append(f"unreviewed {AUDIT_LEVEL}+ advisory {advisory} in {package}: {title}")
            continue
        reviewed, _ = ACCEPTED[key]
        current = installed_version(package)
        if current != reviewed:
            errors.append(
                f"{package} moved from the reviewed {reviewed} to {current}; "
                f"re-assess {advisory} and update the exception"
            )

    for key in sorted(ACCEPTED):
        if key not in findings:
            errors.append(
                f"{key[0]} no longer reports {key[1]}; delete the stale exception"
            )

    if errors:
        for error in errors:
            print(f"audit policy error: {error}", file=sys.stderr)
        return 1

    accepted = ", ".join(f"{package} {advisory}" for package, advisory in sorted(ACCEPTED))
    print(f"npm audit passed with {len(ACCEPTED)} reviewed exception(s): {accepted}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
