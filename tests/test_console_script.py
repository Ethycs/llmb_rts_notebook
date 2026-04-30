"""
tests/test_console_script.py — verify the `llmnb` console-script entry point.

Confirms that `llmnb --help` exits 0, listing all expected subcommands.
Uses subprocess so the test exercises the installed entry point, not just
the module import.
"""

from __future__ import annotations

import subprocess
import sys


def test_llmnb_help_exits_zero() -> None:
    """llmnb --help must exit 0."""
    result = subprocess.run(
        [sys.executable, "-m", "llm_client", "--help"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, (
        f"llmnb --help exited {result.returncode};\nstdout={result.stdout!r}\nstderr={result.stderr!r}"
    )


def test_llmnb_help_lists_subcommands() -> None:
    """llmnb --help output must mention all registered subcommands."""
    result = subprocess.run(
        [sys.executable, "-m", "llm_client", "--help"],
        capture_output=True,
        text=True,
        check=False,
    )
    output = result.stdout + result.stderr
    for sub in ("execute", "convert", "validate", "smoke", "auth", "serve"):
        assert sub in output, f"subcommand {sub!r} missing from --help output"


def test_llmnb_smoke_help_exits_zero() -> None:
    """llmnb smoke --help must exit 0 and list targets."""
    result = subprocess.run(
        [sys.executable, "-m", "llm_client", "smoke", "--help"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, (
        f"llmnb smoke --help exited {result.returncode};\n"
        f"stdout={result.stdout!r}\nstderr={result.stderr!r}"
    )
    output = result.stdout + result.stderr
    for target in ("supervisor", "metadata-writer", "paper-telephone", "pty"):
        assert target in output, f"smoke target {target!r} missing from smoke --help"
