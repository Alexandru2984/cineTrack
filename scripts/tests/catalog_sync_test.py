#!/usr/bin/env python3
"""Which TMDB export the catalog sync picks, and what it reports.

The sync failed every day from August to October 2026: the host moved to
Europe/Bucharest, the cron line kept its local time, and the job started an
hour before TMDB published the day's files. It asked for a file that did not
exist, S3 answered 403, and the failure went only to a log.
"""

from __future__ import annotations

import datetime as dt
import importlib.util
import shutil
import sys
import tempfile
import types
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

# The script uploads to R2 through boto3, which a CI runner does not have and
# none of these tests reach.
boto3 = types.ModuleType("boto3")
botocore = types.ModuleType("botocore")
botocore_config = types.ModuleType("botocore.config")
botocore_config.Config = object  # type: ignore[attr-defined]
sys.modules.setdefault("boto3", boto3)
sys.modules.setdefault("botocore", botocore)
sys.modules.setdefault("botocore.config", botocore_config)

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/sync_tmdb_catalog.py"
SPEC = importlib.util.spec_from_file_location("sync_tmdb_catalog", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)

BASE = "https://exports.example/p/exports"
TODAY = dt.date(2026, 10, 12)
YESTERDAY = dt.date(2026, 10, 11)


def serving(published: set[str], failing: int | None = None):
    """Answer HEAD requests the way TMDB's S3 bucket does."""

    def urlopen(request, timeout):
        url = request.full_url
        if failing is not None:
            raise urllib.error.HTTPError(url, failing, "error", {}, None)
        if url.rsplit("/", 1)[1] in published:
            return mock.MagicMock()
        # No list permission on the bucket, so a missing key is 403, not 404.
        raise urllib.error.HTTPError(url, 403, "Forbidden", {}, None)

    return mock.patch.object(sync.urllib.request, "urlopen", side_effect=urlopen)


def names(day: dt.date) -> set[str]:
    return set(sync.export_filenames(day).values())


class ExportSelectionTests(unittest.TestCase):
    def test_todays_exports_are_used_once_published(self) -> None:
        with serving(names(TODAY) | names(YESTERDAY)):
            self.assertEqual(sync.newest_published_export(BASE, TODAY), TODAY)

    def test_an_early_run_uses_yesterdays_exports_instead_of_failing(self) -> None:
        with serving(names(YESTERDAY)):
            self.assertEqual(sync.newest_published_export(BASE, TODAY), YESTERDAY)

    def test_a_half_published_day_is_not_used(self) -> None:
        # TMDB writes the TV file about ten minutes before the movie file.
        tv_only = {sync.export_filenames(TODAY)["tv"]}
        with serving(tv_only | names(YESTERDAY)):
            self.assertEqual(sync.newest_published_export(BASE, TODAY), YESTERDAY)

    def test_no_recent_export_is_a_failure(self) -> None:
        with serving(set()):
            with self.assertRaisesRegex(RuntimeError, "no complete export"):
                sync.newest_published_export(BASE, TODAY)

    def test_a_server_error_is_not_mistaken_for_an_unpublished_file(self) -> None:
        with serving(set(), failing=500):
            with self.assertRaises(urllib.error.HTTPError):
                sync.newest_published_export(BASE, TODAY)

    def test_the_export_names_follow_tmdbs_scheme(self) -> None:
        self.assertEqual(
            sync.export_filenames(TODAY),
            {
                "movie": "movie_ids_10_12_2026.json.gz",
                "tv": "tv_series_ids_10_12_2026.json.gz",
            },
        )


class MetricsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)
        self.path = self.dir / "catalog_sync.prom"

    def read(self) -> dict[str, str]:
        lines = self.path.read_text().splitlines()
        return dict(line.split(" ", 1) for line in lines if not line.startswith("#"))

    def test_a_successful_run_is_published(self) -> None:
        sync.write_metrics(self.path, 1_000.0, success=True)
        metrics = self.read()
        self.assertEqual(metrics["cinetrack_catalog_sync_success"], "1")
        self.assertEqual(metrics["cinetrack_catalog_sync_timestamp_seconds"], "1000")

    def test_a_failed_run_is_published(self) -> None:
        sync.write_metrics(self.path, 1_000.0, success=False)
        self.assertEqual(self.read()["cinetrack_catalog_sync_success"], "0")

    def test_nothing_is_left_half_written(self) -> None:
        sync.write_metrics(self.path, 1_000.0, success=True)
        self.assertEqual([p.name for p in self.dir.iterdir()], ["catalog_sync.prom"])

    def test_an_unwritable_metrics_file_does_not_fail_the_sync(self) -> None:
        blocked = self.dir / "not-a-directory"
        blocked.write_text("")
        sync.write_metrics(blocked / "catalog_sync.prom", 1_000.0, success=True)


if __name__ == "__main__":
    unittest.main()
