#!/usr/bin/env python3
"""Fail closed on npm lockfile licenses, registries, and integrity metadata."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCKFILES = (ROOT / "frontend/package-lock.json", ROOT / "mobile/package-lock.json")
NPM_REGISTRY = "https://registry.npmjs.org/"

# This old Jest helper omits its license field from npm metadata, but ships an
# unmodified LICENSE-MIT file. Keep the exception exact so a version change has
# to be reviewed again instead of inheriting the decision silently.
LICENSE_EXCEPTIONS = {
    ("mobile/package-lock.json", "node_modules/exit", "0.1.2"): "MIT (LICENSE-MIT)",
}

# Keep this list exact and deliberately small. A dependency introducing a new
# license expression must be reviewed and explicitly approved. The one dual
# BSD/GPL package is accepted because consumers may choose its BSD terms; GPL
# by itself is never allow-listed.
ALLOWED_LICENSE_EXPRESSIONS = {
    "(BSD-3-Clause OR GPL-2.0)",
    "(MIT OR Apache-2.0)",
    "(MIT OR CC0-1.0)",
    "0BSD",
    "Apache-2.0",
    "Apache-2.0 AND LGPL-3.0-or-later",
    "Apache-2.0 AND LGPL-3.0-or-later AND MIT",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "BlueOak-1.0.0",
    "CC-BY-4.0",
    "CC0-1.0",
    "ISC",
    "LGPL-3.0-or-later",
    "MIT",
    "MIT AND Apache-2.0",
    "MIT AND ISC",
    "MIT-0",
    "MPL-2.0",
    "Python-2.0",
    "Unlicense",
}


def license_is_approved(expression: str) -> bool:
    """Return true only for an explicitly reviewed SPDX expression."""
    normalized = " ".join(expression.split())
    return normalized in ALLOWED_LICENSE_EXPRESSIONS


def validate_lockfile(path: Path) -> list[str]:
    relative = path.relative_to(ROOT).as_posix()
    data = json.loads(path.read_text(encoding="utf-8"))
    errors: list[str] = []

    if data.get("lockfileVersion") != 3:
        errors.append(f"{relative}: expected lockfileVersion 3")

    packages = data.get("packages")
    if not isinstance(packages, dict):
        return [f"{relative}: packages must be an object"]

    checked = 0
    for package_path, package in packages.items():
        if package_path == "":
            continue
        if not isinstance(package, dict):
            errors.append(f"{relative}:{package_path}: package metadata must be an object")
            continue

        version = str(package.get("version", ""))
        license_expression = package.get("license")
        exception = LICENSE_EXCEPTIONS.get((relative, package_path, version))
        if not isinstance(license_expression, str) or not license_expression.strip():
            if exception is None:
                errors.append(
                    f"{relative}:{package_path}@{version}: missing license metadata"
                )
        elif not license_is_approved(license_expression):
            errors.append(
                f"{relative}:{package_path}@{version}: unapproved license {license_expression!r}"
            )

        resolved = package.get("resolved")
        if resolved is not None:
            if not isinstance(resolved, str) or not resolved.startswith(NPM_REGISTRY):
                errors.append(
                    f"{relative}:{package_path}@{version}: unapproved package source {resolved!r}"
                )
            integrity = package.get("integrity")
            if not isinstance(integrity, str) or not integrity.startswith("sha512-"):
                errors.append(
                    f"{relative}:{package_path}@{version}: missing SHA-512 integrity"
                )
        checked += 1

    print(f"{relative}: checked {checked} dependency records")
    return errors


def main() -> int:
    errors = [error for path in LOCKFILES for error in validate_lockfile(path)]
    if errors:
        for error in errors:
            print(f"dependency policy error: {error}", file=sys.stderr)
        return 1
    print("npm dependency license, source, and integrity policy passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
