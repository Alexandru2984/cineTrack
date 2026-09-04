#!/usr/bin/env python3
"""The mobile gate's exception policy.

How `npm audit` is run — bounded, retried, and never letting an outage pass for
a clean tree — is `scripts/npm_audit.py` and is tested in `npm_audit_test.py`.
What is left here is the part specific to mobile: which advisories are accepted,
on what grounds, and what happens when those grounds stop holding.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import unittest
from pathlib import Path

GATE = Path(__file__).resolve().parents[2] / "mobile/scripts/check_audit_exceptions.py"
SPEC = importlib.util.spec_from_file_location("check_audit_exceptions", GATE)
assert SPEC is not None and SPEC.loader is not None
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)

REVIEWED = ("image-size", "GHSA-w3rx-r6r6-pgpr")


class AuditGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.real_findings = gate.audit_findings
        self.addCleanup(setattr, gate, "audit_findings", self.real_findings)

    def stub_findings(self, findings: dict) -> None:
        gate.audit_findings = lambda: findings  # type: ignore[assignment]

    def run_main(self) -> tuple[int, str, str]:
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = gate.main()
        return code, stdout.getvalue(), stderr.getvalue()

    def test_the_reviewed_advisories_pass(self) -> None:
        self.stub_findings({key: "reviewed" for key in gate.ACCEPTED})
        code, stdout, _ = self.run_main()
        self.assertEqual(code, 0)
        self.assertIn("reviewed exception", stdout)

    def test_an_unreviewed_advisory_fails(self) -> None:
        findings = {key: "reviewed" for key in gate.ACCEPTED}
        findings[("brand-new", "GHSA-not-reviewed")] = "nobody has looked at this"
        self.stub_findings(findings)
        code, _, stderr = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn("unreviewed", stderr)

    def test_an_exception_that_no_longer_applies_fails(self) -> None:
        # Entries get deleted when upstream fixes them rather than accumulating,
        # so a listed advisory that stopped appearing is an error.
        self.stub_findings({REVIEWED: "still here"})
        code, _, stderr = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn("delete the stale exception", stderr)

    def test_an_outage_warns_rather_than_blocking_every_pull_request(self) -> None:
        # A gate that cannot reach the feed has learned nothing, and turning
        # that into a red build across the repository trades an unknown for a
        # certainty. It has to be loud, though.
        def unavailable() -> dict:
            raise gate.AuditUnavailable("503 Service Unavailable")

        gate.audit_findings = unavailable  # type: ignore[assignment]
        code, stdout, _ = self.run_main()
        self.assertEqual(code, 0)
        self.assertIn("::warning::", stdout)
        self.assertIn("did not run", stdout)

    def test_the_accepted_versions_match_what_is_installed(self) -> None:
        # The exception is pinned to the version that was reviewed; an upgrade
        # has to force the assessment again rather than inherit the decision.
        for package, _ in gate.ACCEPTED:
            reviewed, _reason = gate.ACCEPTED[(package, _)]
            self.assertEqual(
                gate.installed_version(package),
                reviewed,
                f"{package} moved away from the reviewed version",
            )

    def test_no_asset_puts_the_vulnerable_decoders_back_in_reach(self) -> None:
        # The image-size exception rests on there being no ICNS, JXL or HEIF
        # file for Metro to hand to the vulnerable decoders.
        self.assertEqual(gate.unreachable_formats_present(), [])

    def test_the_asset_walk_does_not_descend_into_node_modules(self) -> None:
        # It used to, with `rglob("*")` filtering after the descent: several
        # hundred thousand stat calls to answer a question about three PNGs.
        # Timing is not the assertion — the pruning is, and an ICNS inside
        # node_modules is the thing it must not find.
        planted = gate.MOBILE / "node_modules/.audit-gate-probe/icon.icns"
        planted.parent.mkdir(parents=True, exist_ok=True)
        planted.write_bytes(b"not really an icns")
        self.addCleanup(lambda: (planted.unlink(missing_ok=True),
                                 planted.parent.rmdir()))
        self.assertEqual(gate.unreachable_formats_present(), [])


if __name__ == "__main__":
    unittest.main()
