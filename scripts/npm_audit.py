#!/usr/bin/env python3
"""Run `npm audit` in a way that survives npm having a bad day.

Both clients gate on `npm audit`, and both learned the same lesson the same
morning. On 2026-09-04 `registry.npmjs.org/-/npm/v1/security/advisories/bulk`
answered 503s and then stopped answering at all. It cost the mobile job five
minutes and a failure whose message said two reviewed advisories had been fixed
— they had not — and it cost the frontend job five minutes and a bare network
timeout, in a `npm audit --audit-level=moderate` with no handling of any kind.

Three things, in one place so the two clients cannot drift apart on them:

* **Bound the call.** The five minutes is `--fetch-timeout`, which defaults to
  300000ms. `--fetch-retries` does not bound it; nothing bounds it but itself.
* **Retry.** The outage cleared within minutes both times.
* **Tell "no advisories" apart from "no answer".** npm replies to a registry it
  cannot reach with valid JSON and no `vulnerabilities` key. Read through
  `.get("vulnerabilities", {})` that is indistinguishable from a clean tree,
  which is how a gate came to report reviewed exceptions as stale.

What to *do* about an outage is the caller's decision, not this module's; it
raises [`AuditUnavailable`] and says nothing about whether that should be fatal.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

#: Worst case is three 30-second attempts plus 15 seconds of backoff. The common
#: case — the endpoint refusing immediately — is a few seconds.
ATTEMPTS = 3
BACKOFF_SECONDS = 5
FETCH_TIMEOUT_MS = 30000

SEVERITY_ORDER = ("info", "low", "moderate", "high", "critical")


class AuditUnavailable(Exception):
    """npm answered, but not with an audit.

    Its own type because it is the only failure where the caller has learned
    nothing at all — not "no advisories", not "an advisory"; nothing. That is a
    different question from what to do about a finding and should not be
    answered by the same branch.
    """


def audit_once(project: Path, audit_level: str) -> dict:
    """One `npm audit --json`, parsed. Raises AuditUnavailable if it did not answer."""
    result = subprocess.run(
        [
            "npm",
            "audit",
            "--json",
            f"--audit-level={audit_level}",
            # The retrying belongs to `audit()` below, where the total is
            # bounded and visible in one place instead of inside npm.
            "--fetch-retries=0",
            f"--fetch-timeout={FETCH_TIMEOUT_MS}",
        ],
        capture_output=True,
        text=True,
        cwd=project,
    )

    # A gate that cannot read the audit must not conclude there is nothing to
    # report, so every unreadable shape below is an error rather than a default.
    if not result.stdout.strip():
        raise AuditUnavailable(f"npm audit produced no output: {result.stderr.strip()[:400]}")

    try:
        report = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise AuditUnavailable(
            f"npm audit did not return JSON ({error}); "
            f"first bytes were {result.stdout[:120]!r}"
        ) from error

    if "vulnerabilities" not in report:
        message = report.get("message") or json.dumps(report.get("error", report))[:400]
        raise AuditUnavailable(f"exit {result.returncode}: {message}")

    return report


def audit(project: Path, audit_level: str) -> dict:
    """`npm audit`, retried past a registry that is briefly not answering."""
    unavailable = ""
    for attempt in range(1, ATTEMPTS + 1):
        try:
            return audit_once(project, audit_level)
        except AuditUnavailable as error:
            unavailable = str(error)
            if attempt < ATTEMPTS:
                time.sleep(BACKOFF_SECONDS * attempt)
    raise AuditUnavailable(unavailable)


def findings(report: dict, audit_level: str) -> dict[tuple[str, str], str]:
    """Map (package, advisory) -> description for findings at or above `audit_level`."""
    threshold = SEVERITY_ORDER.index(audit_level)
    found: dict[tuple[str, str], str] = {}
    for vulnerability in report.get("vulnerabilities", {}).values():
        for via in vulnerability.get("via", []):
            # String entries only name another vulnerable package; the dict
            # entries carry the advisory itself.
            if not isinstance(via, dict):
                continue
            severity = str(via.get("severity", ""))
            if severity not in SEVERITY_ORDER:
                continue
            if SEVERITY_ORDER.index(severity) < threshold:
                continue
            advisory = str(via.get("url", "")).rsplit("/", 1)[-1]
            if advisory:
                found[(str(via.get("name", "?")), advisory)] = (
                    f"{via.get('title', '')} ({severity})"
                )
    return found


def warn_unavailable(error: AuditUnavailable) -> None:
    """Report an outage loudly, for a caller that has decided not to block on one.

    Blocking is the wrong trade for this particular failure. The gate has no
    information either way during an npm outage, and failing every pull request
    until somebody else's service recovers is the pathology `advisory-sweep.yml`
    exists to stop — an answer that changes without anybody touching the code,
    breaking work that has nothing to do with it. The daily sweep runs the same
    audit against main, so anything missed surfaces within a day.
    """
    print(f"::warning::npm's advisory endpoint did not answer; this gate did not run ({error})")
    print(f"npm audit was unreachable after {ATTEMPTS} attempts: {error}", file=sys.stderr)


def lockfile_versions(lockfile: Path, package: str) -> str | None:
    """Every version of `package` the lockfile pins, joined with `|`.

    Reading the lockfile rather than `node_modules` means an upgrade breaks a
    reviewed exception even before anybody installs it. Several copies are
    reported together, so a new copy also breaks it.
    """
    lock = json.loads(lockfile.read_text())
    suffix = f"node_modules/{package}"
    versions = {
        entry.get("version")
        for path, entry in lock.get("packages", {}).items()
        if path == suffix or path.endswith(f"/{suffix}")
    }
    versions.discard(None)
    return "|".join(sorted(versions)) if versions else None


def enforce_exceptions(
    found: dict[tuple[str, str], str],
    accepted: dict[tuple[str, str], tuple[str, str]],
    installed_version,
    audit_level: str,
) -> int:
    """Fail on any finding not reviewed in `accepted`, and on any stale review.

    `accepted` maps (package, advisory) to (reviewed versions, reason). Both
    clients keep their own list next to their own lockfile; the policy is here
    so they cannot apply it differently:

    * an advisory nobody has reviewed fails;
    * a reviewed one fails once the package moves off the versions reviewed,
      so the assessment is made again rather than inherited;
    * a review whose advisory no longer appears fails, so entries are deleted
      when upstream fixes them instead of accumulating.
    """
    errors: list[str] = []

    for key, title in sorted(found.items()):
        package, advisory = key
        if key not in accepted:
            errors.append(f"unreviewed {audit_level}+ advisory {advisory} in {package}: {title}")
            continue
        reviewed, _ = accepted[key]
        current = installed_version(package)
        if current != reviewed:
            errors.append(
                f"{package} moved from the reviewed {reviewed} to {current}; "
                f"re-assess {advisory} and update the exception"
            )

    for key in sorted(accepted):
        if key not in found:
            errors.append(f"{key[0]} no longer reports {key[1]}; delete the stale exception")

    if errors:
        for error in errors:
            print(f"audit policy error: {error}", file=sys.stderr)
        return 1

    if not accepted:
        print(f"npm audit passed: no {audit_level}+ advisories and no reviewed exceptions in use")
        return 0
    listed = ", ".join(f"{package} {advisory}" for package, advisory in sorted(accepted))
    print(f"npm audit passed with {len(accepted)} reviewed exception(s): {listed}")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {Path(__file__).name} <project-dir> <audit-level>", file=sys.stderr)
        return 2

    project, audit_level = Path(argv[0]), argv[1]
    if audit_level not in SEVERITY_ORDER:
        print(f"unknown audit level {audit_level!r}", file=sys.stderr)
        return 2

    try:
        report = audit(project, audit_level)
    except AuditUnavailable as error:
        warn_unavailable(error)
        return 0

    reported = findings(report, audit_level)
    if not reported:
        # Said explicitly, because "npm audit passed" and "npm audit did not run"
        # look identical in a release log otherwise — and the second one is what
        # the outage path above produces. An audit in September 2026 raised that
        # a green gate expresses an acceptance policy, not an inventory.
        print(f"npm audit ran against {project} and found no {audit_level}+ advisories")
        return 0

    for (package, advisory), description in sorted(reported.items()):
        print(f"{audit_level}+ advisory {advisory} in {package}: {description}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
