"""
tests/test_smokes_use_driver.py — static check that __main__.py smokes
import boot_minimal_kernel from llm_client.

This is a lightweight AST-level check: it does not execute the smokes,
it just asserts the source references llm_client.boot.boot_minimal_kernel.
"""

from __future__ import annotations

import ast
from pathlib import Path

MAIN_PY = (
    Path(__file__).parent.parent
    / "vendor"
    / "LLMKernel"
    / "llm_kernel"
    / "__main__.py"
)


def _get_imports(source: str) -> list[tuple[str, str | None]]:
    """Return (module, name_or_None) for all top-level and nested imports."""
    tree = ast.parse(source)
    results: list[tuple[str, str | None]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                results.append((alias.name, None))
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                for alias in node.names:
                    results.append((node.module, alias.name))
    return results


def test_agent_supervisor_smoke_imports_driver() -> None:
    """_run_agent_supervisor_smoke must import boot_minimal_kernel."""
    source = MAIN_PY.read_text(encoding="utf-8")
    imports = _get_imports(source)
    driver_imports = [
        (mod, name) for mod, name in imports
        if "llm_client" in mod and "boot_minimal_kernel" in (name or "")
    ]
    assert driver_imports, (
        "__main__.py does not import boot_minimal_kernel from llm_client. "
        "The smokes must consume the driver (PLAN-S5.0.3b).\n"
        f"All imports found: {imports}"
    )


def test_main_py_references_llm_client() -> None:
    """__main__.py must reference llm_client somewhere (minimal sanity check)."""
    source = MAIN_PY.read_text(encoding="utf-8")
    assert "llm_client" in source, (
        "__main__.py has no reference to llm_client. "
        "Smokes must be refactored to consume the driver package."
    )
