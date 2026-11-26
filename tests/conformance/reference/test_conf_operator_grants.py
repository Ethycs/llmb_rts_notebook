"""Merge-defect regression tests for llmnb-merge-all-01 (kernel side).

Defect: after the three kernel merges, an operator can no longer re-establish
a magic-emit grant in-session on the facade-owned pty start paths.

* magic-defense (commit message; ``MetadataWriter._quarantine_persisted_trust``;
  PLAN-S5.0.1 §3.5): grants read from a file do not count; on hydrate they are
  parked under ``config.persisted`` and only an operator acting in-session
  (the ``grant_magic_emit_privilege`` operator-action intent, PLAN-S5.0.4 §2,
  certified-magic-emitter atom) makes them effective again.
* RFC-006 §6: ``operator.action`` is the Family D envelope the kernel consumes;
  its consumer is the kernel's ``OperatorBridgeServer``, which registers the
  ``operator.action`` handler on the dispatcher. ``attach_kernel_subsystems``
  built it on every start path before the merge (pty-mode and the app's
  ``boot_kernel``).
* facade-consumers moved the pty and app entry points onto ``Kernel.start``
  ("a refactor"; PLAN-kernel-facade commits 6/8, "smoke test stays green"),
  and ``Kernel.start`` builds no bridge, so the merged kernel answers every
  ``operator.action`` with "no registered handlers; dropped".

Together: a hydrated notebook's grants are quarantined (magic) and the only
way back (the operator intent) is dropped (facade), on both pty entry points.

Each test runs one real start path in one session: hydrate a hash-mode
notebook (fingerprint of the session pin) that carries a file-sourced grant,
check the grant is not live, send the in-session grant intent, shut down and
check the final ``notebook.metadata`` snapshot records the grant live under
``config.magic_emit_privileges`` (the slot PLAN-S5.0.4 §2 names).

Readiness and results are wire facts only (TCP accept, ``kernel.ready``,
``hydrate_complete`` / ``shutdown`` snapshots); nothing reads log text.
Offline: no agent is spawned and no endpoint is contacted.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

PY = sys.executable
PIN = "merge-defects-pin-2718"
AGENT, ZONE, MAGIC = "alpha", "z1", "section"


def _wait_until(pred: Callable[[], Any], timeout: float, step: float = 0.05) -> Any:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = pred()
        if value:
            return value
        time.sleep(step)
    return None


class _Receiver:
    """Extension side of the RFC-008 data plane: accept one kernel, collect frames."""

    def __init__(self) -> None:
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(1)
        self.server.settimeout(120.0)
        self.port = self.server.getsockname()[1]
        self.frames: List[Dict[str, Any]] = []
        self.eof = threading.Event()
        self.conn: Optional[socket.socket] = None
        threading.Thread(target=self._loop, name="defects-receiver", daemon=True).start()

    @property
    def address(self) -> str:
        return f"tcp:127.0.0.1:{self.port}"

    def _loop(self) -> None:
        try:
            conn, _ = self.server.accept()
        except OSError:
            self.eof.set()
            return
        self.conn = conn
        conn.settimeout(0.5)
        buf = bytearray()
        while True:
            try:
                chunk = conn.recv(65536)
            except socket.timeout:
                continue
            except OSError:
                break
            if not chunk:
                break
            buf.extend(chunk)
            while True:
                nl = buf.find(b"\n")
                if nl < 0:
                    break
                line = bytes(buf[:nl])
                del buf[: nl + 1]
                if line.strip():
                    try:
                        self.frames.append(json.loads(line.decode("utf-8")))
                    except ValueError:
                        pass
        self.eof.set()

    def wait_for(self, pred: Callable[[Dict[str, Any]], bool], timeout: float = 90.0) -> Optional[Dict[str, Any]]:
        return _wait_until(lambda: next((f for f in list(self.frames) if pred(f)), None), timeout)

    def send(self, payload: Dict[str, Any]) -> None:
        assert self.conn is not None, "kernel never connected"
        self.conn.sendall((json.dumps(payload) + "\n").encode("utf-8"))

    def close(self) -> None:
        for s in (self.conn, self.server):
            try:
                if s is not None:
                    s.close()
            except OSError:
                pass


def _is_ready(frame: Dict[str, Any]) -> bool:
    for attr in frame.get("attributes") or []:
        if isinstance(attr, dict) and attr.get("key") == "event.name":
            return (attr.get("value") or {}).get("stringValue") == "kernel.ready"
    return False


def _trigger(frame: Dict[str, Any]) -> Optional[str]:
    if (frame.get("type") or frame.get("message_type")) != "notebook.metadata":
        return None
    payload = frame.get("payload")
    return payload.get("trigger") if isinstance(payload, dict) else None


def _config(frame: Dict[str, Any]) -> Dict[str, Any]:
    return ((frame.get("payload") or {}).get("snapshot") or {}).get("config") or {}


def _live_grant(config: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    for rec in config.get("magic_emit_privileges") or []:
        if not isinstance(rec, dict):
            continue
        magics = (rec.get("scope") or {}).get("magics")
        covers = magics == "all" or (isinstance(magics, list) and MAGIC in magics)
        if rec.get("agent_id") == AGENT and rec.get("zone_id") == ZONE and covers:
            return rec
    return None


def _hydrate_with_file_grant() -> Dict[str, Any]:
    """RFC-006 §8 hydrate built from the repo's own writer: hash mode on with
    the session pin's fingerprint, and a grant for (alpha, z1) that comes from
    the file rather than from the operator."""
    from llm_kernel.capture.metadata_writer import MetadataWriter
    from llm_kernel.text.magic_hash import magic_pin_fingerprint

    scratch = MetadataWriter(autosave_interval_sec=999.0)
    try:
        snap = scratch.snapshot(trigger="save")
    finally:
        scratch.stop(emit_final=False)
    config = snap.setdefault("config", {})
    config["magic_hash_enabled"] = True
    config["magic_pin_fingerprint"] = magic_pin_fingerprint(PIN)
    config["magic_emit_privileges"] = [{
        "agent_id": AGENT, "zone_id": ZONE, "granted_at": "2026-01-01T00:00:00Z",
        "scope": {"magics": [MAGIC]},
    }]
    config.setdefault("recoverable", {})["agents"] = []
    snap["drift_log"] = []
    return {"type": "notebook.metadata", "payload": {
        "mode": "hydrate", "snapshot_version": snap.get("snapshot_version", 0),
        "snapshot": snap, "trigger": "open",
    }}


_BARRIER = "6f1c2a9e-0d4b-4c8a-9e57-3b2f1d0c7a11"


def _is_barrier_response(frame: Dict[str, Any]) -> bool:
    kind = frame.get("type") or frame.get("message_type")
    return kind == "agent_graph.response" and frame.get("correlation_id") == _BARRIER


_GRANT = {"type": "operator.action", "payload": {
    "action_type": "grant_magic_emit_privilege",
    "originating_cell_id": "c_operator",
    "parameters": {"agent_id": AGENT, "zone_id": ZONE, "scope": {"magics": [MAGIC]}},
}}


def _env(tmp_path: Path, address: str, session: str) -> Dict[str, str]:
    env = dict(os.environ)
    env.pop("LLMKERNEL_PTY_MODE", None)
    env.update({
        "LLMKERNEL_IPC_SOCKET": address,
        "LLMKERNEL_SESSION_ID": session,
        "LLMNB_OPERATOR_PIN": PIN,
        # external proxy lifecycle (BSP-001), so no proxy is started; nothing
        # contacts it because the notebook recovers no agent.
        "LLMKERNEL_LITELLM_ENDPOINT_URL": "http://127.0.0.1:9/v1",
        "PYTHONUNBUFFERED": "1",
    })
    return env


def _stderr(path: Path) -> str:
    try:
        return path.read_text(errors="replace")[-3000:]
    except OSError:
        return ""


def _session(tmp_path: Path, argv: List[str], session: str,
             after_grant: Callable[[_Receiver], None]) -> None:
    receiver = _Receiver()
    stderr_path = tmp_path / f"{session}.stderr"
    with stderr_path.open("wb") as fh:
        proc = subprocess.Popen(argv, cwd=str(tmp_path), env=_env(tmp_path, receiver.address, session),
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=fh)
    try:
        assert receiver.wait_for(_is_ready, 120.0) is not None, (
            f"{session}: no kernel.ready frame; stderr={_stderr(stderr_path)}"
        )
        receiver.send(_hydrate_with_file_grant())
        done = receiver.wait_for(lambda f: _trigger(f) == "hydrate_complete")
        assert done is not None, f"{session}: no hydrate_complete snapshot; stderr={_stderr(stderr_path)}"
        assert _live_grant(_config(done)) is None, (
            f"{session}: a grant read from the notebook file is live after hydrate; file-sourced "
            f"trust must be quarantined until the operator re-grants in-session: {_config(done)!r}"
        )
        receiver.send(_GRANT)
        # Ordering barrier: inbound frames are dispatched in arrival order on
        # one read thread, so the response to a Family C query sent after the
        # grant proves the grant envelope has been handled (RFC-006 §5: the
        # response carries the query's correlation_id).
        receiver.send({"type": "agent_graph.query", "correlation_id": _BARRIER,
                       "payload": {"query_type": "full_snapshot"}})
        assert receiver.wait_for(_is_barrier_response, 90.0) is not None, (
            f"{session}: no agent_graph.response to the barrier query; stderr={_stderr(stderr_path)}"
        )
        after_grant(receiver)
        assert receiver.eof.wait(120.0), f"{session}: the kernel did not close the socket"
        try:
            rc = proc.wait(timeout=60.0)
        except subprocess.TimeoutExpired:
            proc.kill()
            raise AssertionError(f"{session}: the kernel process did not exit")
    finally:
        receiver.close()
        if proc.poll() is None:
            proc.kill()
    assert rc == 0, _stderr(stderr_path)
    finals = [f for f in receiver.frames if _trigger(f) == "shutdown"]
    assert finals, f"{session}: no shutdown snapshot on the wire"
    config = _config(finals[-1])
    assert _live_grant(config) is not None, (
        f"{session}: the operator's in-session grant_magic_emit_privilege intent "
        f"(RFC-006 §6 operator.action, PLAN-S5.0.4 §2) was not recorded under "
        f"config.magic_emit_privileges; the quarantined file grant can never be re-established. "
        f"config={config!r}"
    )


def test_pty_mode_in_session_grant_reestablishes_quarantined_file_grant(tmp_path: Path) -> None:
    def _shutdown(receiver: _Receiver) -> None:
        receiver.send({"type": "kernel.shutdown_request", "payload": {"reason": "merge-defects"}})

    _session(tmp_path, [PY, "-m", "llm_kernel", "pty-mode"], "defects-pty", _shutdown)


_APP_SCRIPT = r'''
import sys, time
from pathlib import Path
from starlette.testclient import TestClient
release = Path(sys.argv[1])
from llm_kernel.app import app
with TestClient(app) as client:
    deadline = time.monotonic() + 240
    while not release.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
'''


def test_app_lifespan_in_session_grant_reestablishes_quarantined_file_grant(tmp_path: Path) -> None:
    release = tmp_path / "release"

    def _release(_receiver: _Receiver) -> None:
        # lifespan shutdown: Kernel.shutdown emits the final snapshot, then
        # the socket closes (BSP-004 / RFC-008 §4 step 6).
        release.write_text("go")

    try:
        _session(tmp_path, [PY, "-c", _APP_SCRIPT, str(release)], "defects-app", _release)
    finally:
        release.write_text("go")
