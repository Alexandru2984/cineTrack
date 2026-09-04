#!/usr/bin/env python3

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "advisory_sweep_resolved.py"
SPEC = importlib.util.spec_from_file_location("advisory_sweep_resolved", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
sweep = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sweep)


def report(*advisories: tuple[str, str, str]) -> str:
    """An `npm audit --json` report carrying exactly these advisories."""
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
                            "title": title,
                            "severity": severity,
                            "url": f"https://github.com/advisories/{advisory}",
                        },
                    ]
                }
                for package, advisory, title, severity in (
                    (p, a, f"{p} is broken", s) for p, a, s in advisories
                )
            }
        }
    )


class AdvisorySweepResolvedTests(unittest.TestCase):
    def run_script(self, *reports: str) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            paths = []
            for index, content in enumerate(reports):
                path = Path(directory) / f"{index}.json"
                path.write_text(content)
                paths.append(str(path))
            return subprocess.run(
                [sys.executable, str(SCRIPT), *paths],
                capture_output=True,
                text=True,
            )

    def test_drift_with_no_advisory_resolved_is_not_success(self) -> None:
        # The whole point: `npm audit fix` re-resolves the tree, so the lockfile
        # moves whether or not an advisory went away. One is worth a pull
        # request and the other is noise, and only the exit code tells them
        # apart.
        same = report(("image-size", "GHSA-w3rx-r6r6-pgpr", "high"))
        result = self.run_script(same, same)
        self.assertEqual(result.returncode, 1)
        self.assertIn("no advisory was resolved", result.stdout)

    def test_a_resolved_advisory_is_named_in_the_output(self) -> None:
        # The pull request body quotes this, so it has to say which advisory.
        before = report(
            ("image-size", "GHSA-w3rx-r6r6-pgpr", "high"),
            ("decode-uri-component", "GHSA-vcc3-ghjq-m6fr", "moderate"),
        )
        after = report(("image-size", "GHSA-w3rx-r6r6-pgpr", "high"))
        result = self.run_script(before, after)
        self.assertEqual(result.returncode, 0)
        self.assertIn("GHSA-vcc3-ghjq-m6fr", result.stdout)
        self.assertNotIn("GHSA-w3rx-r6r6-pgpr", result.stdout)

    def test_an_unreadable_report_is_not_a_clean_one(self) -> None:
        # Read as clean, a broken audit looks exactly like "everything fixed",
        # which would open a pull request claiming credit for it. Exit 2 keeps
        # that distinct from an honest "nothing was resolved".
        result = self.run_script("not json at all", report())
        self.assertEqual(result.returncode, 2)
        self.assertIn("cannot read audit report", result.stderr)

    def test_a_missing_report_is_not_a_clean_one(self) -> None:
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "/nonexistent/before.json", "/nonexistent/after.json"],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 2)

    def test_projects_are_compared_pairwise(self) -> None:
        # Two projects, four files. Pairing them wrongly would compare the
        # frontend's "after" against mobile's "before" and invent a result.
        frontend_before = report(("nanoid", "GHSA-mwcw-c2x4-8c55", "moderate"))
        frontend_after = report()
        mobile_before = report(("image-size", "GHSA-w3rx-r6r6-pgpr", "high"))
        mobile_after = report(("image-size", "GHSA-w3rx-r6r6-pgpr", "high"))
        result = self.run_script(
            frontend_before, frontend_after, mobile_before, mobile_after
        )
        self.assertEqual(result.returncode, 0)
        self.assertIn("GHSA-mwcw-c2x4-8c55", result.stdout)
        self.assertNotIn("GHSA-w3rx-r6r6-pgpr", result.stdout)

    def test_odd_argument_counts_are_refused(self) -> None:
        result = self.run_script(report())
        self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
