"""llm_client.notebook — back-compat shim for llm_kernel.notebook.notebook_format.

PLAN-S5.0.5 §3.2 promotes the format converters from this module to
``llm_kernel.notebook.notebook_format`` so kernel-side magic handlers and
driver-side CLI both consume the canonical implementation. This module
remains as a thin re-export so existing imports
(``llm_client.cli.convert``, ``llm_client.executor``, third-party
consumers) keep working unchanged.

Lint contract: ``llm_kernel.notebook.notebook_format`` is in the
``_ALLOWED_KERNEL_PUBLIC`` allow-list in
``tests/test_lint_boundary.py`` alongside ``wire`` and ``cell_text``.

Removal of this shim is deferred to a future slice that migrates
internal callers; new code SHOULD import from ``llm_kernel.notebook.notebook_format``
directly.
"""

from __future__ import annotations

from llm_kernel.notebook.notebook_format import (  # noqa: F401  (re-exports)
    LLMNB_DISPLAY_NAME,
    LLMNB_FILE_EXTENSION,
    LLMNB_KERNEL_NAME,
    LLMNB_LANGUAGE,
    LLMNB_MIMETYPE,
    detect_format,
    ipynb_to_llmnb,
    llmnb_kernelspec_metadata,
    llmnb_language_info_metadata,
    llmnb_to_ipynb,
    llmnb_to_magic,
    magic_to_llmnb,
)

# Re-export the internal helper too — llm_client.executor uses it.
from llm_kernel.notebook.notebook_format import _layout_walk_ids  # noqa: F401


__all__ = [
    "LLMNB_DISPLAY_NAME",
    "LLMNB_FILE_EXTENSION",
    "LLMNB_KERNEL_NAME",
    "LLMNB_LANGUAGE",
    "LLMNB_MIMETYPE",
    "detect_format",
    "llmnb_kernelspec_metadata",
    "llmnb_language_info_metadata",
    "llmnb_to_magic",
    "magic_to_llmnb",
    "ipynb_to_llmnb",
    "llmnb_to_ipynb",
]
