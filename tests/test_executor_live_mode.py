"""
tests/test_executor_live_mode.py — live-mode executor smoke (gated).

Live mode requires ANTHROPIC_API_KEY for the LiteLLM proxy boot. V1
implementation raises NotImplementedError after booting (full drive
ships in S5.0.3d). This test covers the boot path and the deferral
message; it does NOT make real API calls.

Skipped automatically when ANTHROPIC_API_KEY is missing.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest


FIXTURES = Path(__file__).parent / "fixtures"
SPAWN_AND_NOTIFY = FIXTURES / "spawn-and-notify.magic"


@pytest.mark.skipif(
    not os.environ.get("ANTHROPIC_API_KEY"),
    reason="ANTHROPIC_API_KEY not set; live-mode boot test is gated.",
)
def test_live_mode_boot_then_defers(tmp_path: Path) -> None:
    """Live mode boots the kernel + ships hydrate, then raises (V1 deferral).

    The deferral is the explicit S5.0.3d hand-off: until the async recv
    path lands, live-mode end-to-end can't complete from the driver
    side. The boot and hydrate-ship still happen so a misconfigured
    API key surfaces immediately.
    """
    from llm_client import run_notebook

    src = tmp_path / "in.magic"
    shutil.copy(SPAWN_AND_NOTIFY, src)
    with pytest.raises(NotImplementedError, match="S5.0.3d"):
        run_notebook(src, output=tmp_path / "out.llmnb", mode="live")
