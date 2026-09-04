#!/usr/bin/env python3
"""The mobile audit gate must not read a failed audit as a clean one.

`npm audit --json` answers an unreachable registry with valid JSON that has no
`vulnerabilities` key. Read through a plain `.get("vulnerabilities", {})` that
looks exactly like a tree with nothing wrong with it, and the gate then reports
every reviewed exception as stale — telling whoever reads the failure to delete
the entries that are holding a real advisory under review.

That is how the mobile job failed on 2026-09-04, so the distinction is tested
rather than left to the next reader of the code.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import unittest
from pathlib import Path
from types import SimpleNamespace

GATE = Path(__file__).resolve().parents[2] / "mobile/scripts/check_audit_exceptions.py"
SPEC = importlib.util.spec_from_file_location("check_audit_exceptions", GATE)
assert SPEC is not None and SPEC.loader is not None
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


class AuditGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.real_run = gate.subprocess.run
        self.addCleanup(setattr, gate.subprocess, "run", self.real_run)
        # The retry backoff is real seconds in CI and pointless here.
        self.slept: list[float] = []
        real_sleep = gate.time.sleep
        self.addCleanup(setattr, gate.time, "sleep", real_sleep)
        gate.time.sleep = self.slept.append  # type: ignore[assignment]

    def stub_calls(self) -> int:
        return self.calls

    def stub_audit(self, payload: str, returncode: int = 1, stderr: str = "") -> None:
        self.calls = 0

        def fake_run(*_args: object, **_kwargs: object) -> SimpleNamespace:
            self.calls += 1
            return SimpleNamespace(stdout=payload, stderr=stderr, returncode=returncode)

        gate.subprocess.run = fake_run  # type: ignore[assignment]

    def unreachable_payload(self) -> str:
        # Exactly what npm writes for a 503 from the advisory endpoint: valid
        # JSON, no `vulnerabilities` key at all.
        return json.dumps(
            {
                "message": (
                    "503 Service Unavailable - POST https://registry.npmjs.org"
                    "/-/npm/v1/security/advisories/bulk - Service Unavailable"
                ),
                "error": {"summary": "", "detail": ""},
            }
        )

    def test_an_unreachable_registry_is_not_a_clean_tree(self) -> None:
        self.stub_audit(self.unreachable_payload())
        with self.assertRaises(gate.AuditUnavailable):
            gate.audit_findings()

    def test_an_unreachable_registry_is_retried_before_giving_up(self) -> None:
        # The 503 that caused this cleared within minutes, so one bad answer
        # must not be the whole story.
        self.stub_audit(self.unreachable_payload())
        with self.assertRaises(gate.AuditUnavailable):
            gate.audit_findings()
        self.assertEqual(self.stub_calls(), gate.AUDIT_ATTEMPTS)
        self.assertEqual(len(self.slept), gate.AUDIT_ATTEMPTS - 1)

    def test_an_outage_warns_rather_than_blocking_every_pull_request(self) -> None:
        # A gate that cannot reach the feed has learned nothing, and turning
        # that into a red build across the repository trades an unknown for a
        # certainty. It has to be loud, though.
        self.stub_audit(self.unreachable_payload())
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(gate.main(), 0)
        self.assertIn("::warning::", stdout.getvalue())
        self.assertIn("did not run", stdout.getvalue())

    def test_a_real_finding_still_fails_the_build(self) -> None:
        # The escape hatch above must be reachable only by the unreachable
        # shape, never by an advisory nobody has reviewed.
        self.stub_audit(
            json.dumps(
                {
                    "vulnerabilities": {
                        "brand-new": {
                            "via": [
                                {
                                    "name": "brand-new",
                                    "title": "unreviewed",
                                    "severity": "critical",
                                    "url": "https://github.com/advisories/GHSA-not-reviewed",
                                }
                            ]
                        }
                    },
                    "metadata": {},
                }
            )
        )
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(gate.main(), 1)

    def test_no_vulnerabilities_is_a_clean_tree(self) -> None:
        # The other side of the line: npm really did answer, and the answer was
        # that there is nothing to report.
        self.stub_audit(json.dumps({"vulnerabilities": {}, "metadata": {}}), returncode=0)
        self.assertEqual(gate.audit_findings(), {})

    def test_advisories_are_read_from_a_real_report(self) -> None:
        self.stub_audit(
            json.dumps(
                {
                    "vulnerabilities": {
                        "image-size": {
                            "via": [
                                "some-other-package",
                                {
                                    "name": "image-size",
                                    "title": "ICNS parser allows denial of service",
                                    "severity": "high",
                                    "url": "https://github.com/advisories/GHSA-w3rx-r6r6-pgpr",
                                },
                                {
                                    "name": "image-size",
                                    "title": "moderate finding, below the gate",
                                    "severity": "moderate",
                                    "url": "https://github.com/advisories/GHSA-ignored-here",
                                },
                            ]
                        }
                    },
                    "metadata": {},
                }
            )
        )
        findings = gate.audit_findings()
        self.assertIn(("image-size", "GHSA-w3rx-r6r6-pgpr"), findings)
        self.assertNotIn(("image-size", "GHSA-ignored-here"), findings)

    def test_empty_output_still_fails(self) -> None:
        self.stub_audit("", stderr="npm died")
        with self.assertRaises(SystemExit) as raised:
            gate.audit_findings()
        self.assertIn("produced no output", str(raised.exception))

    def test_non_json_output_still_fails(self) -> None:
        self.stub_audit("<html>proxy error</html>")
        with self.assertRaises(SystemExit) as raised:
            gate.audit_findings()
        self.assertIn("did not return JSON", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
