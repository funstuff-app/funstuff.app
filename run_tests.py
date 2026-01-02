#!/usr/bin/env python3
"""
Run unit tests with per-test ✓/✗ output (instead of unittest's "... ok").
"""

from __future__ import annotations

import sys
import unittest
import os
import subprocess
from pathlib import Path


def _colors_enabled(stream) -> bool:
    # Respect https://no-color.org/
    if os.getenv("NO_COLOR") is not None:
        return False
    if os.getenv("TERM") == "dumb":
        return False
    try:
        return bool(getattr(stream, "isatty", lambda: False)())
    except Exception:
        return False


class _C:
    GREEN = "\x1b[32m"
    RED = "\x1b[31m"
    YELLOW = "\x1b[33m"
    DIM = "\x1b[2m"
    RESET = "\x1b[0m"


class CheckmarkResult(unittest.TextTestResult):
    def addSuccess(self, test):
        super().addSuccess(test)
        if _colors_enabled(self.stream):
            self.stream.writeln(f"{_C.GREEN}✓{_C.RESET} {test.id()}")
        else:
            self.stream.writeln(f"✓ {test.id()}")

    def addFailure(self, test, err):
        super().addFailure(test, err)
        if _colors_enabled(self.stream):
            self.stream.writeln(f"{_C.RED}✗{_C.RESET} {test.id()}")
        else:
            self.stream.writeln(f"✗ {test.id()}")

    def addError(self, test, err):
        super().addError(test, err)
        if _colors_enabled(self.stream):
            self.stream.writeln(f"{_C.RED}✗{_C.RESET} {test.id()} {_C.DIM}(error){_C.RESET}")
        else:
            self.stream.writeln(f"✗ {test.id()} (error)")

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        if _colors_enabled(self.stream):
            self.stream.writeln(
                f"{_C.YELLOW}↷{_C.RESET} {test.id()} {_C.DIM}(skipped: {reason}){_C.RESET}"
            )
        else:
            self.stream.writeln(f"↷ {test.id()} (skipped: {reason})")


class CheckmarkRunner(unittest.TextTestRunner):
    resultclass = CheckmarkResult  # type: ignore[assignment]


def main() -> int:
    suite = unittest.defaultTestLoader.discover("tests", pattern="test_*.py")
    runner = CheckmarkRunner(verbosity=0)
    result = runner.run(suite)
    ok = result.wasSuccessful()

    # JS unit tests (navigation engine). Uses Node's built-in test runner.
    # Keep this optional but on by default when node is available.
    try:
        js_tests = sorted(str(p) for p in Path("dashboard/tests").rglob("*.test.cjs"))
        if not js_tests:
            js_tests = sorted(str(p) for p in Path("dashboard/tests").rglob("*.test.js"))
        if not js_tests:
            return 0 if ok else 1

        p = subprocess.run(
            ["node", "--test", *js_tests],
            check=False,
            stdout=sys.stdout,
            stderr=sys.stderr,
        )
        if p.returncode != 0:
            ok = False
    except FileNotFoundError:
        # Node not installed; skip JS tests.
        pass

    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())


