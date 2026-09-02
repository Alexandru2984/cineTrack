#!/usr/bin/env python3
"""Fail when the two clients disagree about a type they both name.

The clients keep separate copies of the API types, and copies drift. Comparing
whole files would be wrong — the web client has moderation types the phone has
no screen for, and the phone has its own session shape — so this compares only
the types both declare, by field name.

It exists because they had already drifted: `HistoryItem` on the web was
missing `tmdb_id`, `season_number` and `episode_number`, three fields the
backend has always sent, and `User` on the phone marked `email_verified` and
`two_factor_enabled` optional when the backend declares both non-null. Neither
broke a build. Both were a client describing a contract that was not the one
the server serves.

Field *types* are deliberately not compared. `string | null` against
`string|null` is a formatting difference, and a check that argues about
whitespace is one people start ignoring.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
CLIENTS = {
    "web": ROOT / "frontend/src/types/index.ts",
    "mobile": ROOT / "mobile/src/types/index.ts",
}

# Differences that are meant, with the reason. Anything not listed here is drift.
#
# `User` earns its place: the phone restores a session from disk, and a cache
# written by an older build has no `email_verified` or `two_factor_enabled`, so
# marking them required there fails to typecheck in `session.ts` and four
# fixtures. The API does always send them — the real defect is one name serving
# both the response and the persisted cache, which is a refactor and not a
# parity problem. Until that split exists, the phone is right to be cautious.
ACCEPTED = {
    "User": "the phone's copy also describes a session restored from disk",
}


def declarations(path: Path) -> dict[str, set[str]]:
    """Exported interfaces and their field names, comments stripped."""
    source = path.read_text()
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    source = re.sub(r"^\s*//.*$", "", source, flags=re.M)

    found: dict[str, set[str]] = {}
    for match in re.finditer(r"export interface (\w+)[^{]*\{", source):
        name = match.group(1)
        depth = 0
        start = match.end() - 1
        for index in range(start, len(source)):
            if source[index] == "{":
                depth += 1
            elif source[index] == "}":
                depth -= 1
                if depth == 0:
                    break
        body = source[start : index + 1]
        # `field?:` and `field:` both count; the optional marker is compared too,
        # because optional-versus-required is exactly the drift that hid here.
        found[name] = set(re.findall(r"(\w+\??)\s*:", body))
    return found


def main() -> int:
    declared = {client: declarations(path) for client, path in CLIENTS.items()}
    web, mobile = declared["web"], declared["mobile"]

    errors: list[str] = []
    unused_exceptions = set(ACCEPTED)
    for name in sorted(set(web) & set(mobile)):
        only_web = web[name] - mobile[name]
        only_mobile = mobile[name] - web[name]
        if not only_web and not only_mobile:
            continue
        if name in ACCEPTED:
            unused_exceptions.discard(name)
            continue
        detail = []
        if only_web:
            detail.append(f"only on web: {', '.join(sorted(only_web))}")
        if only_mobile:
            detail.append(f"only on mobile: {', '.join(sorted(only_mobile))}")
        errors.append(f"{name} differs — {'; '.join(detail)}")

    if errors:
        for error in errors:
            print(f"client type parity error: {error}", file=sys.stderr)
        print(
            "\nBoth clients describe the same API. If the backend changed, change "
            "both; if only one client needs a type, give it a name the other does "
            "not use.",
            file=sys.stderr,
        )
        return 1

    # A stale exception is an error too: it would silently excuse a future
    # difference in a type that had agreed again.
    if unused_exceptions:
        for name in sorted(unused_exceptions):
            print(
                f"client type parity error: {name} agrees now; delete its entry "
                "from ACCEPTED",
                file=sys.stderr,
            )
        return 1

    shared = len(set(web) & set(mobile))
    accepted = len(ACCEPTED)
    print(
        f"client type parity: {shared - accepted} shared interface(s) agree, "
        f"{accepted} reviewed difference(s)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
