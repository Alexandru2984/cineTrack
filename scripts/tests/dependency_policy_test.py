#!/usr/bin/env python3

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "check_dependency_policy.py"
SPEC = importlib.util.spec_from_file_location("dependency_policy", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
policy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(policy)


class DependencyPolicyTests(unittest.TestCase):
    def test_only_reviewed_license_expressions_are_approved(self) -> None:
        self.assertFalse(policy.license_is_approved("GPL-3.0-or-later"))
        self.assertFalse(policy.license_is_approved("AGPL-3.0 OR GPL-3.0"))
        self.assertTrue(policy.license_is_approved("(BSD-3-Clause OR GPL-2.0)"))
        self.assertTrue(policy.license_is_approved("LGPL-3.0-or-later"))
        self.assertFalse(policy.license_is_approved("LicenseRef-Proprietary"))

    def test_lockfiles_require_registry_integrity_and_license_metadata(self) -> None:
        original_root = policy.ROOT
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                lock = root / "package-lock.json"
                lock.write_text(
                    json.dumps(
                        {
                            "lockfileVersion": 3,
                            "packages": {
                                "": {"name": "private-app"},
                                "node_modules/good": {
                                    "version": "1.0.0",
                                    "license": "MIT",
                                    "resolved": "https://registry.npmjs.org/good/-/good-1.0.0.tgz",
                                    "integrity": "sha512-example",
                                },
                                "node_modules/bad": {
                                    "version": "2.0.0",
                                    "license": "GPL-3.0-only",
                                    "resolved": "http://packages.invalid/bad.tgz",
                                    "integrity": "sha1-example",
                                },
                            },
                        }
                    ),
                    encoding="utf-8",
                )
                policy.ROOT = root
                errors = policy.validate_lockfile(lock)
        finally:
            policy.ROOT = original_root

        self.assertEqual(len(errors), 3)
        self.assertTrue(any("unapproved license" in error for error in errors))
        self.assertTrue(any("unapproved package source" in error for error in errors))
        self.assertTrue(any("missing SHA-512 integrity" in error for error in errors))


class DependabotGroupingTests(unittest.TestCase):
    """Postgres must never arrive as an automated image bump.

    A Postgres major cannot be rolled out by swapping the tag: the server
    refuses to start on a data directory written by an older major, and
    production holds a live volume with the whole watch history in it. The
    ecosystem already ignores its majors; grouping the other images made it
    possible to lose that by writing `patterns: ["*"]` and nothing else, which
    would sweep Postgres into a batch nobody reads line by line.
    """

    def setUp(self) -> None:
        import yaml

        config = Path(__file__).resolve().parents[2] / ".github/dependabot.yml"
        self.updates = yaml.safe_load(config.read_text(encoding="utf-8"))["updates"]

    def _compose(self) -> dict:
        for update in self.updates:
            if update["package-ecosystem"] == "docker-compose":
                return update
        self.fail("the docker-compose ecosystem is no longer configured")

    def test_postgres_is_excluded_from_every_group(self) -> None:
        compose = self._compose()
        for name, group in (compose.get("groups") or {}).items():
            self.assertIn(
                "postgres",
                group.get("exclude-patterns") or [],
                f"group {name!r} could sweep up a Postgres bump",
            )

    def test_postgres_major_updates_stay_ignored(self) -> None:
        compose = self._compose()
        ignored = {
            entry["dependency-name"]: entry.get("update-types") or []
            for entry in compose.get("ignore") or []
        }
        self.assertIn("postgres", ignored)
        self.assertIn("version-update:semver-major", ignored["postgres"])

    def test_the_rust_image_is_not_grouped(self) -> None:
        # A Rust bump also needs RUST_TOOLCHAIN moved in the workflow, so it has
        # to stay reviewable on its own rather than inside a batch of tags.
        for update in self.updates:
            if update["package-ecosystem"] == "docker" and update["directory"] == "/backend":
                self.assertFalse(
                    update.get("groups"),
                    "the Rust compiler image must keep its own pull request",
                )
                return
        self.fail("the backend docker ecosystem is no longer configured")


if __name__ == "__main__":
    unittest.main()
