#!/usr/bin/env python3

import csv
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ANALYZER = ROOT / "bench" / "analyze_capacity.py"


class CapacityAnalysisTests(unittest.TestCase):
    def run_analyzer(self, samples: list[tuple[str, int, float]]) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "capacity.csv"
            with path.open("w", newline="", encoding="utf-8") as handle:
                writer = csv.writer(handle)
                writer.writerow(("metric_name", "timestamp", "metric_value"))
                writer.writerows(samples)
            return subprocess.run(
                [str(ANALYZER), str(path), "10", "500"],
                check=False,
                capture_output=True,
                text=True,
            )

    def test_reports_highest_healthy_window_instead_of_final_drain(self) -> None:
        samples = []
        samples.extend(("http_req_duration", 100 + i % 10, 100.0) for i in range(20))
        samples.extend(("http_req_duration", 110 + i % 10, 700.0) for i in range(30))
        samples.extend(("http_req_duration", 120 + i % 10, 80.0) for i in range(10))

        result = self.run_analyzer(samples)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Sustained within budget: ~2 req/s", result.stdout)
        self.assertIn("OVER BUDGET", result.stdout)

    def test_fails_when_export_has_no_duration_samples(self) -> None:
        result = self.run_analyzer([("http_req_failed", 100, 0.0)])

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no http_req_duration samples", result.stderr)


if __name__ == "__main__":
    unittest.main()
