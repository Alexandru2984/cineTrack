#!/usr/bin/env python3
"""Validate security-sensitive Expo prebuild output without regexing XML/plists."""

from __future__ import annotations

import json
import plistlib
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = ROOT.parent
ANDROID_NS = "{http://schemas.android.com/apk/res/android}"
TOOLS_NS = "{http://schemas.android.com/tools}"
ASSOCIATED_PATHS = {"/reset-password", "/media", "/episodes", "/profile", "/lists"}
FINGERPRINT_PATTERN = re.compile(r"^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def only_path(pattern: str) -> Path:
    matches = list(ROOT.glob(pattern))
    require(len(matches) == 1, f"expected one {pattern}, found {len(matches)}")
    return matches[0]


def validate_android(config: dict[str, object]) -> None:
    manifest = ET.parse(ROOT / "android/app/src/main/AndroidManifest.xml").getroot()
    application = manifest.find("application")
    require(application is not None, "Android application element is missing")
    require(application.get(f"{ANDROID_NS}allowBackup") == "false", "Android backup is enabled")
    require(
        application.get(f"{ANDROID_NS}usesCleartextTraffic") == "false",
        "Android cleartext traffic is enabled",
    )

    metadata = {
        node.get(f"{ANDROID_NS}name"): node.get(f"{ANDROID_NS}value")
        for node in application.findall("meta-data")
    }
    require(metadata.get("expo.modules.updates.ENABLED") == "false", "production OTA is enabled")

    permissions = {
        node.get(f"{ANDROID_NS}name"): node.get(f"{TOOLS_NS}node")
        for node in manifest.findall("uses-permission")
    }
    require("android.permission.INTERNET" in permissions, "Android INTERNET permission is missing")
    require(permissions["android.permission.INTERNET"] is None, "INTERNET permission is malformed")
    for permission in config["android"]["blockedPermissions"]:  # type: ignore[index]
        require(permissions.get(permission) == "remove", f"blocked permission is active: {permission}")

    activities = application.findall("activity")
    main_activity = next(
        (
            activity
            for activity in activities
            if activity.get(f"{ANDROID_NS}name") == ".MainActivity"
        ),
        None,
    )
    require(main_activity is not None, "Android MainActivity is missing")
    require(main_activity.get(f"{ANDROID_NS}exported") == "true", "MainActivity cannot receive links")

    verified_links: set[tuple[str | None, str | None, str | None]] = set()
    custom_schemes: set[str | None] = set()
    for intent_filter in main_activity.findall("intent-filter"):
        actions = {
            action.get(f"{ANDROID_NS}name") for action in intent_filter.findall("action")
        }
        categories = {
            category.get(f"{ANDROID_NS}name")
            for category in intent_filter.findall("category")
        }
        for data in intent_filter.findall("data"):
            scheme = data.get(f"{ANDROID_NS}scheme")
            custom_schemes.add(scheme)
            if (
                intent_filter.get(f"{ANDROID_NS}autoVerify") == "true"
                and "android.intent.action.VIEW" in actions
                and "android.intent.category.BROWSABLE" in categories
            ):
                verified_links.add(
                    (
                        scheme,
                        data.get(f"{ANDROID_NS}host"),
                        data.get(f"{ANDROID_NS}pathPrefix"),
                    )
                )
    require(config["scheme"] in custom_schemes, "custom URL scheme is missing")
    for path in ASSOCIATED_PATHS:
        require(
            ("https", "vazute.micutu.com", path) in verified_links,
            f"verified Android app link is missing: {path}",
        )

    package = config["android"]["package"]  # type: ignore[index]
    package_path = Path(*str(package).split("."))
    require(
        (ROOT / "android/app/src/main/java" / package_path / "MainActivity.kt").is_file(),
        "generated Android package does not match app config",
    )


def read_plist(path: Path) -> dict[str, object]:
    with path.open("rb") as source:
        return plistlib.load(source)


def validate_ios(config: dict[str, object]) -> None:
    info = read_plist(only_path("ios/*/Info.plist"))
    expo = read_plist(only_path("ios/*/Supporting/Expo.plist"))
    entitlements = read_plist(only_path("ios/*/*.entitlements"))
    require(expo.get("EXUpdatesEnabled") is False, "production iOS OTA is enabled")
    require(
        expo.get("EXUpdatesRuntimeVersion") == config["version"],
        "iOS runtime version does not match the app version",
    )
    require(info.get("ITSAppUsesNonExemptEncryption") is False, "iOS encryption declaration changed")
    require("NSFaceIDUsageDescription" not in info, "unused Face ID permission is present")
    transport = info.get("NSAppTransportSecurity")
    require(isinstance(transport, dict), "iOS transport security config is missing")
    require(transport.get("NSAllowsArbitraryLoads") is False, "iOS arbitrary HTTP loads are enabled")

    schemes = {
        scheme
        for group in info.get("CFBundleURLTypes", [])
        for scheme in group.get("CFBundleURLSchemes", [])
    }
    require(config["scheme"] in schemes, "iOS custom URL scheme is missing")
    associated_domains = entitlements.get("com.apple.developer.associated-domains", [])
    require(
        "applinks:vazute.micutu.com" in associated_domains,
        "iOS associated domain is missing",
    )


def validate_android_asset_links(config: dict[str, object]) -> None:
    path = REPOSITORY_ROOT / "frontend/public/.well-known/assetlinks.json"
    with path.open(encoding="utf-8") as source:
        entries = json.load(source)
    require(isinstance(entries, list) and len(entries) > 0, "assetlinks.json has no entries")

    package = config["android"]["package"]  # type: ignore[index]
    matching = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        target = entry.get("target")
        relation = entry.get("relation")
        if (
            isinstance(target, dict)
            and isinstance(relation, list)
            and target.get("namespace") == "android_app"
            and target.get("package_name") == package
            and "delegate_permission/common.handle_all_urls" in relation
        ):
            matching.append(entry)
    require(len(matching) == 1, "assetlinks.json must contain one matching Android app")
    fingerprints = matching[0]["target"].get("sha256_cert_fingerprints", [])
    require(isinstance(fingerprints, list) and len(fingerprints) > 0, "signing fingerprint is missing")
    require(
        all(isinstance(value, str) and FINGERPRINT_PATTERN.fullmatch(value) for value in fingerprints),
        "assetlinks.json contains a malformed SHA-256 fingerprint",
    )


def main() -> None:
    with (ROOT / "app.json").open(encoding="utf-8") as source:
        config = json.load(source)["expo"]
    validate_android(config)
    validate_ios(config)
    validate_android_asset_links(config)
    print("native production config passed")


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, KeyError, OSError, plistlib.InvalidFileException, ET.ParseError) as error:
        print(f"native config validation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
