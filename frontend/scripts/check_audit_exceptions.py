#!/usr/bin/env python3
"""Fail on npm audit findings in the web app that have not been reviewed here.

The web app used to call `scripts/npm_audit.py` directly, which fails on any
moderate advisory. That holds only while every advisory has a fix. On
2026-11-17 GitHub reviewed one that has none (picomatch, every version), and
from that moment every pull request in the repository failed on a dependency
nothing here could move.

So the web app now keeps a reviewed list like the mobile app's, under the same
policy, which lives in `scripts/npm_audit.py`: anything unlisted fails, an entry
is pinned to the versions reviewed, and an entry whose advisory stops appearing
fails too, so it gets deleted when upstream fixes it.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

FRONTEND = Path(__file__).resolve().parent.parent
LOCKFILE = FRONTEND / "package-lock.json"
# Runtime and build dependencies alike, at moderate: the build toolchain runs
# with the same access as everything else in CI.
AUDIT_LEVEL = "moderate"

_RUNNER = Path(__file__).resolve().parents[2] / "scripts/npm_audit.py"
_SPEC = importlib.util.spec_from_file_location("npm_audit", _RUNNER)
assert _SPEC is not None and _SPEC.loader is not None
npm_audit = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(npm_audit)

AuditUnavailable = npm_audit.AuditUnavailable

# (package, advisory) -> (reviewed versions, why it is accepted)
ACCEPTED: dict[tuple[str, str], tuple[str, str]] = {
    ("picomatch", "GHSA-fc5q-39xc-vjpf"): (
        "4.0.7",
        "Regular-expression backtracking on crafted extglob patterns such as "
        "+(*). No release fixes it: GitHub reviewed it on 2026-11-17 for every "
        "version through 4.0.7, the latest. Here it belongs to Vite, Vitest, "
        "@rollup/pluginutils and fdir, which match patterns from their own "
        "config and this repository's against its own files at build and test "
        "time. None of it is in the site: the built bundle carries no picomatch "
        "code. Delete this once a fixed picomatch reaches them.",
    ),
}


def installed_version(package: str) -> str | None:
    """Resolve what the lockfile actually pins, so an upgrade breaks the entry."""
    return npm_audit.lockfile_versions(LOCKFILE, package)


def audit_findings() -> dict[tuple[str, str], str]:
    """Map (package, advisory) -> title for every finding at AUDIT_LEVEL or above."""
    report = npm_audit.audit(FRONTEND, AUDIT_LEVEL)
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
