#!/usr/bin/env python3
"""Turn a k6 CSV export into a per-window capacity table.

The aggregate summary of a ramp is close to meaningless: it averages the
comfortable early stages together with the overloaded tail. What matters is the
last window that still met the budget, so this bins the run by wall-clock
window and reports throughput, latency and errors for each.

Usage: analyze_capacity.py <k6.csv> [window_seconds] [p95_budget_ms]
"""

from __future__ import annotations

import csv
import sys
from collections import defaultdict


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: analyze_capacity.py <k6.csv> [window_s] [p95_budget_ms]")
    path = sys.argv[1]
    window = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    budget = float(sys.argv[3]) if len(sys.argv) > 3 else 500.0

    durations: dict[int, list[float]] = defaultdict(list)
    failures: dict[int, int] = defaultdict(int)
    start: int | None = None

    with open(path, newline="") as handle:
        for row in csv.DictReader(handle):
            if row["metric_name"] not in ("http_req_duration", "http_req_failed"):
                continue
            ts = int(row["timestamp"])
            start = ts if start is None else min(start, ts)
            bucket = (ts - start) // window
            if row["metric_name"] == "http_req_duration":
                durations[bucket].append(float(row["metric_value"]))
            elif float(row["metric_value"]) == 1.0:
                failures[bucket] += 1

    if not durations:
        raise SystemExit(f"no http_req_duration samples in {path}")

    def pct(values: list[float], q: float) -> float:
        ordered = sorted(values)
        idx = min(len(ordered) - 1, int(len(ordered) * q))
        return ordered[idx]

    print(f"  window  {'req/s':>8} {'p95 ms':>8} {'p99 ms':>8} {'errors':>7}  status")
    print("  " + "-" * 52)

    best = None
    for bucket in sorted(durations):
        values = durations[bucket]
        rps = len(values) / window
        p95 = pct(values, 0.95)
        p99 = pct(values, 0.99)
        errs = failures.get(bucket, 0)
        err_rate = errs / max(len(values), 1)
        ok = p95 < budget and err_rate < 0.01
        # Keep the *highest* throughput that stayed in budget, not the last one:
        # the final windows are the ramp draining, and reporting those would
        # understate capacity by an order of magnitude.
        if ok and (best is None or rps > best[0]):
            best = (rps, p95)
        status = "ok" if ok else "OVER BUDGET"
        start_s = bucket * window
        print(
            f"  {start_s:>4}s   {rps:>8.0f} {p95:>8.0f} {p99:>8.0f} {errs:>7}  {status}"
        )

    print()
    if best:
        rps, p95 = best
        print(f"  Sustained within budget: ~{rps:.0f} req/s at p95 {p95:.0f} ms")
        # A browsing user is not a constant request stream. State the assumption
        # rather than quoting a user count as if it were measured.
        for think in (5, 10, 30):
            print(f"    ≈ {rps * think:>6.0f} concurrent users at one request every {think}s")
    else:
        print("  No window met the budget; the service was over budget from the start.")


if __name__ == "__main__":
    main()
