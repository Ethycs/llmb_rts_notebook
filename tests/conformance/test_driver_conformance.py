"""The driver (``llm_client``) side of the merged kernel features.

Sources: ``llm_kernel/wire/versions.py`` (the driver's TCP connect
defaults and its connection objects read the single source at call time),
``docs/04 - Reference/atoms/discipline/wire-as-public-api.md`` and
``docs/04 - Reference/atoms/protocols/wire-handshake.md`` (major mismatch
refused, minor skew proceeds), RFC-005 §"Resume-time RFC version check"
(drift on file open whichever way the kernel was started -- here the
``serve`` subprocess a driver connects to), and
``docs/06 - Roadmaps/PLAN-S5.0.1-cell-magic-injection-defense.md`` §3.5
(``llmnb validate`` and the executor classify plain magics in a hash-mode
notebook exactly as the kernel does: body + K35, only with the session pin).
"""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

from llm_kernel.text import magic_hash as MH
from llm_kernel.text.cell_text import parser_context_from_config
from llm_kernel.wire import versions as _versions

PIN = "conformance-pin-0001"
PIN_ENV = MH.OPERATOR_PIN_ENV_VAR


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class _FakeKernel:
    """Single-shot TCP peer: records the driver's handshake, answers it."""

    def __init__(self, response_payload: Dict[str, Any]) -> None:
        self.server = socket.socket()
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(1)
        self.server.settimeout(15)
        self.response_payload = response_payload
        self.request: Optional[Dict[str, Any]] = None
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    @property
    def bind(self) -> str:
        return f"127.0.0.1:{self.server.getsockname()[1]}"

    def _serve(self) -> None:
        try:
            conn, _ = self.server.accept()
        except OSError:
            return
        with conn:
            conn.settimeout(15)
            buf = b""
            while b"\n" not in buf:
                chunk = conn.recv(65536)
                if not chunk:
                    return
                buf += chunk
            self.request = json.loads(buf.split(b"\n", 1)[0])
            payload = dict(self.response_payload)
            # V1: the kernel echoes every capability the driver advertises.
            payload.setdefault("accepted_capabilities",
                               list(self.request["payload"].get("capabilities") or []))
            frame = {"type": "kernel.handshake", "payload": payload}
            conn.sendall((json.dumps(frame) + "\n").encode())
            time.sleep(0.3)

    def close(self) -> None:
        self.server.close()
        self._thread.join(timeout=5)


def _ok_payload(wire_version: str) -> Dict[str, Any]:
    return {"kernel_version": "1.0.0", "wire_version": wire_version,
            "session_id": "fake-session"}


def _kernel_env(**extra: str) -> Dict[str, str]:
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("LLMKERNEL_", "PYTEST_")) and k != PIN_ENV}
    env["LLMKERNEL_LITELLM_ENDPOINT_URL"] = "http://127.0.0.1:1/v1"
    env.update(extra)
    return env


def _kernel_block() -> Dict[str, str]:
    block = dict(_versions.RFC_VERSIONS)
    block["kernel_version"] = _versions.KERNEL_VERSION
    return block


def _type(frame: Dict[str, Any]) -> Optional[str]:
    return frame.get("type") or frame.get("message_type")


# ---------------------------------------------------------------------------
# the driver reads the kernel's single version source
# ---------------------------------------------------------------------------


