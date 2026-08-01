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


if __name__ == "__main__":
    unittest.main()
