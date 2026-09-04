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
import os
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
# image-size parses the project's own icon, splash and adaptive-icon files
# inside Metro while the bundle is built. The inputs are repository assets, not
# anything a user or attacker can supply, and the package ships no code into the
# APK or AAB. The impact is a hung build, not a compromised app.
#
# More than that, the vulnerable code is unreachable here. Both advisories are
# in the ICNS, JXL and HEIF decoders, and Metro picks a decoder by file type;
# assets/ holds three PNG files and the repository contains no image in any of
# those three formats.
#
# That last clause is now checked rather than asserted, by
# `unreachable_formats_present` below. It used to be a `find` written in this
# comment, and the recipe was wrong: it pruned `./node_modules` but not
# `./mobile/node_modules`, so run from the repository root it reported
# `@react-native/debugger-shell/.../icon.icns` and told the next reader nothing.
# The conclusion held — that file is an Electron resource Metro never bundles —
# but a re-check that cries wolf is a re-check nobody runs twice.
#
# There is nothing to upgrade to either. GitHub reports no patched version, the
# advisories cover every release, and the package has not been published since
# April 2025.
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


#: The decoders both advisories live in. Metro dispatches on file type, so an
#: asset in one of these is what would make the vulnerable path reachable.
UNREACHABLE_FORMATS = (".icns", ".jxl", ".heic")


def unreachable_formats_present() -> list[Path]:
    """Assets that would put the vulnerable decoders back in reach.

    The exception rests on there being none, so this walks the tree instead of
    leaving a command in a comment for somebody to run. `node_modules` is
    skipped at any depth — the version of this check that lived in a comment
    pruned only the top-level one, and the hit it then reported inside
    `mobile/node_modules` was an Electron resource that Metro never opens.

    Only what Metro can bundle counts, so the search starts at the mobile
    project rather than the repository root.

    `os.walk` rather than `rglob` because pruning has to happen before the
    descent, not after it: `rglob("*")` walks every file in `node_modules` and
    `.git` and only then discards them, which is several hundred thousand
    `stat` calls to answer a question about three PNGs.
    """
    skip = {"node_modules", ".git"}
    found: list[Path] = []
    for directory, subdirectories, filenames in os.walk(MOBILE):
        subdirectories[:] = [name for name in subdirectories if name not in skip]
        for filename in filenames:
            if Path(filename).suffix.lower() in UNREACHABLE_FORMATS:
                found.append((Path(directory) / filename).relative_to(MOBILE))
    return found


def main() -> int:
    try:
        findings = audit_findings()
    except AuditUnavailable as error:
        npm_audit.warn_unavailable(error)
        return 0

    errors: list[str] = []

    if any(package == "image-size" for package, _ in ACCEPTED):
        reachable = unreachable_formats_present()
        if reachable:
            listed = ", ".join(str(path) for path in sorted(reachable))
            errors.append(
                "the image-size exception assumes no ICNS, JXL or HEIF asset exists, "
                f"and these now do: {listed}. Re-assess before accepting the advisories"
            )

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
