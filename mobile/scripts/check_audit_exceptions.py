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
import os
import subprocess
import sys
import time
from pathlib import Path

MOBILE = Path(__file__).resolve().parent.parent
LOCKFILE = MOBILE / "package-lock.json"
AUDIT_LEVEL = "high"

# One `npm audit` can take five minutes before it fails, and the CI step that
# started this did exactly that. `--fetch-retries` is not what bounds it:
# `--fetch-timeout` defaults to 300000ms, so a request the endpoint never
# answers hangs for the full five minutes on the first try. Both are set below,
# and the retrying happens here instead, where the total is predictable.
#
# Worst case is now three 30-second attempts plus 15 seconds of backoff, and the
# common case — the endpoint answering 503 immediately, which is what it did on
# 2026-09-04 — is a few seconds.
AUDIT_ATTEMPTS = 3
AUDIT_BACKOFF_SECONDS = 5
AUDIT_FETCH_TIMEOUT_MS = 30000


class AuditUnavailable(Exception):
    """npm answered, but not with an audit.

    Kept separate from every other failure because it is the only one where the
    gate has learned nothing at all — not "no advisories", not "an advisory";
    nothing. What to do about that is a different decision from what to do about
    a finding, and it needs its own type to stay that way.
    """

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
    """Map (package, advisory) -> title for every high or critical finding.

    Retries a registry that is not answering, because it usually is again a
    moment later: `registry.npmjs.org/-/npm/v1/security/advisories/bulk`
    returned 503 for several minutes on 2026-09-04 and was fine on the next
    call.
    """
    unavailable = ""
    for attempt in range(1, AUDIT_ATTEMPTS + 1):
        try:
            return audit_findings_once()
        except AuditUnavailable as error:
            unavailable = str(error)
            if attempt < AUDIT_ATTEMPTS:
                time.sleep(AUDIT_BACKOFF_SECONDS * attempt)
    raise AuditUnavailable(unavailable)


def audit_findings_once() -> dict[tuple[str, str], str]:
    """One `npm audit`, parsed. Raises AuditUnavailable if it did not answer."""
    result = subprocess.run(
        # The retrying belongs to the caller above, where a failed attempt is
        # bounded and the total is visible in one place.
        [
            "npm",
            "audit",
            "--json",
            f"--audit-level={AUDIT_LEVEL}",
            "--fetch-retries=0",
            f"--fetch-timeout={AUDIT_FETCH_TIMEOUT_MS}",
        ],
        capture_output=True,
        text=True,
        cwd=MOBILE,
    )
    # Anything unexpected here has to fail the build. A gate that cannot read
    # the audit must not conclude there is nothing to report.
    if not result.stdout.strip():
        raise SystemExit(f"npm audit produced no output: {result.stderr.strip()}")

    try:
        report = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise SystemExit(
            f"npm audit did not return JSON ({error}); "
            f"first bytes were {result.stdout[:120]!r}"
        ) from error

    # A registry it could not reach is still valid JSON, and the shape it
    # returns is `{"message": ..., "error": {...}}` with no `vulnerabilities`
    # at all. Read through `.get("vulnerabilities", {})` that is indistinguishable
    # from a clean tree, so every exception below looks stale and the build fails
    # telling you to delete them — which is the worst possible advice, because
    # deleting a real exception is how a genuine advisory gets waved through
    # later without anybody noticing.
    #
    # It is not hypothetical. On 2026-09-04 the mobile job spent five minutes in
    # this call and then reported both reviewed image-size advisories as gone,
    # while the same audit run anywhere else still listed them.
    #
    # An empty `vulnerabilities` is a legitimate answer; a missing one is not.
    if "vulnerabilities" not in report:
        message = report.get("message") or json.dumps(report.get("error", report))[:400]
        raise AuditUnavailable(f"exit {result.returncode}: {message}")

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
        # Blocking here would be the wrong trade. The gate has no information
        # either way during an npm outage, and failing every pull request in the
        # repository until somebody else's service recovers is the exact
        # pathology `advisory-sweep.yml` was written to stop — an answer that
        # changes without anybody touching this code, breaking work that has
        # nothing to do with it.
        #
        # It is loud, it is narrow — only the one shape npm returns for an
        # endpoint failure reaches here, never a parsed finding — and the daily
        # sweep runs the same audit against main, so anything missed while the
        # endpoint was down is picked up within a day.
        print(f"::warning::npm's advisory endpoint did not answer; this gate did not run ({error})")
        print(
            f"npm audit was unreachable after {AUDIT_ATTEMPTS} attempts: {error}",
            file=sys.stderr,
        )
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
