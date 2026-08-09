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

import json
import subprocess
import sys
from pathlib import Path

MOBILE = Path(__file__).resolve().parent.parent
LOCKFILE = MOBILE / "package-lock.json"
AUDIT_LEVEL = "high"

# (package, advisory) -> (reviewed version, why it is accepted)
#
# image-size parses the project's own icon, splash and adaptive-icon files
# inside Metro while the bundle is built. The inputs are repository assets, not
# anything a user or attacker can supply, and the package ships no code into the
# APK or AAB. The impact is a hung build, not a compromised app. Every published
# version is affected and the package has had no release since April 2025, so
# there is nothing to upgrade to.
ACCEPTED = {
    ("image-size", "GHSA-w3rx-r6r6-pgpr"): (
        "1.2.1",
        "build-time image parser, repository-controlled input, denial of service only",
    ),
    ("image-size", "GHSA-5p2g-fcmc-qvqq"): (
        "1.2.1",
        "build-time image parser, repository-controlled input, denial of service only",
    ),
}

SEVERITIES = {"high", "critical"}


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
    result = subprocess.run(
        ["npm", "audit", "--json", f"--audit-level={AUDIT_LEVEL}"],
        capture_output=True,
        text=True,
        cwd=MOBILE,
    )
    if not result.stdout.strip():
        raise SystemExit(f"npm audit produced no output: {result.stderr.strip()}")

    report = json.loads(result.stdout)
    findings: dict[tuple[str, str], str] = {}
    for vulnerability in report.get("vulnerabilities", {}).values():
        for via in vulnerability.get("via", []):
            # A string entry only names another vulnerable package; the dict
            # entries carry the actual advisory.
            if not isinstance(via, dict) or via.get("severity") not in SEVERITIES:
                continue
            advisory = str(via.get("url", "")).rsplit("/", 1)[-1]
            if advisory:
                findings[(via.get("name", "?"), advisory)] = via.get("title", "")
    return findings


def main() -> int:
    findings = audit_findings()
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
