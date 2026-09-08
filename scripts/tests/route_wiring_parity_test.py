#!/usr/bin/env python3
"""Fail when the two route trees stop registering the same modules.

`routes/mod.rs` builds the API twice. `configure` is what the integration
harness mounts; `configure_with_rate_limits` is what `main.rs` actually serves,
with governors wrapped around some scopes. Every route therefore has to be
registered in two places, and nothing makes the second registration necessary
for the first to pass.

That has already cost a shipped bug once. The unfurl routes existed, had tests,
and 404'd in production, because they were added to the harness tree and not to
the one the server builds — the comment above `unfurl::configure_rate_limited`
records it. The integration suite could not see the difference: it was testing
the other tree.

There is a test that boots the production tree and probes it, but it probes
representative route *classes* — health, an authed route, the image scopes. A
module registered in one tree and not the other still passes it. This compares
the registrations themselves.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
ROUTES = ROOT / "backend/src/routes/mod.rs"

# Registered in one tree only, on purpose, with the reason. Anything else is
# drift — including a module that stops being an exception.
ACCEPTED = {
    "unfurl": (
        "rate_limited",
        "Top-level rather than under /api, and only the served tree mounts it. "
        "Its tests build the production tree for exactly that reason, so the "
        "harness tree has nothing to gain from a second copy.",
    ),
}


def body_of(source: str, name: str) -> str:
    """The text of one `pub fn <name>(..)` body, brace-matched."""
    match = re.search(rf"pub fn {re.escape(name)}\s*\(", source)
    if not match:
        sys.exit(f"route wiring parity error: {name} is not in {ROUTES}")
    start = source.index("{", match.end())
    depth = 0
    for index in range(start, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[start : index + 1]
    sys.exit(f"route wiring parity error: {name} has no closing brace")


def modules(body: str) -> dict[str, str]:
    """Module -> which variant of its configure function this tree calls."""
    found: dict[str, str] = {}
    # `.configure(users::configure)` and `.configure(|cfg| push::configure_rate_limited(cfg, ..))`
    # both name the module and the variant; so does a bare `assets::configure_public_images(cfg, ..)`.
    for module, variant in re.findall(r"\b([a-z_]+)::configure(_[a-z_]+)?\b", body):
        found[module] = (variant or "").lstrip("_") or "plain"
    return found


def main() -> int:
    source = ROUTES.read_text(encoding="utf-8")
    harness = modules(body_of(source, "configure"))
    served = modules(body_of(source, "configure_with_rate_limits"))

    if not harness or not served:
        sys.exit("route wiring parity error: parsed no modules; the file shape changed")

    problems: list[str] = []

    for module in sorted(set(harness) | set(served)):
        in_harness, in_served = module in harness, module in served
        if in_harness and in_served:
            continue
        side = "rate_limited" if in_served else "harness"
        accepted = ACCEPTED.get(module)
        if accepted is None:
            other = "configure_with_rate_limits" if in_served else "configure"
            missing = "configure" if in_served else "configure_with_rate_limits"
            problems.append(
                f"{module} is registered in {other} but not in {missing}. "
                f"If that is deliberate, say so in ACCEPTED; otherwise the routes "
                f"exist in one tree only — which is a 404 in production, or a "
                f"module the integration suite cannot reach."
            )
        elif accepted[0] != side:
            problems.append(
                f"{module} is listed as an accepted {accepted[0]}-only module, "
                f"but it is now {side}-only. Re-read the reason before editing it."
            )

    for module in sorted(ACCEPTED):
        if module in harness and module in served:
            problems.append(
                f"{module} is in both trees now, so its ACCEPTED entry is stale; "
                f"delete it rather than leave a reason nobody has to keep true."
            )
        elif module not in harness and module not in served:
            problems.append(f"{module} is in neither tree; its ACCEPTED entry is stale.")

    if problems:
        for problem in problems:
            print(f"route wiring parity error: {problem}", file=sys.stderr)
        return 1

    shared = sorted(set(harness) & set(served))
    print(
        f"Route wiring parity checked: {len(shared)} modules in both trees, "
        f"{len(ACCEPTED)} reviewed exception(s)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