def test_tcp_connect_defaults_resolve_from_the_source_at_call_time(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from llm_client.transport import tcp

    monkeypatch.setattr(_versions, "WIRE_VERSION", "3.4.0")
    monkeypatch.setattr(_versions, "CLIENT_VERSION", "0.4.2")
    monkeypatch.setattr(_versions, "KERNEL_CAPABILITIES", ["family_a", "family_q"])
    fake = _FakeKernel(_ok_payload("3.1.0"))
    try:
        conn = tcp.connect(bind=fake.bind, token="t0k", timeout=10)
        conn.close()
    finally:
        fake.close()
    payload = (fake.request or {})["payload"]
    assert payload["wire_version"] == "3.4.0"
    assert payload["client_version"] == "0.4.2"
    assert payload["capabilities"] == ["family_a", "family_q"]
    assert payload["auth"] == {"scheme": "bearer", "token": "t0k"}
    # Same major as the (overridden) source -> accepted; the connection
    # reports the kernel's wire version.
    assert conn.wire_version == "3.1.0"


def test_tcp_connect_refuses_a_kernel_with_another_wire_major(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from llm_client.transport import tcp

    monkeypatch.setattr(_versions, "WIRE_VERSION", "3.0.0")
    fake = _FakeKernel(_ok_payload("2.9.0"))
    try:
        with pytest.raises(tcp.TcpVersionMismatchError):
            tcp.connect(bind=fake.bind, token="t0k", timeout=10)
    finally:
        fake.close()


def test_unix_transport_connection_reports_the_live_wire_version(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from llm_client.transport import unix

    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    monkeypatch.setattr(_versions, "WIRE_VERSION", "2.2.2")
    try:
        conn = unix.connect(f"tcp:127.0.0.1:{server.getsockname()[1]}", recv_timeout=5)
        try:
            assert conn.wire_version == "2.2.2"
        finally:
            conn.close()
    finally:
        server.close()


def test_in_process_boot_reports_the_live_wire_version(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    from llm_client.boot import boot_minimal_kernel

    monkeypatch.setattr(_versions, "WIRE_VERSION", "1.9.0")
    conn = boot_minimal_kernel(work_dir=tmp_path)
    try:
        assert conn.wire_version == "1.9.0"
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# a driver talking to a real `serve` subprocess
# ---------------------------------------------------------------------------


def test_driver_against_serve_gets_source_versions_and_drift_on_hydrate(tmp_path: Path) -> None:
    from llm_client.boot import connect_to_kernel

    port = _free_port()
    proc = subprocess.Popen(
        [sys.executable, "-m", "llm_kernel", "serve", "--transport", "tcp",
         "--bind", f"127.0.0.1:{port}", "--auth-token-env", "CONFORMANCE_TOKEN"],
        env=_kernel_env(CONFORMANCE_TOKEN="conformance-token"), cwd=str(tmp_path),
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    confirmation: Optional[Dict[str, Any]] = None
    try:
        deadline = time.monotonic() + 60
        conn = None
        while conn is None:
            try:
                conn = connect_to_kernel(f"127.0.0.1:{port}", token="conformance-token", timeout=30)
            except OSError:
                if time.monotonic() > deadline or proc.poll() is not None:
                    raise
                time.sleep(0.2)
        try:
            assert conn.wire_version == _versions.WIRE_VERSION
            assert conn.accepted_capabilities == _versions.kernel_capabilities()
            persisted = _kernel_block()
            major = int(_versions.RFC_VERSIONS["rfc_006_version"].split(".")[0]) + 1
            persisted["rfc_006_version"] = f"{major}.0.0"
            snap = {"schema_version": _versions.SCHEMA_VERSION,
                    "config": {"volatile": {"kernel": persisted}}, "drift_log": []}
            conn.send({"type": "notebook.metadata",
                       "payload": {"mode": "hydrate", "snapshot": snap, "trigger": "open"}})
            end = time.monotonic() + 30
            while time.monotonic() < end and confirmation is None:
                try:
                    frame = conn.recv(timeout=5)
                except Exception:  # noqa: BLE001 -- timeout: keep polling
                    continue
                if (_type(frame) == "notebook.metadata"
                        and (frame.get("payload") or {}).get("trigger") == "hydrate_complete"):
                    confirmation = frame
        finally:
            conn.close()
    finally:
        if proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
        try:
            proc.communicate(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
    assert proc.returncode == 0
    assert confirmation is not None, "serve never confirmed the hydrate"
    drift = {e["field_path"]: e for e in confirmation["payload"]["snapshot"]["drift_log"]}
    event = drift.get("config.volatile.kernel.rfc_006_version")
    assert event is not None, drift
    assert event["severity"] == "error"
    assert event["current_value"] == _versions.RFC_VERSIONS["rfc_006_version"]
    assert [p for p in drift if p.startswith("config.volatile.kernel.")] == [
        "config.volatile.kernel.rfc_006_version"]


# ---------------------------------------------------------------------------
# client-side parsing honours the notebook's hash mode
# ---------------------------------------------------------------------------


def _hash_mode_notebook(path: Path, cell_texts: Dict[str, str]) -> Path:
    from llm_kernel.notebook import notebook_format  # noqa: F401 -- format owner

    cells = {cid: {"text": text, "kind": "agent"} for cid, text in cell_texts.items()}
    nb = {
        "nbformat": 4, "nbformat_minor": 5,
        "metadata": {"rts": {
            "schema_version": _versions.SCHEMA_VERSION,
            "config": {"magic_hash_enabled": True,
                       "magic_pin_fingerprint": MH.magic_pin_fingerprint(PIN)},
            "cells": cells,
            "layout": {"tree": {"id": "root", "type": "workspace",
                                "children": [{"id": c, "type": "cell"} for c in cells]}},
        }},
        "cells": [],
    }
    path.write_text(json.dumps(nb), encoding="utf-8")
    return path


def _validate(path: Path, capsys: pytest.CaptureFixture[str]) -> tuple:
    from llm_client.cli.__main__ import main

    rc = main(["validate", str(path)])
    captured = capsys.readouterr()
    return rc, captured.out, captured.err


def test_validate_classifies_plain_magic_as_k35_body_in_a_hash_mode_notebook(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    stamped = f"@@{MH.magic_hash(PIN, 'spawn')}:spawn alpha task:\"x\"\nhello"
    path = _hash_mode_notebook(tmp_path / "hash.llmnb", {
        "c_plain": "@@spawn alpha task:\"x\"\nhello",
        "c_stamped": stamped,
    })
    monkeypatch.setenv(PIN_ENV, PIN)
    rc, out, err = _validate(path, capsys)
    assert rc == 0, err
    assert "c_plain: K35" in err
    assert "c_stamped" not in err
    # Without the in-session pin the file cannot switch hash mode on.
    monkeypatch.delenv(PIN_ENV)
    rc, out, err = _validate(path, capsys)
    assert rc == 0, err
    assert "K35" not in err
    # A pin that does not reproduce the fingerprint is not the operator's.
    monkeypatch.setenv(PIN_ENV, "someone-elses-pin-99")
    rc, out, err = _validate(path, capsys)
    assert "K35" not in err


def test_executor_derives_envelopes_under_the_notebook_hash_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from llm_client import executor

    config = {"magic_hash_enabled": True,
              "magic_pin_fingerprint": MH.magic_pin_fingerprint(PIN)}
    plain = {"kind": "section", "text": "@@section Intro"}
    stamped = {"kind": "section",
               "text": f"@@{MH.magic_hash(PIN, 'section')}:section Intro"}

    def derive(record: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        return executor._derive_cell_envelope(  # noqa: SLF001
            "c1", record, session_id="s", ordinal=0,
            parser_context=parser_context_from_config(config),
        )

    monkeypatch.setenv(PIN_ENV, PIN)
    assert derive(plain) is None  # plain @@section is body in hash mode
    env = derive(stamped)
    assert env is not None and env["type"] == "operator.action"
    monkeypatch.delenv(PIN_ENV)
    assert derive(plain) is not None  # legacy parse without the session pin
