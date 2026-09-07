#!/usr/bin/env python3
"""The application role must carry time budgets; the migration role must not.

There were none. `statement_timeout`, `lock_timeout` and
`idle_in_transaction_session_timeout` were 0 on the server and unset on every
role, so a statement that never finished held a pool connection until the
process died — twenty of those and the API answers nothing, because an HTTP
timeout does not cancel work already running in Postgres.

Asserted against the SQL the provisioning script emits rather than against a
live database, so it runs in CI: what matters is that the budgets are attached
to the role the application logs in as, and that a migration — which may
legitimately rewrite a table for minutes — is never cut off by them.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "provision_db_role.sh"
BUDGETS = ("statement_timeout", "lock_timeout", "idle_in_transaction_session_timeout")


def alter_statements(source: str) -> list[tuple[str, str]]:
    """Every `ALTER ROLE %I SET <budget>` and the role variable it targets."""
    pattern = re.compile(
        r"'ALTER ROLE %I SET (\w+) = ''[^']+''',\s*:'(\w+)'",
        re.MULTILINE,
    )
    return [(m.group(1), m.group(2)) for m in pattern.finditer(source)]


def main() -> int:
    source = SCRIPT.read_text(encoding="utf-8")
    statements = alter_statements(source)
    errors: list[str] = []

    for budget in BUDGETS:
        targets = [role for setting, role in statements if setting == budget]
        if not targets:
            errors.append(f"{budget} is not applied to any role")
            continue
        if targets != ["app_role"]:
            errors.append(f"{budget} should apply to app_role alone, found {targets}")

    # The migration role must not inherit a budget by accident.
    for setting, role in statements:
        if role == "migration_role" and setting in BUDGETS:
            errors.append(
                f"{setting} is applied to the migration role; a long migration would be killed"
            )

    if errors:
        for error in errors:
            print(f"db role budget error: {error}", file=sys.stderr)
        return 1

    print(f"db role budgets: {len(BUDGETS)} applied to the application role only")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
