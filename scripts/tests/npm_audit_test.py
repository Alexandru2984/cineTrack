#!/usr/bin/env python3
"""`npm audit` must never let "no answer" pass for "no advisories".

npm replies to a registry it cannot reach with valid JSON and no
`vulnerabilities` key. Read through a plain `.get("vulnerabilities", {})` that
is indistinguishable from a clean tree — which on 2026-09-04 made the mobile
gate report two reviewed advisories as fixed and tell whoever read the failure
to delete the exceptions holding them under review. The frontend job hit the
same outage the same hour and simply died on a five-minute timeout.
"""

from __future__ import annotations

import importlib.util
import io
import contextlib
import json
import unittest
from pathlib import Path
from types import SimpleNamespace

RUNNER = Path(__file__).resolve().parents[1] / "npm_audit.py"
SPEC = importlib.util.spec_from_file_location("npm_audit", RUNNER)
assert SPEC is not None and SPEC.loader is not None
npm_audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(npm_audit)

UNREACHABLE = json.dumps(
    {
        # Exactly what npm writes for a 503 from the advisory endpoint.
        "message": (
            "503 Service Unavailable - POST https://registry.npmjs.org"
            "/-/npm/v1/security/advisories/bulk - Service Unavailable"
        ),
        "error": {"summary": "", "detail": ""},
    }
)


def report(*advisories: tuple[str, str, str]) -> str:
    return json.dumps(
        {
            "vulnerabilities": {
                package: {
                    "via": [
                        # npm mixes plain strings in here to name other affected
                        # packages; only the dicts carry an advisory.
                        "some-other-package",
                        {
                            "name": package,
                            "title": f"{package} is broken",
                            "severity": severity,
                            "url": f"https://github.com/advisories/{advisory}",
                        },
                    ]
                }
                for package, advisory, severity in advisories
            }
        }
    )


class NpmAuditTests(unittest.TestCase):
    def setUp(self) -> None:
        self.real_run = npm_audit.subprocess.run
        self.addCleanup(setattr, npm_audit.subprocess, "run", self.real_run)
        real_sleep = npm_audit.time.sleep
        self.addCleanup(setattr, npm_audit.time, "sleep", real_sleep)
        self.slept: list[float] = []
        npm_audit.time.sleep = self.slept.append  # type: ignore[assignment]
        self.calls = 0
        self.commands: list[list[str]] = []

    def stub(self, payload: str, returncode: int = 1, stderr: str = "") -> None:
        def fake_run(command, *_args, **_kwargs):  # type: ignore[no-untyped-def]
            self.calls += 1
            self.commands.append(list(command))
            return SimpleNamespace(stdout=payload, stderr=stderr, returncode=returncode)

        npm_audit.subprocess.run = fake_run  # type: ignore[assignment]

    def test_an_unreachable_registry_is_not_a_clean_tree(self) -> None:
        self.stub(UNREACHABLE)
        with self.assertRaises(npm_audit.AuditUnavailable):
            npm_audit.audit(Path("."), "moderate")

    def test_the_outage_is_retried_and_the_waiting_is_bounded(self) -> None:
        self.stub(UNREACHABLE)
        with self.assertRaises(npm_audit.AuditUnavailable):
            npm_audit.audit(Path("."), "moderate")
        self.assertEqual(self.calls, npm_audit.ATTEMPTS)
        self.assertEqual(len(self.slept), npm_audit.ATTEMPTS - 1)

    def test_the_call_carries_its_own_timeout(self) -> None:
        # The five minutes that cost two jobs was `--fetch-timeout`, which
        # defaults to 300000ms. `--fetch-retries` does not bound it.
        self.stub(report())
        npm_audit.audit(Path("."), "moderate")
        command = self.commands[0]
        self.assertIn(f"--fetch-timeout={npm_audit.FETCH_TIMEOUT_MS}", command)
        self.assertIn("--fetch-retries=0", command)

    def test_no_vulnerabilities_is_a_real_answer(self) -> None:
        self.stub(report(), returncode=0)
        self.assertEqual(npm_audit.audit(Path("."), "moderate")["vulnerabilities"], {})
        self.assertEqual(self.calls, 1, "a clean answer must not be retried")

    def test_empty_and_non_json_output_are_outages_too(self) -> None:
        for payload in ("", "<html>proxy error</html>"):
            with self.subTest(payload=payload):
                self.calls = 0
                self.stub(payload)
                with self.assertRaises(npm_audit.AuditUnavailable):
                    npm_audit.audit(Path("."), "moderate")

    def test_findings_respect_the_threshold(self) -> None:
        parsed = json.loads(
            report(
                ("low-one", "GHSA-low", "low"),
                ("moderate-one", "GHSA-moderate", "moderate"),
                ("critical-one", "GHSA-critical", "critical"),
            )
        )
        at_moderate = npm_audit.findings(parsed, "moderate")
        self.assertIn(("moderate-one", "GHSA-moderate"), at_moderate)
        self.assertIn(("critical-one", "GHSA-critical"), at_moderate)
        self.assertNotIn(("low-one", "GHSA-low"), at_moderate)

        at_high = npm_audit.findings(parsed, "high")
        self.assertEqual(list(at_high), [("critical-one", "GHSA-critical")])

    def test_the_cli_does_not_block_on_an_outage_but_says_so(self) -> None:
        self.stub(UNREACHABLE)
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(npm_audit.main([".", "moderate"]), 0)
        self.assertIn("::warning::", stdout.getvalue())

    def test_the_cli_fails_on_a_real_finding(self) -> None:
        self.stub(report(("bad", "GHSA-bad", "high")))
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(npm_audit.main([".", "moderate"]), 1)

    def test_the_cli_passes_a_clean_tree(self) -> None:
        self.stub(report(), returncode=0)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(npm_audit.main([".", "moderate"]), 0)

    def test_a_bad_audit_level_is_refused(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(npm_audit.main([".", "catastrophic"]), 2)
            self.assertEqual(npm_audit.main(["."]), 2)


if __name__ == "__main__":
    unittest.main()
