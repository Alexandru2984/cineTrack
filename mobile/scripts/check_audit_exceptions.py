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
from pathlib import Path

MOBILE = Path(__file__).resolve().parent.parent
LOCKFILE = MOBILE / "package-lock.json"
# Moderate, not high: the November 2026 review found nine moderate advisories
# that nothing here would ever have reported, all of them one minimatch issue.
# Accepting it below, by name and version, is the point: an accepted risk is
# written down and re-examined when the dependency moves, rather than invisible.
AUDIT_LEVEL = "moderate"

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
# older metro the lockfile still carried for react-native's CLI plugin. So is
# node-forge's GHSA-86w9-cpqp-85rv, accepted from 2026-10-02 until 1.4.1 fixed
# it, and zod's GHSA-mrhx-c7xc-m3w5, accepted from 2026-10-25 for Expo CLI's
# own zod 3 until the advisory sweep of 2026-11-08 moved it to a patched one.
# minimatch's GHSA-g3hv-75wg-m249 was accepted from 2026-11-16 for the 10.x
# copies under @expo/fingerprint and @typescript-eslint/typescript-estree, and
# left on 2026-11-18 when package.json overrode both to 11.0.5: they call only
# minimatch(), new Minimatch(), match, negate and pattern, which 11 keeps, and
# the Expo fingerprint hashes came out identical.
ACCEPTED: dict[tuple[str, str], tuple[str, str]] = {
    ("picomatch", "GHSA-fc5q-39xc-vjpf"): (
        "2.3.2|4.0.5",
        "Regular-expression backtracking on crafted extglob patterns such as "
        "+(*). No release fixes it: GitHub reviewed it on 2026-11-17 for every "
        "version through 4.0.7, the latest. The copies here belong to Jest "
        "(jest-util, micromatch), Metro and the Expo CLI (anymatch, fdir, "
        "@expo/metro-config, @expo/cli), which match patterns from their own "
        "config and this repository's against its own files. None of them is "
        "in the app: the exported Android bundle carries no picomatch code. "
        "Delete this once a fixed picomatch reaches them.",
    ),
}


def installed_version(package: str) -> str | None:
    """Resolve what the lockfile actually pins, so an upgrade breaks the entry."""
    return npm_audit.lockfile_versions(LOCKFILE, package)


def audit_findings() -> dict[tuple[str, str], str]:
    """Map (package, advisory) -> title for every finding at AUDIT_LEVEL or above."""
    report = npm_audit.audit(MOBILE, AUDIT_LEVEL)
    return npm_audit.findings(report, AUDIT_LEVEL)


def main() -> int:
    try:
        findings = audit_findings()
    except AuditUnavailable as error:
        npm_audit.warn_unavailable(error)
        return 0
    return npm_audit.enforce_exceptions(findings, ACCEPTED, installed_version, AUDIT_LEVEL)


if __name__ == "__main__":
    raise SystemExit(main())
