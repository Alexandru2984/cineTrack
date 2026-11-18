#!/usr/bin/env python3
"""The exception policy of both clients' audit gates.

How `npm audit` is run — bounded, retried, and never letting an outage pass for
a clean tree — is `scripts/npm_audit.py` and is tested in `npm_audit_test.py`.
What is left here is the exception policy, which both gates share: which
advisories are accepted, on what grounds, and what happens when those grounds
stop holding. Each test runs against the web gate and the mobile gate alike, so
neither can drift from the policy the other enforces.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load(relative: str, name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GATES = {
    "frontend": load("frontend/scripts/check_audit_exceptions.py", "frontend_audit_gate"),
    "mobile": load("mobile/scripts/check_audit_exceptions.py", "mobile_audit_gate"),
}


class AuditGatePolicy:
    """Mixed into one TestCase per client; `gate` is that client's module."""

    gate = None

    def setUp(self) -> None:
        gate = self.gate
        self.addCleanup(setattr, gate, "audit_findings", gate.audit_findings)
        self.addCleanup(setattr, gate, "ACCEPTED", gate.ACCEPTED)

    def stub_findings(self, findings: dict) -> None:
        self.gate.audit_findings = lambda: findings

    def run_main(self) -> tuple[int, str, str]:
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = self.gate.main()
        return code, stdout.getvalue(), stderr.getvalue()

    def test_the_reviewed_advisories_pass(self) -> None:
        self.stub_findings({key: "reviewed" for key in self.gate.ACCEPTED})
        code, stdout, _ = self.run_main()
        self.assertEqual(code, 0)
        self.assertIn("reviewed exception", stdout)

    def test_an_unreviewed_advisory_fails(self) -> None:
        findings = {key: "reviewed" for key in self.gate.ACCEPTED}
        findings[("brand-new", "GHSA-not-reviewed")] = "nobody has looked at this"
        self.stub_findings(findings)
        code, _, stderr = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn("unreviewed", stderr)

    def test_an_exception_that_no_longer_applies_fails(self) -> None:
        # Entries get deleted when upstream fixes them rather than accumulating,
        # so a listed advisory that stopped appearing is an error.
        self.gate.ACCEPTED = {("left-pad", "GHSA-fixed-upstream"): ("1.0.0", "fixed since")}
        self.stub_findings({})
        code, _, stderr = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn("delete the stale exception", stderr)

    def test_a_package_that_moved_off_the_reviewed_version_fails(self) -> None:
        # The review was of particular versions; a different one has to be
        # assessed again rather than inherit the decision.
        key = ("picomatch", "GHSA-review-of-an-old-version")
        self.gate.ACCEPTED = {key: ("0.0.1", "reviewed long ago")}
        self.stub_findings({key: "still reported"})
        code, _, stderr = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn("moved from the reviewed 0.0.1", stderr)

    def test_an_outage_warns_rather_than_blocking_every_pull_request(self) -> None:
        # A gate that cannot reach the feed has learned nothing, and turning
        # that into a red build across the repository trades an unknown for a
        # certainty. It has to be loud, though.
        def unavailable() -> dict:
            raise self.gate.AuditUnavailable("503 Service Unavailable")

        self.gate.audit_findings = unavailable
        code, stdout, _ = self.run_main()
        self.assertEqual(code, 0)
        self.assertIn("::warning::", stdout)
        self.assertIn("did not run", stdout)

    def test_the_accepted_versions_match_what_is_installed(self) -> None:
        # The exception is pinned to the version that was reviewed; an upgrade
        # has to force the assessment again rather than inherit the decision.
        for (package, advisory), (reviewed, reason) in self.gate.ACCEPTED.items():
            self.assertEqual(
                self.gate.installed_version(package),
                reviewed,
                f"{package} moved away from the version reviewed for {advisory}",
            )
            self.assertGreater(len(reason), 80, f"{advisory} needs its reasoning written down")

    def test_the_gate_audits_at_moderate(self) -> None:
        self.assertEqual(self.gate.AUDIT_LEVEL, "moderate")


class FrontendAuditGateTests(AuditGatePolicy, unittest.TestCase):
    gate = GATES["frontend"]


class MobileAuditGateTests(AuditGatePolicy, unittest.TestCase):
    gate = GATES["mobile"]


if __name__ == "__main__":
    unittest.main()
