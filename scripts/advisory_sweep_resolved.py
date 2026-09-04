#!/usr/bin/env python3
"""Report which advisories an `npm audit fix` actually resolved.

The sweep exists to clear advisories, but `npm audit fix --package-lock-only`
does not confine itself to them: it re-resolves the tree, so every dependency
with a newer release inside its declared range moves too. On 2026-09-04 that
produced a lockfile diff of five Expo patch bumps and not one advisory fixed —
under a commit titled "apply fixable advisories", for a mobile app that is in
Play internal testing.

Left alone it repeats daily, because the one advisory open against this
repository has no reachable fix: `decode-uri-component` is pinned by
`query-string` at `^0.2.2` and the patched release is ESM-only. So the sweep
would open a pull request of unrelated drift every morning, for ever, and the
one thing it is named after would never be in it.

Compare the advisory sets instead. Something was resolved, or the lockfile
changes get thrown away.

Usage: advisory_sweep_resolved.py <before.json> <after.json> [<before.json> ...]
Exit 0 when at least one advisory disappeared, 1 when none did, 2 when a report
could not be read — that last one is not "nothing to do" and must not be
mistaken for it.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def advisories(path: Path) -> dict[str, str]:
    """Map advisory id -> "package: title" for one `npm audit --json` report.

    A report that cannot be read is not the same as a clean one: read as clean it
    would look like every advisory had just been fixed. Exit 2 so the caller can
    tell that apart from an honest "nothing was resolved".
    """
    try:
        report = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        print(f"cannot read audit report {path}: {error}", file=sys.stderr)
        raise SystemExit(2) from error

    found: dict[str, str] = {}
    for vulnerability in report.get("vulnerabilities", {}).values():
        for via in vulnerability.get("via", []):
            # String entries only name another vulnerable package; the dict
            # entries carry the advisory itself.
            if not isinstance(via, dict):
                continue
            url = str(via.get("url", ""))
            if not url:
                continue
            found[url.rsplit("/", 1)[-1]] = (
                f"{via.get('name', '?')}: {via.get('title', '')} ({via.get('severity', '?')})"
            )
    return found


def main(argv: list[str]) -> int:
    if len(argv) < 2 or len(argv) % 2:
        print(f"usage: {Path(__file__).name} <before.json> <after.json> ...", file=sys.stderr)
        return 2

    resolved: dict[str, str] = {}
    for before_path, after_path in zip(argv[0::2], argv[1::2]):
        before = advisories(Path(before_path))
        after = advisories(Path(after_path))
        for advisory in before.keys() - after.keys():
            resolved[advisory] = before[advisory]

    if not resolved:
        print("no advisory was resolved; the lockfile moved for other reasons")
        return 1

    for advisory, description in sorted(resolved.items()):
        print(f"{advisory}  {description}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
