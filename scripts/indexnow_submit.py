#!/usr/bin/env python3
"""Tell IndexNow search engines about the public pages they have not been told of.

IndexNow is how Bing, Yandex, Seznam and the others that share it learn that a
URL exists or changed without waiting to crawl for it; Bing's index also serves
DuckDuckGo and Yahoo. Google does not take part, and reads the sitemap instead.

The pages are read from the site's own sitemaps, so this lists exactly what the
backend publishes. Each URL is submitted once: the ones already accepted are
kept in a state file, and a run sends only what is new — the titles catalogue
hydration added since. Resubmitting every page every day is what the protocol
asks clients not to do.

The key is public by design: IndexNow proves ownership by fetching it from
https://vazute.micutu.com/<key>.txt, which is frontend/public/<key>.txt.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ElementTree
from pathlib import Path

SITE = "https://vazute.micutu.com"
HOST = "vazute.micutu.com"
ENDPOINT = "https://api.indexnow.org/indexnow"
SITEMAP_NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"
# The protocol's limit per request.
BATCH = 10_000
USER_AGENT = "vazute-indexnow/1"
TIMEOUT_SECONDS = 60

ROOT_DIR = Path(__file__).resolve().parents[1]
KEY_DIR = ROOT_DIR / "frontend" / "public"
DEFAULT_STATE_DIR = Path(
    os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state")
) / "cinetrack"


def log(message: str) -> None:
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    print(f"[{stamp}] {message}", flush=True)


def find_key(directory: Path = KEY_DIR) -> str:
    """The one key file the frontend serves, checked against its own name."""
    keys = [p for p in directory.iterdir() if re.fullmatch(r"[0-9a-f]{32}\.txt", p.name)]
    if len(keys) != 1:
        raise RuntimeError(f"expected one IndexNow key file in {directory}, found {len(keys)}")
    key = keys[0].stem
    if keys[0].read_text(encoding="utf-8").strip() != key:
        raise RuntimeError(f"{keys[0]} does not contain its own key")
    return key


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        return response.read()


def locations(document: bytes) -> list[str]:
    """Every <loc> in a sitemap or sitemap index, in order."""
    root = ElementTree.fromstring(document)
    return [
        element.text.strip()
        for element in root.iter(f"{SITEMAP_NS}loc")
        if element.text and element.text.strip()
    ]


def published_urls(get=fetch, index_url: str = f"{SITE}/sitemap.xml") -> list[str]:
    """Every page URL the site's sitemaps list, without duplicates.

    Only this site's own URLs are kept: a sitemap naming another host is not
    something to vouch for under this key.
    """
    urls: list[str] = []
    seen: set[str] = set()
    for sitemap in locations(get(index_url)):
        if not sitemap.startswith(f"{SITE}/"):
            continue
        for url in locations(get(sitemap)):
            if url.startswith(f"{SITE}/") and url not in seen:
                seen.add(url)
                urls.append(url)
    if not urls:
        # An empty sitemap is a broken deploy, not a site with no pages.
        raise RuntimeError("the sitemaps listed no pages")
    return urls


def load_submitted(path: Path) -> set[str]:
    try:
        return {line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()}
    except FileNotFoundError:
        return set()


def save_submitted(path: Path, urls: set[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", dir=path.parent, prefix=f"{path.name}.tmp.", delete=False, encoding="utf-8"
    ) as tmp:
        tmp.write("\n".join(sorted(urls)) + "\n")
    os.replace(tmp.name, path)


def post(payload: dict) -> int:
    request = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8", "User-Agent": USER_AGENT},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def submit(urls: list[str], key: str, send=post) -> int:
    """Submit in protocol-sized batches; return how many were accepted.

    200 and 202 both mean accepted (202: the key is still being verified).
    Anything else stops the run, and the URLs not yet accepted stay new, so
    the next run sends them again.
    """
    accepted = 0
    for start in range(0, len(urls), BATCH):
        batch = urls[start : start + BATCH]
        status = send(
            {
                "host": HOST,
                "key": key,
                "keyLocation": f"{SITE}/{key}.txt",
                "urlList": batch,
            }
        )
        if status not in (200, 202):
            raise SubmissionError(status, accepted)
        accepted += len(batch)
    return accepted


class SubmissionError(RuntimeError):
    # What each refusal means, from the protocol's documentation.
    REASONS = {
        400: "bad request",
        403: "the key was not found at its location",
        422: "the URLs do not belong to the host, or the key does not match",
        429: "too many requests",
    }

    def __init__(self, status: int, accepted: int) -> None:
        reason = self.REASONS.get(status, "unexpected answer")
        super().__init__(f"IndexNow answered {status} ({reason}) after {accepted} accepted")
        self.accepted = accepted


def write_metrics(path: Path, started_at: float, success: bool, submitted: int) -> None:
    """Publish the run's outcome for the node exporter, atomically."""
    lines = [
        "# HELP cinetrack_indexnow_success Whether the last IndexNow submission completed.",
        "# TYPE cinetrack_indexnow_success gauge",
        f"cinetrack_indexnow_success {1 if success else 0}",
        "# HELP cinetrack_indexnow_timestamp_seconds Start time of the last IndexNow submission.",
        "# TYPE cinetrack_indexnow_timestamp_seconds gauge",
        f"cinetrack_indexnow_timestamp_seconds {int(started_at)}",
        "# HELP cinetrack_indexnow_submitted_urls URLs the last IndexNow submission sent.",
        "# TYPE cinetrack_indexnow_submitted_urls gauge",
        f"cinetrack_indexnow_submitted_urls {submitted}",
    ]
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            "w", dir=path.parent, prefix=f"{path.name}.tmp.", delete=False
        ) as tmp:
            tmp.write("\n".join(lines) + "\n")
        os.replace(tmp.name, path)
    except OSError as error:
        log(f"IndexNow metrics could not be written to {path}: {error}")


def run(state_dir: Path, dry_run: bool, get=fetch, send=post) -> int:
    """One submission; returns how many URLs were sent."""
    key = find_key()
    state_file = state_dir / "indexnow_submitted.txt"
    submitted = load_submitted(state_file)
    new = [url for url in published_urls(get) if url not in submitted]
    log(f"{len(new)} new of {len(new) + len(submitted)} known page(s)")
    if dry_run or not new:
        return 0
    try:
        accepted = submit(new, key, send)
    except SubmissionError as error:
        # Keep what was accepted before the refusal, so it is not sent twice.
        save_submitted(state_file, submitted | set(new[: error.accepted]))
        raise
    save_submitted(state_file, submitted | set(new))
    log(f"submitted {accepted} URL(s)")
    return accepted


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="count new pages, send nothing")
    parser.add_argument("--state-dir", type=Path, default=DEFAULT_STATE_DIR)
    args = parser.parse_args()

    started_at = time.time()
    submitted = 0
    success = False
    try:
        submitted = run(args.state_dir, args.dry_run)
        success = True
    except Exception as error:  # noqa: BLE001 - reported, published, and the exit code says so
        log(f"IndexNow submission failed: {error}")
    finally:
        if not args.dry_run:
            write_metrics(args.state_dir / "indexnow.prom", started_at, success, submitted)
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
