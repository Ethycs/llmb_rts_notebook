"""Hidden F2P tests: the three kernel entry points run on the Kernel facade.

Every check is behavioral and runs the entry points as real subprocesses
from /app, instrumented through ``hook/sitecustomize.py`` (placed first on
PYTHONPATH). A process passes when exactly one facade kernel is started and
shut down, the dispatcher and metadata writer are constructed once (by the
facade, not by the entry point), the legacy ``attach_kernel_subsystems``
bootstrap is not used, and nothing observable changed: ready handshake
first, final snapshot before EOF, documented exit codes, health route,
clean thread state at exit.
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

HERE = Path(__file__).resolve().parent
HOOK_DIR = HERE / "hook"
APP = Path(os.environ.get("LLMNB_APP_ROOT", str(Path(__file__).resolve().parents[3])))
KERNEL_DIR = APP / "vendor" / "LLMKernel"
PY = sys.executable


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def _env(tmp_path: Path, **extra: str) -> Dict[str, str]:
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(HOOK_DIR)] + ([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])
    )
    env["LLMNB_HOOK_OUT"] = str(tmp_path / "hook.jsonl")
    env["PYTHONUNBUFFERED"] = "1"
    # No kernel-owned proxy: point the supervisor at an external URL so no
    # port is opened and no mitmdump/litellm process is needed offline.
    env.setdefault("LLMKERNEL_LITELLM_ENDPOINT_URL", "http://127.0.0.1:1/v1")
    env.update(extra)
    return env


def _hook_counts(tmp_path: Path) -> Dict[str, Any]:
    path = tmp_path / "hook.jsonl"
    assert path.exists(), "the instrumented process never reached interpreter exit"
    rows = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
    assert rows, "hook wrote no record"
    row = rows[-1]
    assert "hook_error" not in row, f"instrumentation failed to install: {row['hook_error']}"
    return row


def _assert_single_facade_kernel(counts: Dict[str, Any]) -> None:
    assert counts["kernel_start"] == 1, f"expected exactly one facade Kernel.start, got {counts}"
    assert counts["kernel_shutdown"] == 1, f"expected exactly one facade Kernel.shutdown, got {counts}"
    assert counts["dispatcher_init"] == 1, f"dispatcher must be built once (by the facade), got {counts}"
    assert counts["metadata_writer_init"] == 1, f"metadata writer must be built once (by the facade), got {counts}"
    assert counts["attach_kernel_subsystems"] == 0, (
        f"the legacy attach_kernel_subsystems bootstrap must not run in this mode, got {counts}"
    )


def _assert_clean_exit_threads(counts: Dict[str, Any]) -> None:
    leaked = [n for n in counts["threads_at_exit"] if not n.startswith("pydevd")]
    assert leaked == [], f"threads still alive at interpreter exit: {leaked}"


class _Receiver:
    """Extension-side end of the RFC-008 socket: accept one kernel, collect frames."""

    def __init__(self) -> None:
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(1)
        self.server.settimeout(30.0)
        self.port = self.server.getsockname()[1]
        self.frames: List[Dict[str, Any]] = []
        self.eof = threading.Event()
        self.conn: Optional[socket.socket] = None
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

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

    def wait_for(self, predicate, timeout: float = 30.0) -> Optional[Dict[str, Any]]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for frame in list(self.frames):
                if predicate(frame):
                    return frame
            time.sleep(0.05)
        return None

    def send(self, payload: Dict[str, Any]) -> None:
        assert self.conn is not None
        self.conn.sendall((json.dumps(payload) + "\n").encode("utf-8"))

    def close(self) -> None:
        for s in (self.conn, self.server):
            try:
                if s is not None:
                    s.close()
            except OSError:
                pass


def _event_name(frame: Dict[str, Any]) -> Optional[str]:
    for attr in frame.get("attributes") or []:
        if attr.get("key") == "event.name":
            return (attr.get("value") or {}).get("stringValue")
    return None


def _is_ready(frame: Dict[str, Any]) -> bool:
    return _event_name(frame) == "kernel.ready"


def _is_shutdown_snapshot(frame: Dict[str, Any]) -> bool:
    payload = frame.get("payload")
    return (
        frame.get("type") == "notebook.metadata"
        and isinstance(payload, dict)
        and payload.get("trigger") == "shutdown"
    )


def _terminate(proc: subprocess.Popen, timeout: float = 20.0) -> int:
    try:
        return proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)
        raise AssertionError("process did not exit in time after shutdown")


# --------------------------------------------------------------------------
# pty-mode
# --------------------------------------------------------------------------
def test_pty_mode_runs_on_one_facade_kernel(tmp_path: Path) -> None:
    """``python -m llm_kernel pty-mode``: one facade kernel, ready frame first,
    shutdown snapshot still reaches the extension before EOF, clean exit."""
    receiver = _Receiver()
    env = _env(
        tmp_path,
        LLMKERNEL_IPC_SOCKET=receiver.address,
        LLMKERNEL_SESSION_ID="hidden-pty-session",
    )
    env.pop("LLMKERNEL_PTY_MODE", None)
    stderr_path = tmp_path / "kernel.stderr"
    with stderr_path.open("wb") as stderr_fh:
        proc = subprocess.Popen(
            [PY, "-m", "llm_kernel", "pty-mode"], cwd=str(tmp_path), env=env,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=stderr_fh,
        )
    try:
        ready = receiver.wait_for(_is_ready, timeout=60.0)
        assert ready is not None, "no kernel.ready frame"
        assert receiver.frames and _is_ready(receiver.frames[0]), (
            f"kernel.ready must be the first frame; got {receiver.frames[:2]!r}"
        )
        # Let the subsystems come up, then ask for an orderly shutdown the
        # RFC-006 way (kernel.shutdown_request handled by the dispatcher).
        receiver.wait_for(lambda f: "dispatcher started" in str(f.get("body", {}).get("stringValue", "")), timeout=30.0)
        receiver.send({"type": "kernel.shutdown_request", "payload": {}})
        assert receiver.eof.wait(timeout=60.0), "kernel did not close the socket after shutdown_request"
        rc = _terminate(proc)
    finally:
        receiver.close()
        if proc.poll() is None:
            proc.kill()
    assert rc == 0, stderr_path.read_text(errors="replace")[-2000:]
    snapshots = [f for f in receiver.frames if _is_shutdown_snapshot(f)]
    assert len(snapshots) == 1, f"expected exactly one shutdown snapshot on the wire, got {len(snapshots)}"
    typed = [f for f in receiver.frames if "type" in f]
    assert typed and _is_shutdown_snapshot(typed[-1]), (
        "the shutdown snapshot must be the last envelope on the wire; "
        f"last typed envelope was {typed[-1] if typed else None!r}"
    )
    counts = _hook_counts(tmp_path)
    _assert_single_facade_kernel(counts)
    _assert_clean_exit_threads(counts)


def test_pty_mode_shutdown_on_peer_eof(tmp_path: Path) -> None:
    """Closing the extension side still shuts the kernel down cleanly with
    exit code 0 and a single facade lifecycle."""
    receiver = _Receiver()
    env = _env(tmp_path, LLMKERNEL_IPC_SOCKET=receiver.address, LLMKERNEL_SESSION_ID="hidden-pty-eof")
    env.pop("LLMKERNEL_PTY_MODE", None)
    with (tmp_path / "kernel.stderr").open("wb") as stderr_fh:
        proc = subprocess.Popen(
            [PY, "-m", "llm_kernel", "pty-mode"], cwd=str(tmp_path), env=env,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=stderr_fh,
        )
    try:
        assert receiver.wait_for(_is_ready, timeout=60.0) is not None
        receiver.wait_for(lambda f: "dispatcher started" in str(f.get("body", {}).get("stringValue", "")), timeout=30.0)
        receiver.close()
        rc = _terminate(proc)
    finally:
        if proc.poll() is None:
            proc.kill()
    assert rc == 0
    counts = _hook_counts(tmp_path)
    _assert_single_facade_kernel(counts)
    _assert_clean_exit_threads(counts)


@pytest.mark.parametrize(
    "env_override,expected",
    [
        ({"LLMKERNEL_IPC_SOCKET": None}, 2),
        ({"LLMKERNEL_IPC_SOCKET": "tcp:127.0.0.1:1"}, 3),
    ],
)
def test_pty_mode_exit_codes_unchanged(tmp_path: Path, env_override: Dict[str, Optional[str]], expected: int) -> None:
    env = _env(tmp_path)
    for k, v in env_override.items():
        if v is None:
            env.pop(k, None)
        else:
            env[k] = v
    proc = subprocess.run(
        [PY, "-m", "llm_kernel", "pty-mode"], cwd=str(tmp_path), env=env,
        stdin=subprocess.DEVNULL, capture_output=True, timeout=120,
    )
    assert proc.returncode == expected, proc.stderr.decode(errors="replace")[-1000:]
    counts = _hook_counts(tmp_path)
    assert counts["kernel_start"] == 0, "no kernel may start when the wire cannot come up"


# --------------------------------------------------------------------------
# serve (TCP)
# --------------------------------------------------------------------------
def _spawn_serve(tmp_path: Path, token: str) -> "tuple[subprocess.Popen, str, int]":
    env = _env(tmp_path, LLMNB_AUTH_TOKEN=token)
    proc = subprocess.Popen(
        [PY, "-u", "-m", "llm_kernel", "serve", "--transport", "tcp",
         "--bind", "127.0.0.1:0", "--auth-token-env", "LLMNB_AUTH_TOKEN"],
        cwd=str(tmp_path), env=env,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    assert proc.stderr is not None
    deadline = time.monotonic() + 90.0
    banner = ""
    while time.monotonic() < deadline:
        line = proc.stderr.readline().decode(errors="replace")
        if not line:
            if proc.poll() is not None:
                raise AssertionError(f"serve exited early rc={proc.returncode}")
            continue
        banner += line
        if "listening on" in line:
            host_port = line.split("listening on", 1)[1].split(";", 1)[0].strip()
            host, port = host_port.rsplit(":", 1)
            return proc, host, int(port)
    proc.kill()
    raise AssertionError(f"serve never reported listening; stderr={banner!r}")


def _drain_stderr(proc: subprocess.Popen) -> None:
    def _pump() -> None:
        try:
            while proc.stderr and proc.stderr.readline():
                pass
        except Exception:
            pass
    threading.Thread(target=_pump, daemon=True).start()


def test_serve_runs_on_one_facade_kernel(tmp_path: Path) -> None:
    """``python -m llm_kernel serve``: handshake/token behavior unchanged, one
    facade kernel for the process lifetime, clean SIGINT shutdown."""
    sys.path.insert(0, str(APP))
    from llm_client.transport import tcp as tcp_transport  # the repo's own driver

    token = "hidden-token-" + os.urandom(4).hex()
    proc, host, port = _spawn_serve(tmp_path, token)
    _drain_stderr(proc)
    try:
        with pytest.raises(Exception) as excinfo:
            tcp_transport.connect(bind=f"{host}:{port}", token="wrong-" + token, timeout=20.0)
        assert "auth_failed" in repr(excinfo.value) or getattr(excinfo.value, "reason", "") == "auth_failed"
        conn = tcp_transport.connect(bind=f"{host}:{port}", token=token, timeout=20.0)
        try:
            conn.send({"type": "heartbeat.extension", "payload": {}})
            time.sleep(0.5)
            conn.send({"type": "heartbeat.extension", "payload": {}})
        finally:
            conn.close()
        # Kernel survives disconnect and accepts a fresh client. The previous
        # connection's handler may still be draining, so allow kernel_busy
        # for a few seconds before calling it a failure.
        deadline = time.monotonic() + 15.0
        while True:
            try:
                conn2 = tcp_transport.connect(bind=f"{host}:{port}", token=token, timeout=20.0)
                break
            except Exception as exc:  # noqa: BLE001 - driver raises its own hierarchy
                if getattr(exc, "reason", "") != "kernel_busy" or time.monotonic() > deadline:
                    raise
                time.sleep(0.25)
        conn2.close()
        proc.send_signal(signal.SIGINT)
        rc = _terminate(proc, timeout=40.0)
    finally:
        if proc.poll() is None:
            proc.kill()
    assert rc == 0
    counts = _hook_counts(tmp_path)
    _assert_single_facade_kernel(counts)
    _assert_clean_exit_threads(counts)


def test_serve_token_missing_still_exits_2(tmp_path: Path) -> None:
    env = _env(tmp_path)
    env.pop("LLMNB_AUTH_TOKEN", None)
    proc = subprocess.run(
        [PY, "-m", "llm_kernel", "serve", "--transport", "tcp", "--bind", "127.0.0.1:0",
         "--auth-token-env", "LLMNB_AUTH_TOKEN"],
        cwd=str(tmp_path), env=env, capture_output=True, timeout=120,
    )
    assert proc.returncode == 2
    assert _hook_counts(tmp_path)["kernel_start"] == 0


def test_llmnb_execute_connect_round_trip(tmp_path: Path) -> None:
    """The headless path: ``llmnb execute --connect`` against the serve'd
    kernel runs a notebook end to end and the kernel stays up for a second run."""
    token = "hidden-token-" + os.urandom(4).hex()
    proc, host, port = _spawn_serve(tmp_path, token)
    _drain_stderr(proc)
    nb = tmp_path / "t.llmnb"
    nb.write_text(json.dumps({
        "cells": [{"cell_type": "code", "source": "echo hello", "metadata": {}, "outputs": [], "execution_count": None}],
        "metadata": {"rts": {"layout": {}, "agents": {}, "config": {"rfc_version": "1.0.0"}, "event_log": []}},
        "nbformat": 4, "nbformat_minor": 5,
    }), encoding="utf-8")
    client_env = _env(tmp_path, LLMNB_AUTH_TOKEN=token)
    client_env.pop("LLMNB_HOOK_OUT", None)  # only the kernel process is instrumented
    try:
        for i in range(2):
            run = subprocess.run(
                [PY, "-m", "llm_client.cli", "execute", "--mode", "live",
                 "--connect", f"tcp://{host}:{port}", "--total-timeout", "60",
                 "--cell-timeout", "20", str(nb), "-o", str(tmp_path / f"out{i}.llmnb")],
                cwd=str(APP), env=client_env,
                capture_output=True, timeout=180,
            )
            assert run.returncode == 0, run.stderr.decode(errors="replace")[-1500:]
        proc.send_signal(signal.SIGINT)
        rc = _terminate(proc, timeout=40.0)
    finally:
        if proc.poll() is None:
            proc.kill()
    assert rc == 0
    counts = _hook_counts(tmp_path)
    _assert_single_facade_kernel(counts)


# --------------------------------------------------------------------------
# uvicorn app
# --------------------------------------------------------------------------
_APP_SCRIPT = r'''
import json, os, socket, sys, threading
from starlette.testclient import TestClient
srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen(1)
os.environ["LLMKERNEL_IPC_SOCKET"] = f"tcp:127.0.0.1:{srv.getsockname()[1]}"
os.environ["LLMKERNEL_SESSION_ID"] = "hidden-app-session"
os.environ.pop("LLMKERNEL_PTY_MODE", None)
frames = []
def accept():
    conn, _ = srv.accept(); conn.settimeout(0.5); buf = b""
    while True:
        try: chunk = conn.recv(65536)
        except socket.timeout: continue
        except OSError: break
        if not chunk: break
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            if line.strip():
                try: frames.append(json.loads(line))
                except ValueError: pass
threading.Thread(target=accept, daemon=True).start()
from llm_kernel.app import app
with TestClient(app) as client:
    during = client.get("/health").json()
after = TestClient(app).get("/health").json()
typed = [f for f in frames if "type" in f]
print(json.dumps({"during": during, "after": after,
                  "snapshot_last": bool(typed) and typed[-1].get("type") == "notebook.metadata"
                                   and (typed[-1].get("payload") or {}).get("trigger") == "shutdown"}))
'''


def test_uvicorn_app_lifespan_runs_on_the_facade(tmp_path: Path) -> None:
    """The FastAPI app owns one facade kernel across its lifespan: /health
    reports the session while the kernel is attached and no session after
    shutdown; the shutdown snapshot still goes out on the socket."""
    proc = subprocess.run(
        [PY, "-c", _APP_SCRIPT], cwd=str(tmp_path), env=_env(tmp_path),
        capture_output=True, timeout=180,
    )
    assert proc.returncode == 0, proc.stderr.decode(errors="replace")[-2000:]
    result = json.loads(proc.stdout.decode().strip().splitlines()[-1])
    assert result["during"]["status"] == "ok"
    assert result["during"]["kernel_session_id"] == "hidden-app-session"
    assert result["after"]["kernel_session_id"] in (None, ""), (
        "health must stop reporting a session once the kernel is shut down"
    )
    assert result["snapshot_last"], "final notebook.metadata snapshot must be the last envelope on the wire"
    counts = _hook_counts(tmp_path)
    _assert_single_facade_kernel(counts)
    _assert_clean_exit_threads(counts)
