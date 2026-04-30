"""
llm_client — headless driver for llm_kernel.

Public API:
    boot_minimal_kernel(**kwargs) -> KernelConnection
    KernelConnection
    ship_envelope(conn, envelope, *, timeout) -> dict
    collect_snapshots(conn, *, until) -> list[dict]

Lint contract (PLAN-S5.0.3 §3.3 + S5.0.3c amendment):
    llm_client/** may only import the kernel-public surface:
        * llm_kernel.wire     — envelope schemas, tool catalog, version constants
        * llm_kernel.cell_text — pure parser (S5.0.3c amendment; see header
          of llm_client/notebook.py for justification)
    All other llm_kernel imports are forbidden and CI-enforced by
    tests/test_lint_boundary.py.

    Exception: llm_client/_test_helpers/** is lint-exempt (test scaffolding
    only, no production callers, package-private).
    Exception: llm_client/boot.py is the designated crossing-point where
    in-process kernel internals are imported. Isolated here intentionally.
"""

from .boot import boot_minimal_kernel, KernelConnection
from .driver import ship_envelope, collect_snapshots
from .executor import run_notebook, ExecutionResult
from .notebook import (
    detect_format,
    llmnb_to_magic,
    magic_to_llmnb,
    ipynb_to_llmnb,
)

__all__ = [
    "boot_minimal_kernel",
    "KernelConnection",
    "ship_envelope",
    "collect_snapshots",
    "run_notebook",
    "ExecutionResult",
    "detect_format",
    "llmnb_to_magic",
    "magic_to_llmnb",
    "ipynb_to_llmnb",
]
