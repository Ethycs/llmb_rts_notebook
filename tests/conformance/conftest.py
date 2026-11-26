"""Fixtures private to the notebook-side conformance suite."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _conformance_env(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:  # noqa: ANN001
    """No operator pin or kernel identity leaks in from the shell; no
    kernel-owned proxy is started by anything under test."""
    monkeypatch.setenv("LLMKERNEL_LITELLM_ENDPOINT_URL", "http://127.0.0.1:1/v1")
    # Lifecycle diagnostics markers go to the test's tmp dir, not the repo.
    monkeypatch.setenv("LLMNB_E2E_MARKER_FILE", str(tmp_path / "kernel-markers.jsonl"))
    for name in ("LLMNB_OPERATOR_PIN", "LLMKERNEL_RUN_TRACE_ID", "LLMKERNEL_IPC_SOCKET"):
        monkeypatch.delenv(name, raising=False)
