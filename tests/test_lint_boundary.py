"""
tests/test_lint_boundary.py — enforce llm_client → llm_kernel.wire import boundary.

Rule (PLAN-S5.0.3 §3.3 + docs/atoms/discipline/wire-as-public-api.md):
    Every .py file under llm_client/ may only import from llm_kernel.wire.
    Any import of the form ``llm_kernel.<X>`` where X is not "wire" and
    does not start with "wire." is a lint violation.

Exemptions:
    llm_client/_test_helpers/**  — test scaffolding; exempt by design.
    llm_client/boot.py           — designated crossing-point for in-process
                                   kernel internals (V1); violation is
                                   intentional and documented in boot.py.

Both exemptions are listed explicitly in EXEMPT_FILES below so that adding
a NEW file to either category requires an explicit decision here.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

# Root of the llm_client package (absolute).
LLMCLIENT_ROOT = Path(__file__).parent.parent / "llm_client"

# Files/dirs explicitly exempted from the lint boundary.
# Paths are relative to LLMCLIENT_ROOT.
EXEMPT_PATTERNS: list[str] = [
    "_test_helpers",   # test scaffolding (package-private)
    "boot.py",         # designated in-process crossing-point (V1)
]

# Regex: matches any llm_kernel import that is NOT llm_kernel.wire[...].
_FORBIDDEN = re.compile(r"llm_kernel\.(?!wire(\.|$))")


def _is_exempt(rel: Path) -> bool:
    parts = rel.parts
    return any(pat in (parts[0] if parts else "") or pat == str(rel) for pat in EXEMPT_PATTERNS)


def _extract_import_strings(source: str) -> list[str]:
    """Return all module strings imported in ``source`` (best-effort AST parse)."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return []
    modules: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                modules.append(alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                modules.append(node.module)
    return modules


def test_no_forbidden_llm_kernel_imports() -> None:
    """All llm_client/ files (except exemptions) must only import llm_kernel.wire."""
    violations: list[str] = []

    for py_file in sorted(LLMCLIENT_ROOT.rglob("*.py")):
        rel = py_file.relative_to(LLMCLIENT_ROOT)
        if _is_exempt(rel):
            continue

        source = py_file.read_text(encoding="utf-8", errors="replace")
        for module in _extract_import_strings(source):
            if _FORBIDDEN.search(module):
                violations.append(f"{rel}: imports '{module}'")

    assert not violations, (
        "Lint boundary violated — llm_client files may only import "
        "llm_kernel.wire (not other llm_kernel internals):\n"
        + "\n".join(f"  {v}" for v in violations)
    )


def test_exempt_files_exist() -> None:
    """Sanity check: the exempted paths actually exist under llm_client/."""
    for pat in EXEMPT_PATTERNS:
        candidate = LLMCLIENT_ROOT / pat
        assert candidate.exists(), (
            f"Exempt path {pat!r} does not exist under llm_client/. "
            "Update EXEMPT_PATTERNS if the file was renamed or removed."
        )
