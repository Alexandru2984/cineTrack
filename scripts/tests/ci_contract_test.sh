#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

python3 - "$ROOT_DIR" <<'PY'
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
ci_path = root / ".github/workflows/ci.yml"
ci = ci_path.read_text(encoding="utf-8")


def fail(message: str) -> None:
    raise SystemExit(f"CI contract error: {message}")


def require(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


workflow_paths = sorted((root / ".github/workflows").glob("*.yml"))
for workflow_path in workflow_paths:
    workflow = workflow_path.read_text(encoding="utf-8")
    for line_number, line in enumerate(workflow.splitlines(), start=1):
        match = re.search(r"\buses:\s*([^\s#]+)", line)
        if match is None:
            continue
        reference = match.group(1)
        require(
            re.fullmatch(r"[^@]+@[0-9a-f]{40}", reference) is not None,
            f"{workflow_path.relative_to(root)}:{line_number} must pin {reference!r} to a full commit SHA",
        )

    checkout_count = len(re.findall(r"uses:\s*actions/checkout@", workflow))
    hardened_checkout_count = len(re.findall(r"persist-credentials:\s*false", workflow))
    require(
        checkout_count == hardened_checkout_count,
        f"{workflow_path.relative_to(root)} must disable persisted credentials for every checkout",
    )

dependency_review = (root / ".github/workflows/dependency-review.yml").read_text(encoding="utf-8")
require("  pull_request:\n" in dependency_review, "dependency review must run on pull requests")
require("  push:\n" not in dependency_review, "dependency review cannot compare a plain push")
require("fail-on-severity: moderate" in dependency_review, "dependency review must reject MODERATE findings")
require(
    "fail-on-scopes: runtime, development" in dependency_review,
    "dependency review must cover build-time dependencies as well as runtime packages",
)
require(
    "retry-on-snapshot-warnings: true" in dependency_review,
    "dependency review must tolerate delayed dependency snapshots",
)

local_gate = (root / "scripts/run_tests.sh").read_text(encoding="utf-8")
require(
    re.search(
        r'PLAYWRIGHT_IMAGE="mcr\.microsoft\.com/playwright:[^"@]+@sha256:[0-9a-f]{64}"',
        local_gate,
    )
    is not None,
    "the local browser runtime must be pinned to an immutable Playwright image",
)
require(
    '--volume "$ROOT_DIR:/repo:ro"' in local_gate,
    "the Playwright container must not be able to modify the repository",
)
require(
    "run_containerized_playwright npm run test:e2e" in local_gate
    and "run_containerized_playwright npm run test:e2e:pwa" in local_gate,
    "the mocked and PWA browser suites must use the reproducible runtime",
)

job_names = (
    "backend",
    "integration",
    "frontend",
    "mobile",
    "operations",
    "e2e",
    "e2e-realstack",
    "rust-audit",
    "container-security",
    "ci-gate",
)
for index, job_name in enumerate(job_names):
    start = ci.find(f"  {job_name}:\n")
    require(start >= 0, f"missing {job_name!r} job")
    later_starts = [
        ci.find(f"  {candidate}:\n", start + 1)
        for candidate in job_names[index + 1 :]
    ]
    end_candidates = [candidate for candidate in later_starts if candidate >= 0]
    end = min(end_candidates) if end_candidates else len(ci)
    require("timeout-minutes:" in ci[start:end], f"{job_name!r} must have an explicit timeout")

require(
    "cargo test --test api_tests -- --ignored --test-threads=1" in ci,
    "PostgreSQL integration tests must remain serial",
)
require(
    "Database query-plan regressions" in ci
    and 'BENCH_DB_PORT=5433 ../bench/db/explain_hot_queries.sh "$bench_user_id"' in ci,
    "CI must reject regressed plans on the seeded PostgreSQL dataset",
)
require("cargo audit --ignore" not in ci, "CI must not suppress RustSec advisories")
require(
    "cargo audit --ignore" not in local_gate,
    "the local gate must not suppress RustSec advisories",
)
for image in ("backend", "frontend"):
    require(
        f'--output "${{GITHUB_WORKSPACE}}/artifacts/sbom/{image}.cdx.json"' in ci,
        f"the {image} CycloneDX SBOM must be written to the workspace",
    )
require('--format cyclonedx' in ci, "release images must produce CycloneDX SBOMs")
require('[[ ! -s "$sbom" ]]' in ci, "empty release SBOMs must fail CI clearly")
require("if-no-files-found: error" in ci, "missing release evidence must fail CI")
require(
    "name: release-sboms-${{ github.sha }}" in ci,
    "release evidence must be tied to its source commit",
)

gate_start = ci.find("  ci-gate:\n")
gate = ci[gate_start:]
for dependency in job_names[:-1]:
    require(f"      - {dependency}\n" in gate, f"CI Gate must depend on {dependency!r}")
require("permissions: {}" in gate, "CI Gate must not receive a repository token")
require(
    ".value.result != \"success\"" in gate,
    "CI Gate must reject every non-successful required job",
)

auth_form = (root / "mobile/src/components/auth-form.tsx").read_text(encoding="utf-8")
smoke = (root / "mobile/maestro/unauthenticated-smoke.yaml").read_text(encoding="utf-8")
require(
    'testID="auth-accept-terms"' in auth_form,
    "the terms checkbox must expose a stable native test identifier",
)
switch = smoke.find('id: "auth-switch-mode"')
terms = smoke.find('id: "auth-accept-terms"')
create = smoke.find('- tapOn: "Create account"')
require(
    -1 < switch < terms < create,
    "the registration smoke test must accept the terms before submitting",
)

print("CI security and smoke-test contracts passed")
PY
