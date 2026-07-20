#!/usr/bin/env python3
"""Syntax-check Python heredocs embedded in operational shell scripts."""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: check_embedded_python.py SCRIPT...")
    checked = 0
    for argument in sys.argv[1:]:
        path = Path(argument)
        source = path.read_text(encoding="utf-8")
        blocks = re.findall(r"<<'PY'\n(.*?)\nPY(?:\n|$)", source, flags=re.DOTALL)
        if not blocks:
            raise SystemExit(f"{path}: no quoted PY heredoc found")
        for index, block in enumerate(blocks, start=1):
            ast.parse(block, filename=f"{path}:heredoc-{index}")
            checked += 1
    print(f"embedded Python syntax passed ({checked} block(s))")


if __name__ == "__main__":
    main()
