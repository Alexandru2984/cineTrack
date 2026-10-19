#!/usr/bin/env python3
"""What the IndexNow submission sends, and what it remembers having sent."""

from __future__ import annotations

import importlib.util
import shutil
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/indexnow_submit.py"
SPEC = importlib.util.spec_from_file_location("indexnow_submit", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
indexnow = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(indexnow)

SITE = "https://vazute.micutu.com"


def urlset(*urls: str) -> bytes:
    entries = "".join(f"<url><loc>{url}</loc></url>" for url in urls)
    return (
        '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" '
        f'xmlns:xhtml="http://www.w3.org/1999/xhtml">{entries}</urlset>'
    ).encode()


def site(*title_urls: str):
    """The site's sitemaps, as `fetch` would return them."""
    documents = {
        f"{SITE}/sitemap.xml": (
            '<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
            f"<sitemap><loc>{SITE}/sitemap-pages.xml</loc></sitemap>"
            f"<sitemap><loc>{SITE}/sitemaps/titles-ro-1.xml</loc></sitemap>"
            "<sitemap><loc>https://elsewhere.example/sitemap.xml</loc></sitemap>"
            "</sitemapindex>"
        ).encode(),
        f"{SITE}/sitemap-pages.xml": urlset(f"{SITE}/", f"{SITE}/about"),
        f"{SITE}/sitemaps/titles-ro-1.xml": urlset(*title_urls, "https://elsewhere.example/x"),
    }
    return documents.__getitem__


class Recorder:
    def __init__(self, *statuses: int) -> None:
        self.statuses = list(statuses)
        self.payloads: list[dict] = []

    def __call__(self, payload: dict) -> int:
        self.payloads.append(payload)
        return self.statuses.pop(0) if self.statuses else 200


class IndexNowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.state = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.state)
        self.state_file = self.state / "indexnow_submitted.txt"

    def test_the_repository_serves_exactly_one_valid_key(self) -> None:
        key = indexnow.find_key()
        self.assertRegex(key, r"^[0-9a-f]{32}$")

    def test_only_this_sites_pages_are_collected(self) -> None:
        urls = indexnow.published_urls(site(f"{SITE}/ro/film/550-x", f"{SITE}/"))
        self.assertEqual(urls, [f"{SITE}/", f"{SITE}/about", f"{SITE}/ro/film/550-x"])

    def test_an_empty_sitemap_is_a_failure_not_a_quiet_day(self) -> None:
        empty = {
            f"{SITE}/sitemap.xml": b'<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>'
        }
        with self.assertRaisesRegex(RuntimeError, "listed no pages"):
            indexnow.published_urls(empty.__getitem__)

    def test_each_page_is_sent_once(self) -> None:
        send = Recorder()
        sent = indexnow.run(self.state, False, site(f"{SITE}/ro/film/550-x"), send)
        self.assertEqual(sent, 3)
        payload = send.payloads[0]
        self.assertEqual(payload["host"], "vazute.micutu.com")
        self.assertEqual(payload["keyLocation"], f"{SITE}/{payload['key']}.txt")

        # A day later the hydration has added one title: only it goes out.
        send = Recorder()
        sent = indexnow.run(
            self.state, False, site(f"{SITE}/ro/film/550-x", f"{SITE}/ro/film/551-y"), send
        )
        self.assertEqual(sent, 1)
        self.assertEqual(send.payloads[0]["urlList"], [f"{SITE}/ro/film/551-y"])

        # Nothing new: nothing sent at all.
        send = Recorder()
        self.assertEqual(
            indexnow.run(self.state, False, site(f"{SITE}/ro/film/550-x", f"{SITE}/ro/film/551-y"), send),
            0,
        )
        self.assertEqual(send.payloads, [])

    def test_large_submissions_are_split_at_the_protocol_limit(self) -> None:
        urls = [f"{SITE}/ro/film/{n}" for n in range(1, indexnow.BATCH + 2)]
        send = Recorder()
        self.assertEqual(indexnow.submit(urls, "k" * 32, send), len(urls))
        self.assertEqual([len(p["urlList"]) for p in send.payloads], [indexnow.BATCH, 1])

    def test_a_refusal_keeps_the_unsent_pages_for_the_next_run(self) -> None:
        urls = [f"{SITE}/ro/film/{n}" for n in range(1, indexnow.BATCH + 2)]
        pages = site(*urls)
        with self.assertRaisesRegex(indexnow.SubmissionError, "403"):
            indexnow.run(self.state, False, pages, Recorder(200, 403))
        remembered = indexnow.load_submitted(self.state_file)
        # The first batch was accepted and is not sent again; the refused one is.
        self.assertEqual(len(remembered), indexnow.BATCH)
        send = Recorder()
        self.assertEqual(indexnow.run(self.state, False, pages, send), 3)

    def test_a_dry_run_sends_and_remembers_nothing(self) -> None:
        send = Recorder()
        self.assertEqual(indexnow.run(self.state, True, site(f"{SITE}/ro/film/550-x"), send), 0)
        self.assertEqual(send.payloads, [])
        self.assertFalse(self.state_file.exists())

    def test_the_outcome_is_published(self) -> None:
        path = self.state / "indexnow.prom"
        indexnow.write_metrics(path, 1000.0, success=False, submitted=0)
        text = path.read_text()
        self.assertIn("cinetrack_indexnow_success 0", text)
        self.assertIn("cinetrack_indexnow_timestamp_seconds 1000", text)
        self.assertEqual([p.name for p in self.state.iterdir()], ["indexnow.prom"])


if __name__ == "__main__":
    unittest.main()
