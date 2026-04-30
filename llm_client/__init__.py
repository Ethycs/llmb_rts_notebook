"""
llm_client — headless driver for llm_kernel.

Public API:
    boot_minimal_kernel(**kwargs) -> KernelConnection
    KernelConnection
    ship_envelope(conn, envelope, *, timeout) -> dict
    collect_snapshots(conn, *, until) -> list[dict]

Lint contract (PLAN-S5.0.3 §3.3):
    llm_client/** may only import llm_kernel.wire.
    All other llm_kernel imports are forbidden and CI-enforced by
    tests/test_lint_boundary.py.

    Exception: llm_client/_test_helpers/** is lint-exempt (test scaffolding
    only, no production callers, package-private).
    Exception: llm_client/boot.py is the designated crossing-point where
    in-process kernel internals are imported. Isolated here intentionally.
"""

from .boot import boot_minimal_kernel, KernelConnection
from .driver import ship_envelope, collect_snapshots

__all__ = [
    "boot_minimal_kernel",
    "KernelConnection",
    "ship_envelope",
    "collect_snapshots",
]
