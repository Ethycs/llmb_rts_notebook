"""Documented behaviour the merge touches that no other suite checks.

Companion to ``test_merge_integration.py`` (shares its rig: loopback
receiver, version probe hook, hydrate builder). Every test cites the doc
line it derives from. Behavioural only: wire frames, exit codes, the CLI's
documented K-code listing; no log wording.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

import pytest

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from test_conf_integration import (  # noqa: E402  (sibling module, same hidden tests dir)
    APP, PIN, PIN_ENV, PY, PROBE_VERSION, RFC_KEY,
    _Receiver, _assert_one_facade_kernel, _drift_rfc_keys, _drifted_block, _event_name,
    _free_port, _hook_record, _hydrate_envelope, _is_ready, _kernel_env, _metadata_trigger,
    _ready_block, _snapshot_of, _stderr_tail, _stop, _strings, _wait_until, agent_rig,  # noqa: F401
)

pytestmark = pytest.mark.timeout(420)


def _spawn_pty(tmp_path: Path, rig: Any, session: str):
    receiver = _Receiver()
    env = _kernel_env(tmp_path, rig, LLMKERNEL_IPC_SOCKET=receiver.address, LLMKERNEL_SESSION_ID=session)
    stderr_path = tmp_path / "kernel.stderr"
    with stderr_path.open("wb") as fh:
        proc = subprocess.Popen([PY, "-m", "llm_kernel", "pty-mode"], cwd=str(tmp_path), env=env,
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=fh)
    ready = receiver.wait_for(_is_ready, 120.0)
    assert ready is not None, f"no kernel.ready frame; stderr={_stderr_tail(stderr_path)}"
    return receiver, proc, stderr_path, ready


def _no_agent_rig(rig: Any) -> Any:
    """Same environment as the rig but nothing to respawn (no agent in the hydrate)."""
    return rig


def _plain_hydrate(rig: Any, ready: Dict[str, Any]) -> Dict[str, Any]:
    attrs, rfc = _ready_block(ready)
    env = _hydrate_envelope(_drifted_block(rfc, attrs["llmnb.kernel.version"]), rig)
    env["payload"]["snapshot"]["config"]["recoverable"]["agents"] = []
    return env


# ==========================================================================
# D1. pty-mode: SIGTERM is a clean shutdown with the final snapshot
# Doc: RFC-008 §4 (kernel lifecycle) step 6, and the pty_mode module
# docstring steps 3 and 11: SIGTERM -> "clean shutdown with final
# notebook.metadata snapshot", "emit a final notebook.metadata snapshot,
# close, exit 0". Existing tests cover shutdown_request and peer EOF only.
# ==========================================================================
def test_pty_sigterm_is_a_clean_shutdown_with_final_snapshot(tmp_path: Path, agent_rig) -> None:
    receiver, proc, stderr_path, ready = _spawn_pty(tmp_path, agent_rig, "doc-sigterm")
    try:
        receiver.send(_plain_hydrate(agent_rig, ready))
        assert receiver.wait_for(lambda f: _metadata_trigger(f) == "hydrate_complete", 90.0) is not None
        proc.send_signal(signal.SIGTERM)
        assert receiver.eof.wait(120.0), "kernel did not close the socket after SIGTERM"
        rc = _stop(proc)
    finally:
        receiver.close()
        if proc.poll() is None:
            proc.kill()
    assert rc == 0, _stderr_tail(stderr_path)
    typed = [f for f in receiver.frames if "type" in f]
    assert typed and _metadata_trigger(typed[-1]) == "shutdown", (
        "after SIGTERM the final notebook.metadata snapshot must be the last envelope on the wire"
    )
    _assert_one_facade_kernel(_hook_record(tmp_path, proc.pid), "pty-mode SIGTERM")


# ==========================================================================
# D2. pty-mode: SIGINT interrupts, it does not shut down
# Doc: RFC-008 §4 step 5 and pty_mode docstring step 3: SIGINT is "interrupt
# running operation"; the read loop emits the kernel.interrupt_handled
# LogRecord on the data plane (event.name attribute, RFC-008 §4).
# ==========================================================================
def test_pty_sigint_emits_interrupt_handled_and_keeps_running(tmp_path: Path, agent_rig) -> None:
    receiver, proc, stderr_path, ready = _spawn_pty(tmp_path, agent_rig, "doc-sigint")
    try:
        receiver.send(_plain_hydrate(agent_rig, ready))
        assert receiver.wait_for(lambda f: _metadata_trigger(f) == "hydrate_complete", 90.0) is not None
        proc.send_signal(signal.SIGINT)
        # RFC-008 names the record by its event name; this kernel's OTLP records carry the
        # event name either as the event.name attribute (kernel.ready) or as the record body.
        handled = receiver.wait_for(
            lambda f: _event_name(f) == "kernel.interrupt_handled"
            or (f.get("body") or {}).get("stringValue") == "kernel.interrupt_handled", 60.0)
        assert handled is not None, "no kernel.interrupt_handled record on the data plane after SIGINT"
        time.sleep(1.0)
        assert proc.poll() is None and not receiver.eof.is_set(), "SIGINT must not end the kernel"
        receiver.send({"type": "kernel.shutdown_request", "payload": {"reason": "doc-sigint"}})
        assert receiver.eof.wait(120.0)
        rc = _stop(proc)
    finally:
        receiver.close()
        if proc.poll() is None:
            proc.kill()
    assert rc == 0, _stderr_tail(stderr_path)


# ==========================================================================
# D3. Family E heartbeat on the facade-owned pty path
# Doc: RFC-006 §7 (Family E, v2.0.2 amendment): the kernel MUST emit
# heartbeat.kernel every 5 seconds. The facade now owns the dispatcher that
# runs the heartbeat.
# ==========================================================================
def test_pty_kernel_heartbeat_every_five_seconds(tmp_path: Path, agent_rig) -> None:
    receiver, proc, stderr_path, ready = _spawn_pty(tmp_path, agent_rig, "doc-heartbeat")
    try:
        def beats() -> List[Dict[str, Any]]:
            return [f for f in list(receiver.frames) if f.get("type") == "heartbeat.kernel"]
        assert _wait_until(lambda: len(beats()) >= 2, 30.0), (
            f"expected heartbeat.kernel frames every 5 s; got {len(beats())} in 30 s"
        )
        receiver.send({"type": "kernel.shutdown_request", "payload": {}})
        assert receiver.eof.wait(120.0)
        rc = _stop(proc)
    finally:
        receiver.close()
        if proc.poll() is None:
            proc.kill()
    assert rc == 0


# ==========================================================================
# D4. Hydrate exclusivity, and the pin never leaves the kernel process
# Doc: RFC-006 §9 "Hydrate exclusivity": at most one hydrate per session; a
# second one is rejected (no second confirmation). PLAN-S5.0.1b / metadata
# writer get_operator_pin: the pin itself is never stored in the notebook,
# only its fingerprint; magic-defense commit: "the operator pin never
# reaches an agent env". So no frame the kernel sends carries the pin.
# ==========================================================================
def test_pty_second_hydrate_rejected_and_pin_never_on_wire(tmp_path: Path, agent_rig) -> None:
    receiver, proc, stderr_path, ready = _spawn_pty(tmp_path, agent_rig, "doc-exclusive")
    try:
        first = _plain_hydrate(agent_rig, ready)
        receiver.send(first)
        assert receiver.wait_for(lambda f: _metadata_trigger(f) == "hydrate_complete", 90.0) is not None
        second = _plain_hydrate(agent_rig, ready)
        second["payload"]["snapshot"]["config"]["volatile"]["kernel"]["rfc_008_version"] = "9.9.9"
        receiver.send(second)
        time.sleep(6.0)
        confirmations = [f for f in receiver.frames if _metadata_trigger(f) == "hydrate_complete"]
        assert len(confirmations) == 1, f"a second hydrate in one session was processed ({len(confirmations)})"
        receiver.send({"type": "kernel.shutdown_request", "payload": {}})
        assert receiver.eof.wait(120.0)
        rc = _stop(proc)
    finally:
        receiver.close()
        if proc.poll() is None:
            proc.kill()
    assert rc == 0
    finals = [f for f in receiver.frames if _metadata_trigger(f) == "shutdown"]
    assert finals
    assert "rfc_008_version" not in _drift_rfc_keys(_snapshot_of(finals[-1]).get("drift_log") or []), (
        "the rejected second hydrate still reached drift detection"
    )
    leaked = [s for s in _strings(receiver.frames) if PIN in s]
    assert not leaked, f"the operator pin appeared on the wire: {leaked[:2]!r}"


# ==========================================================================
# D5. `llmnb validate` classifies plain magics in a hash-mode notebook
# Doc: llm_client/cli/validate.py module docstring (PLAN-S5.0.3 §6.1):
# K33/K35 advisories are printed as warnings and do not change the exit
# code; notebook magic-defense commit: "validate.py ... parse under the
# writer's hash-mode context so a plain @@spawn in a hash-mode notebook is
# body text"; PLAN-S5.0.1b §3.5 (hash mode honoured only with the matching
# in-session pin).
# ==========================================================================
def _hash_mode_notebook(path: Path) -> None:
    from llm_kernel.text.magic_hash import magic_hash, magic_pin_fingerprint

    rts = {
        "config": {"magic_hash_enabled": True, "magic_pin_fingerprint": magic_pin_fingerprint(PIN)},
        "cells": {
            "c_stamped": {"text": f"@@{magic_hash(PIN, 'spawn')}:spawn alpha\ndo the task", "kind": "spawn", "outputs": []},
            "c_smuggled": {"text": "@@spawn beta\nsmuggled", "kind": "spawn", "outputs": []},
        },
    }
    path.write_text(json.dumps({"cells": [], "metadata": {"rts": rts}, "nbformat": 4, "nbformat_minor": 5}),
                    encoding="utf-8")


def _validate(path: Path, pin: str | None) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env.pop(PIN_ENV, None)
    env.pop("LLMNB_HOOK_OUT", None)
    if pin is not None:
        env[PIN_ENV] = pin
    return subprocess.run([PY, "-m", "llm_client.cli", "validate", str(path)], cwd=str(APP), env=env,
                          capture_output=True, text=True, timeout=120)


def test_llmnb_validate_flags_plain_magic_only_with_the_session_pin(tmp_path: Path) -> None:
    from llm_kernel.text.cell_text import K35_PLAIN_MAGIC_IN_HASH_MODE as K35

    nb = tmp_path / "hash-mode.llmnb"
    _hash_mode_notebook(nb)
    with_pin = _validate(nb, PIN)
    assert with_pin.returncode == 0, with_pin.stderr[-1500:]
    k35_lines = [l for l in with_pin.stderr.splitlines() if K35 in l]
    assert any("c_smuggled" in l for l in k35_lines), (
        f"with the session pin, the plain @@spawn in a hash-mode notebook must be reported {K35}; "
        f"stderr={with_pin.stderr[-1500:]!r}"
    )
    assert not any("c_stamped" in l for l in k35_lines), "the pin-stamped magic was reported as plain"
    without_pin = _validate(nb, None)
    assert without_pin.returncode == 0
    assert K35 not in without_pin.stderr, (
        "without the in-session pin the file's hash mode must not govern the parse"
    )


# ==========================================================================
# D7. serve: SIGINT is a graceful shutdown that leaves no agent behind
# Doc: docs/02 - Implementation/ops/validate-serve-mode.md acceptance
# criterion 8 (line 43-44): "SIGINT to the kernel -> graceful shutdown
# (final snapshot emitted, no zombie processes)" and line 75 "SIGINT graceful
# shutdown -- terminate_all + final snapshot"; docs/04 - Reference/kernel/
# architecture.md §Shutdown sequence: agents are stopped before the final
# snapshot. serve's teardown is the facade-consumers/drift conflict.
# ==========================================================================
def _pid_alive(pid: int) -> bool:
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8") as fh:
            state = fh.read().rsplit(")", 1)[1].split()[0]
        return state not in ("Z", "X")
    except (OSError, IndexError):
        return False


def test_serve_sigint_leaves_no_agent_process(tmp_path: Path, agent_rig) -> None:
    from llm_kernel.transports import pty_mode
    from test_conf_integration import _connect_with_retry

    token = "doc-token-" + os.urandom(4).hex()
    port = _free_port()
    env = _kernel_env(tmp_path, agent_rig, LLMNB_AUTH_TOKEN=token)
    stderr_path = tmp_path / "serve.stderr"
    with stderr_path.open("wb") as fh:
        proc = subprocess.Popen(
            [PY, "-u", "-m", "llm_kernel", "serve", "--transport", "tcp", "--bind", f"127.0.0.1:{port}",
             "--auth-token-env", "LLMNB_AUTH_TOKEN"],
            cwd=str(tmp_path), env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=fh)
    pid_file = agent_rig.work_dir / "agent.pid"
    try:
        conn = _connect_with_retry(port, token)
        try:
            rfc = {k: v for k, v in dict(pty_mode.RFC_VERSIONS).items() if RFC_KEY.match(k)}
            conn.send(_hydrate_envelope(_drifted_block(rfc, PROBE_VERSION), agent_rig))
            assert _wait_until(lambda: pid_file.exists() and pid_file.read_text().strip(), 90.0), (
                f"the recovered agent was never spawned; stderr={_stderr_tail(stderr_path)}"
            )
            agent_pid = int(pid_file.read_text().strip())
            assert _pid_alive(agent_pid)
        finally:
            conn.close()
        proc.send_signal(signal.SIGINT)
        rc = _stop(proc, 120.0)
    finally:
        if proc.poll() is None:
            proc.kill()
    assert rc == 0, _stderr_tail(stderr_path)
    assert _wait_until(lambda: not _pid_alive(agent_pid), 20.0), (
        "an agent the kernel spawned is still running after the kernel's SIGINT shutdown"
    )
    _assert_one_facade_kernel(_hook_record(tmp_path, proc.pid), "serve SIGINT")


# ==========================================================================
# D8. K11: an illegal proxy configuration exits 11 before any kernel starts
# Doc: docs/04 - Reference/kernel/_wiring-audit.md §3a (pty: "_PROXY_CONFIG_
# REJECTED -> return 11") and §3c (app.py lifespan exits with the rc);
# docs/03 - Blueprint/BSP-001-proxy-lifecycle.md §5: K11-K13 "exit cleanly
# with a non-zero code BEFORE the read loop"; PtyTransport.prepare docstring
# ("11 proxy configuration rejected (K11)"). The facade moved the proxy step
# into PtyTransport.prepare(), shared by pty-mode and the app.
# ==========================================================================
_APP_BOOT = r'''
from starlette.testclient import TestClient
from llm_kernel.app import app
with TestClient(app):
    pass
'''


def test_k11_proxy_config_rejected_exits_11_in_pty_and_app(tmp_path: Path) -> None:
    receiver = _Receiver()
    env = dict(os.environ)
    for key in ("LLMKERNEL_LITELLM_ENDPOINT_URL", "LLMKERNEL_PTY_MODE", "LLMKERNEL_USE_BARE"):
        env.pop(key, None)
    env.update({
        "PYTHONPATH": os.pathsep.join([str(HERE / "integration_hook")] + ([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])),
        "LLMNB_HOOK_OUT": str(tmp_path / "hook.jsonl"),
        "LLMKERNEL_PROXY_MODE": "no-such-proxy-mode",
        "LLMKERNEL_IPC_SOCKET": receiver.address,
    })
    try:
        pty = subprocess.run([PY, "-m", "llm_kernel", "pty-mode"], cwd=str(tmp_path), env=env,
                             stdin=subprocess.DEVNULL, capture_output=True, timeout=180)
    finally:
        receiver.close()
    assert pty.returncode == 11, pty.stderr.decode(errors="replace")[-1500:]
    row = _hook_record(tmp_path, -1)
    assert row["kernel_start"] == 0, f"pty-mode started a kernel despite K11: {row}"
    receiver2 = _Receiver()
    env["LLMKERNEL_IPC_SOCKET"] = receiver2.address
    try:
        app = subprocess.run([PY, "-c", _APP_BOOT], cwd=str(tmp_path), env=env,
                             stdin=subprocess.DEVNULL, capture_output=True, timeout=180)
    finally:
        receiver2.close()
    assert app.returncode == 11, app.stderr.decode(errors="replace")[-1500:]


# ==========================================================================
# D6. serve over TCP: the handshake version rules, through a real kernel
# Doc: docs/04 - Reference/atoms/protocols/wire-handshake.md (major mismatch
# -> version_mismatch_major, minor skew -> accepted with a
# minor_version_skew warning); serve_mode docstring "Kernel survives
# disconnect". drift-everywhere moved both sides' version values to the
# single source; facade-consumers moved serve onto the facade.
# ==========================================================================
def test_serve_handshake_version_rules_over_tcp(tmp_path: Path, agent_rig) -> None:
    from llm_client.transport import tcp as tcp_transport
    from test_conf_integration import _connect_with_retry

    token = "doc-token-" + os.urandom(4).hex()
    port = _free_port()
    env = _kernel_env(tmp_path, agent_rig, LLMNB_AUTH_TOKEN=token)
    stderr_path = tmp_path / "serve.stderr"
    with stderr_path.open("wb") as fh:
        proc = subprocess.Popen(
            [PY, "-u", "-m", "llm_kernel", "serve", "--transport", "tcp", "--bind", f"127.0.0.1:{port}",
             "--auth-token-env", "LLMNB_AUTH_TOKEN"],
            cwd=str(tmp_path), env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=fh)

    def connect(**kw: Any):
        deadline = time.monotonic() + 60.0
        while True:
            try:
                return tcp_transport.connect(bind=f"127.0.0.1:{port}", token=token, timeout=30.0, **kw)
            except Exception as exc:  # noqa: BLE001
                if getattr(exc, "reason", "") != "kernel_busy" or time.monotonic() > deadline:
                    raise
                time.sleep(0.25)

    try:
        _connect_with_retry(port, token).close()
        with pytest.raises(Exception) as major:
            connect(wire_version_request="2.0.0")
        assert getattr(major.value, "reason", "") == "version_mismatch_major", repr(major.value)
        skew = connect(wire_version_request="1.1.0")
        try:
            assert "minor_version_skew" in list(getattr(skew, "handshake_warnings", []) or []), (
                "a minor wire-version skew must be accepted with a minor_version_skew warning"
            )
        finally:
            skew.close()
        connect().close()  # and the kernel still accepts a default client afterwards
        proc.send_signal(signal.SIGINT)
        rc = _stop(proc, 90.0)
    finally:
        if proc.poll() is None:
            proc.kill()
    assert rc == 0, _stderr_tail(stderr_path)
