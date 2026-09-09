#!/usr/bin/env python3
"""Fail when the phone's account-export schema drifts from what the server sends.

The export is the one place a client parses a server response with a schema
strict enough to reject it outright, and the two live in different languages in
different directories. They drifted, and nothing noticed for two releases:
`4c43cef` raised `format_version` to 4 when direct messages were added and left
`z.literal(3)` in the phone's schema, so every export from an installed app
failed. The phone's own test passed throughout — its fixture said 3 too, so it
was checking the client against itself rather than against the contract.

Two things are asserted, and neither is "the numbers match", because they must
not have to. A shipped app cannot be updated in step with the server, so the
phone has to read an export newer than itself:

  1. the schema names a *floor*, not an exact version, and the server is at or
     above it;
  2. the schema passes unknown keys through, so a section added on the server
     reaches the member's file instead of being silently dropped from it.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SERVER = ROOT / "backend/src/routes/users.rs"
PHONE = ROOT / "mobile/src/lib/data-export.ts"


def fail(message: str) -> None:
    print(f"account export contract error: {message}", file=sys.stderr)
    sys.exit(1)


def main() -> int:
    server_source = SERVER.read_text(encoding="utf-8")
    phone_source = PHONE.read_text(encoding="utf-8")

    served = re.search(r"format_version:\s*(\d+)\s*,", server_source)
    if not served:
        fail(f"no `format_version: N` in {SERVER.relative_to(ROOT)}")
    served_version = int(served.group(1))

    schema = re.search(
        r"const accountExportSchema\s*=(.*?)\n\nexport ",
        phone_source,
        re.S,
    )
    if not schema:
        fail(f"could not find accountExportSchema in {PHONE.relative_to(ROOT)}")
    schema_text = schema.group(1)

    if re.search(r"format_version:\s*z\.literal\(", schema_text):
        fail(
            "the phone pins format_version to an exact value. An installed app "
            "cannot be updated in step with the server, so the next bump breaks "
            "every export in the field — exactly what happened at version 4. "
            "Use a floor, e.g. z.number().int().min(N)."
        )

    floor = re.search(r"format_version:\s*z\.number\(\)\.int\(\)\.min\((\d+)\)", schema_text)
    if not floor:
        fail(
            "the phone's format_version is not a `z.number().int().min(N)` floor; "
            "this check cannot tell whether it accepts what the server sends"
        )
    floor_version = int(floor.group(1))

    if served_version < floor_version:
        fail(
            f"the server sends format_version {served_version} but the phone "
            f"requires at least {floor_version}, so every export is rejected"
        )

    if ".passthrough()" not in schema_text:
        fail(
            "the phone's export schema is not `.passthrough()`. z.object drops "
            "keys it does not name, and the parsed object is what gets written "
            "to the member's file — so any section added on the server would "
            "vanish from their own copy of their own data."
        )

    print(
        f"Account export contract checked: server at format_version "
        f"{served_version}, phone accepts {floor_version}+ and passes unknown "
        f"sections through"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
