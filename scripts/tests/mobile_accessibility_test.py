#!/usr/bin/env python3
"""Fail when a control on the phone cannot reach a screen reader.

React Native has no axe, so this is the equivalent of the route sweep the web
client runs: walk the source, find everything pressable, and require that each
one either announces what it is or says plainly that it is not a control.

Written after measuring. The app had 110 pressables and fourteen were neither:
five dimmed backdrops behind sheets, five wrappers that exist only to stop a tap
reaching the backdrop, and four that genuinely navigate. The first ten are not
controls to anybody and now leave the accessibility tree; the last four announce
themselves as buttons. Seven images carried no treatment at all — every one of
them sits beside the text that names it, a poster next to a title, an avatar
next to a username, a provider logo inside a pressable already labelled with the
provider's name — so they are marked decorative rather than read out twice.

It lives here rather than in Jest because it reads files. The mobile `tsconfig`
declares only the `jest` types on purpose: adding `node` so a test could import
`fs` would also let application code reach for APIs that do not exist on a
phone, and that is a poor trade for one check.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SOURCE = ROOT / "mobile/src"

PRESSABLE = re.compile(r"<(Pressable|TouchableOpacity|TouchableHighlight)\b")
IMAGE = re.compile(r"<Image\b")

# Below this, the scan has stopped finding the components rather than the app
# having lost its controls, and an empty result would pass silently.
MINIMUM_PRESSABLES = 50


def props(source: str, start: int) -> str:
    """The props of the JSX element opening at `start`.

    Brace-aware, so a `>` inside an expression like `style={({ pressed }) => …}`
    does not end the element early.
    """
    depth = 0
    for index in range(start, len(source)):
        character = source[index]
        if character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
        elif character == ">" and depth == 0:
            return source[start:index]
    return source[start:]


def scan() -> tuple[int, list[str], list[str]]:
    total = 0
    unreachable: list[str] = []
    unlabelled: list[str] = []

    for path in sorted(SOURCE.rglob("*.tsx")):
        source = path.read_text()
        where = path.relative_to(ROOT)

        for match in PRESSABLE.finditer(source):
            total += 1
            attributes = props(source, match.start())
            if "accessibilityRole" in attributes or "accessible={false}" in attributes:
                continue
            line = source[: match.start()].count("\n") + 1
            unreachable.append(f"{where}:{line}")

        for match in IMAGE.finditer(source):
            attributes = props(source, match.start())
            if any(
                marker in attributes
                for marker in ("accessibilityLabel", "accessible={false}", "alt=")
            ):
                continue
            line = source[: match.start()].count("\n") + 1
            unlabelled.append(f"{where}:{line}")

    return total, unreachable, unlabelled


def main() -> int:
    total, unreachable, unlabelled = scan()
    errors = False

    if total < MINIMUM_PRESSABLES:
        print(
            f"mobile accessibility error: only {total} pressables found, expected at "
            f"least {MINIMUM_PRESSABLES} — the scan is probably broken, not the app",
            file=sys.stderr,
        )
        errors = True

    for place in unreachable:
        print(
            f"mobile accessibility error: {place} is pressable with no "
            "accessibilityRole. Give it one, or mark it accessible={false} if it is "
            "a backdrop or a wrapper rather than a control.",
            file=sys.stderr,
        )
        errors = True

    for place in unlabelled:
        print(
            f"mobile accessibility error: {place} is an image with no "
            "accessibilityLabel. Label it, or mark it accessible={false} if the text "
            "beside it already says what it is.",
            file=sys.stderr,
        )
        errors = True

    if errors:
        return 1

    print(f"mobile accessibility: {total} pressable(s) and every image accounted for")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
