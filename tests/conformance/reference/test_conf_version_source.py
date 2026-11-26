"""Hidden F2P tests: one source of truth for the kernel's version strings.

Name-agnostic: nothing here imports or names the module the solution
introduces.  Every observation goes through entry points that exist on
the starting code:

* ``pty_mode.RFC_VERSIONS`` / ``pty_mode.KERNEL_VERSION`` and the ready
  frame written by ``pty_mode._emit_ready_handshake``;
* ``serve_mode.KERNEL_VERSION`` / ``KERNEL_CAPABILITIES`` /
  ``_handshake_response`` / ``_validate_handshake``;
* the volatile provider exactly as the dispatcher collects it during a
  real in-process ``pty_mode.main`` boot (same harness as
  ``tests/test_pty_mode.py``), and a real hydrate round trip over the
  socket;
* ``DriftDetector().compare``, ``MetadataWriter().hydrate/snapshot``,
  the FastAPI ``/health`` route, ``llm_client.transport.tcp.connect``.

Single-source proof = in-place mutation of the shared mapping observed
on the ready frame, the provider, the handshake and the drift detector,
plus an AST scan that the semver literals live in exactly one module.
"""
from __future__ import annotations

import ast
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from unittest import mock

import pytest

APP = Path(os.environ.get("LLMNB_APP_ROOT", str(Path(__file__).resolve().parents[3])))
if str(APP) not in sys.path:
    sys.path.insert(0, str(APP))

import llm_kernel  # noqa: E402
import llm_kernel.wire as wire  # noqa: E402
from llm_kernel._internal._attrs import decode_attrs  # noqa: E402
from llm_kernel.capture.custom_messages import CustomMessageDispatcher  # noqa: E402
from llm_kernel.capture.drift_detector import DriftDetector  # noqa: E402
from llm_kernel.capture.metadata_writer import MetadataWriter  # noqa: E402
from llm_kernel.transports import pty_mode, serve_mode  # noqa: E402

KERNEL_PKG = Path(llm_kernel.__file__).resolve().parent
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")
RFC_KEY = re.compile(r"^rfc_\d{3}_version$")

#: What the ready frame emits today (the prompt: "treat the values the
#: ready frame emits today as the truth and do not change anything that
#: goes over the wire").
CANONICAL_RFC = {
    "rfc_001_version": "1.0.0",
    "rfc_002_version": "1.0.0",
    "rfc_003_version": "1.0.0",
    "rfc_004_version": "1.0.0",
    "rfc_005_version": "1.0.0",
    "rfc_006_version": "2.0.0",
    "rfc_007_version": "1.0.0",
    "rfc_008_version": "1.0.0",
}
CANONICAL_CAPS = ["family_a", "family_b", "family_c", "family_f", "family_g"]


# ---------------------------------------------------------------------------
# helpers: ready frame, provider shape, persisted snapshot
# ---------------------------------------------------------------------------
class _FrameSink:
    """Stand-in for SocketWriter: records frames passed to write_frame."""

    def __init__(self) -> None:
        self.frames: List[Dict[str, Any]] = []

    def write_frame(self, record: Dict[str, Any]) -> None:
        self.frames.append(record)


def _ready_attrs() -> Dict[str, Any]:
    sink = _FrameSink()
    pty_mode._emit_ready_handshake(sink, "sess-hidden")  # noqa: SLF001
    assert len(sink.frames) == 1, "ready handshake must write exactly one frame"
    return decode_attrs(sink.frames[0]["attributes"])


def _rfc_from_attrs(attrs: Dict[str, Any]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for key, value in attrs.items():
        if key.startswith("llmnb.kernel."):
            short = key[len("llmnb.kernel."):]
            if RFC_KEY.match(short):
                out[short] = value
    return out


def _kernel_block(provider_output: Dict[str, Any]) -> Dict[str, Any]:
    """The ``config.volatile.kernel`` fields inside a provider result.

    The pty-mode provider returns ``{"kernel": {...}}``; accept a flat
    dict too so the comparison does not depend on the shape.
    """
    inner = provider_output.get("kernel")
    if isinstance(inner, dict):
        return inner
    return provider_output


def _rfc_only(block: Dict[str, Any]) -> Dict[str, str]:
    return {k: v for k, v in block.items() if RFC_KEY.match(k)}


def _persisted(kernel_block: Dict[str, Any]) -> Dict[str, Any]:
    """Minimal persisted ``metadata.rts`` carrying a volatile kernel block."""
    return {
        "config": {"volatile": {"kernel": dict(kernel_block)}},
        "event_log": {"runs": []},
        "zone": {"run_frames": {}},
        "agents": {"nodes": [], "edges": []},
    }


def _kernel_events(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [
        e for e in events
        if str(e.get("field_path", "")).startswith("config.volatile.kernel.")
    ]


def _bump_major(version: str) -> str:
    major, rest = version.split(".", 1)
    return f"{int(major) + 1}.{rest}"


# ---------------------------------------------------------------------------
# helpers: in-process pty-mode boot (tests/test_pty_mode.py harness)
# ---------------------------------------------------------------------------
class _Receiver:
    """Bind a loopback server; accept the kernel; collect newline frames."""

    def __init__(self) -> None:
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(1)
        self.server.settimeout(20.0)
        self.port = self.server.getsockname()[1]
        self.frames: List[Dict[str, Any]] = []
        self.conn: Optional[socket.socket] = None
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    @property
    def address(self) -> str:
        return f"tcp:127.0.0.1:{self.port}"

    def _loop(self) -> None:
        try:
            conn, _ = self.server.accept()
        except (socket.timeout, OSError):
            return
        self.conn = conn
        conn.settimeout(0.2)
        buf = bytearray()
        while not self._stop.is_set():
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

    def wait_for(self, predicate: Callable[[Dict[str, Any]], bool], timeout: float = 20.0) -> Optional[Dict[str, Any]]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for frame in list(self.frames):
                if predicate(frame):
                    return frame
            time.sleep(0.02)
        return None

    def send(self, payload: Dict[str, Any]) -> None:
        assert self.conn is not None, "kernel never connected"
        self.conn.sendall((json.dumps(payload) + "\n").encode("utf-8"))

    def stop(self) -> None:
        self._stop.set()
        for s in (self.conn, self.server):
            try:
                if s is not None:
                    s.close()
            except OSError:
                pass
        self._thread.join(timeout=2)


def _event_name(frame: Dict[str, Any]) -> Optional[str]:
    for attr in frame.get("attributes") or []:
        if attr.get("key") == "event.name":
            return (attr.get("value") or {}).get("stringValue")
    return None


def _is_ready(frame: Dict[str, Any]) -> bool:
    return _event_name(frame) == "kernel.ready"


def _is_hydrate_complete(frame: Dict[str, Any]) -> bool:
    payload = frame.get("payload")
    return (
        frame.get("type") == "notebook.metadata"
        and isinstance(payload, dict)
        and payload.get("trigger") == "hydrate_complete"
    )


def _dispatcher_started(frame: Dict[str, Any]) -> bool:
    body = frame.get("body")
    text = body.get("stringValue", "") if isinstance(body, dict) else str(body or "")
    return "dispatcher started" in text


class _Boot:
    ready_attrs: Dict[str, Any]
    provider_output: Dict[str, Any]
    collect: Callable[[], Dict[str, Any]]
    drift_log: Optional[List[Dict[str, Any]]]


def _boot_pty(
    session_id: str,
    hydrate_block: Optional[Callable[[Dict[str, Any]], Dict[str, Any]]] = None,
) -> _Boot:
    """Run ``pty_mode.main`` in a thread against a loopback receiver.

    Captures the dispatcher the boot starts (via the public ``start``
    method) so the test can ask it for the current volatile config the
    way the hydrate handler does.  When ``hydrate_block`` is given it is
    called with the ready-frame attributes and must return the persisted
    ``config.volatile.kernel`` block; a real hydrate envelope is then
    sent and the ``hydrate_complete`` confirmation's ``drift_log`` is
    captured.
    """
    receiver = _Receiver()
    mp = pytest.MonkeyPatch()
    dispatchers: List[Any] = []
    providers: List[Callable[[], Dict[str, Any]]] = []
    real_start = CustomMessageDispatcher.start
    real_set = CustomMessageDispatcher.set_current_volatile_provider

    def spy_start(self: Any, *a: Any, **kw: Any) -> Any:
        dispatchers.append(self)
        return real_start(self, *a, **kw)

    def spy_set(self: Any, provider: Any, *a: Any, **kw: Any) -> Any:
        providers.append(provider)
        return real_set(self, provider, *a, **kw)

    result = _Boot()
    result.drift_log = None
    rc: Dict[str, Any] = {}
    try:
        mp.setenv(pty_mode.ENV_IPC_SOCKET, receiver.address)
        mp.setenv(pty_mode.ENV_SESSION_ID, session_id)
        mp.delenv(pty_mode.ENV_PTY_MODE, raising=False)
        mp.setenv("LLMKERNEL_LITELLM_ENDPOINT_URL",
                  os.environ.get("LLMKERNEL_LITELLM_ENDPOINT_URL") or "http://127.0.0.1:1/v1")
        mp.setattr(CustomMessageDispatcher, "start", spy_start)
        mp.setattr(CustomMessageDispatcher, "set_current_volatile_provider", spy_set)

        def runner() -> None:
            try:
                rc["rc"] = pty_mode.main([])
            except Exception as exc:  # pragma: no cover - surfaced below
                rc["exc"] = exc

        thread = threading.Thread(target=runner, daemon=True)
        thread.start()
        ready = receiver.wait_for(_is_ready, timeout=30.0)
        assert ready is not None, f"no kernel.ready frame; rc={rc!r} frames={receiver.frames[:3]!r}"
        result.ready_attrs = decode_attrs(ready["attributes"])
        assert receiver.wait_for(_dispatcher_started, timeout=20.0) is not None, "dispatcher never started"
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline and not (dispatchers or providers):
            time.sleep(0.02)
        assert dispatchers or providers, "no CustomMessageDispatcher was started by pty-mode"
        # pty-mode registers the current-volatile provider after start();
        # wait for it so the collector is not read mid-boot (race fixed
        # after it produced false failures in a Harbor job).
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline and not providers and not any(
            getattr(d, "_current_volatile_provider", None) is not None for d in dispatchers
        ):
            time.sleep(0.02)

        if dispatchers and hasattr(dispatchers[-1], "_collect_current_volatile"):
            dispatcher = dispatchers[-1]
            result.collect = lambda: dispatcher._collect_current_volatile()  # noqa: SLF001
        else:
            assert providers, "pty-mode never registered a current-volatile provider"
            provider = providers[-1]
            result.collect = lambda: dict(provider())
        result.provider_output = result.collect()

        if hydrate_block is not None:
            scratch = MetadataWriter(autosave_interval_sec=999.0)
            try:
                snap = scratch.snapshot(trigger="save")
            finally:
                scratch.stop(emit_final=False)
            snap.setdefault("config", {})
            snap["config"].setdefault("volatile", {})
            snap["config"]["volatile"]["kernel"] = hydrate_block(result.ready_attrs)
            snap["drift_log"] = []
            receiver.send({
                "type": "notebook.metadata",
                "payload": {
                    "mode": "hydrate",
                    "snapshot_version": snap.get("snapshot_version", 0),
                    "snapshot": snap,
                    "trigger": "open",
                },
            })
            done = receiver.wait_for(_is_hydrate_complete, timeout=20.0)
            assert done is not None, "no hydrate_complete confirmation on the wire"
            result.drift_log = list((done["payload"].get("snapshot") or {}).get("drift_log") or [])
    finally:
        receiver.stop()
        if "thread" in locals():
            thread.join(timeout=20)
        mp.undo()
    return result


@pytest.fixture(scope="module")
def booted() -> _Boot:
    """One real pty-mode boot shared by the read-only consistency tests."""
    return _boot_pty("hidden-vs-probe")


# ---------------------------------------------------------------------------
# helpers: source discovery for in-place mutation (name-agnostic)
# ---------------------------------------------------------------------------
def _wire_modules() -> List[Any]:
    mods = []
    for name, mod in list(sys.modules.items()):
        if mod is not None and (name == "llm_kernel.wire" or name.startswith("llm_kernel.wire.")):
            mods.append(mod)
    return mods


def _mutable_source(value: Any) -> Any:
    """Return the object to mutate for ``value`` (a dict/list reached via an old name).

    Prefer the object itself.  If a module under ``llm_kernel.wire`` (the
    public surface the prompt says both sides read from) holds an equal
    container that is *not* the same object, the old name exposes a copy
    and the wire object is the one to mutate.
    """
    equal_other = None
    for mod in _wire_modules():
        for attr in dir(mod):
            try:
                cand = getattr(mod, attr)
            except Exception:  # pragma: no cover - lazy attrs may raise
                continue
            if cand is value:
                return value
            if type(cand) is type(value) and cand == value and equal_other is None:
                equal_other = cand
    return equal_other if equal_other is not None else value


# ---------------------------------------------------------------------------
# helpers: driver loopback
# ---------------------------------------------------------------------------
def _driver_connect(token: str, **kw: Any) -> Tuple[Dict[str, Any], Tuple[Optional[str], List[str]], Any]:
    """Run ``tcp.connect`` against a thread that answers with the kernel's own handshake.

    Returns (request envelope the driver sent, ``_validate_handshake`` result
    for it, the connection object).
    """
    from llm_client.transport import tcp

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    srv.settimeout(10.0)
    port = srv.getsockname()[1]
    seen: Dict[str, Any] = {}

    def responder() -> None:
        try:
            conn, _ = srv.accept()
        except OSError:
            return
        with conn:
            conn.settimeout(10.0)
            buf = b""
            while b"\n" not in buf:
                chunk = conn.recv(65536)
                if not chunk:
                    return
                buf += chunk
            line, _ = buf.split(b"\n", 1)
            request = json.loads(line.decode("utf-8"))
            seen["request"] = request
            seen["validation"] = serve_mode._validate_handshake(request, expected_token=token)  # noqa: SLF001
            reply = serve_mode._handshake_response("sess-driver")  # noqa: SLF001
            conn.sendall((json.dumps(reply) + "\n").encode("utf-8"))
            time.sleep(0.2)

    t = threading.Thread(target=responder, daemon=True)
    t.start()
    try:
        conn = tcp.connect(bind=f"127.0.0.1:{port}", token=token, timeout=10.0, **kw)
    finally:
        t.join(timeout=10)
        srv.close()
    try:
        conn.close()
    except Exception:  # pragma: no cover - best effort
        pass
    assert "request" in seen, "the driver never sent a handshake request"
    return seen["request"], seen["validation"], conn


# ===========================================================================
# (a) consistency across every emitting site
# ===========================================================================
def test_ready_frame_rfc_versions_match_pty_mode_mapping() -> None:
    attrs = _ready_attrs()
    assert _rfc_from_attrs(attrs) == dict(pty_mode.RFC_VERSIONS)
    assert attrs["llmnb.kernel.version"] == pty_mode.KERNEL_VERSION


def test_volatile_provider_matches_ready_frame(booted: _Boot) -> None:
    """What the dispatcher collects for drift must equal what the ready frame announced."""
    block = _kernel_block(booted.provider_output)
    ready_rfc = _rfc_from_attrs(booted.ready_attrs)
    assert _rfc_only(block) == ready_rfc, (
        f"provider rfc values {_rfc_only(block)!r} differ from the ready frame {ready_rfc!r}"
    )
    assert set(_rfc_only(block)) == set(pty_mode.RFC_VERSIONS), "provider must carry every RFC key defined"
    assert block.get("kernel_version") == booted.ready_attrs["llmnb.kernel.version"]
    assert _rfc_only(block) == dict(pty_mode.RFC_VERSIONS)


def test_kernel_version_is_one_value_everywhere(booted: _Boot) -> None:
    from fastapi.testclient import TestClient
    from llm_kernel.app import app

    health = TestClient(app).get("/health").json()  # no lifespan: route only
    kv = pty_mode.KERNEL_VERSION
    assert serve_mode.KERNEL_VERSION == kv
    assert booted.ready_attrs["llmnb.kernel.version"] == kv
    assert health["kernel_version"] == kv
    assert serve_mode._handshake_response("s")["payload"]["kernel_version"] == kv  # noqa: SLF001


def test_handshake_response_matches_advertised_values() -> None:
    payload = serve_mode._handshake_response("sess-x")["payload"]  # noqa: SLF001
    assert payload["kernel_version"] == serve_mode.KERNEL_VERSION
    assert payload["wire_version"] == wire.WIRE_VERSION
    assert payload["accepted_capabilities"] == list(serve_mode.KERNEL_CAPABILITIES)
    assert payload["session_id"] == "sess-x"


def test_hydrate_accepts_own_schema_version_and_rejects_other_major() -> None:
    writer = MetadataWriter(autosave_interval_sec=999.0)
    try:
        snap = writer.snapshot(trigger="save")
    finally:
        writer.stop(emit_final=False)
    own = snap["schema_version"]
    assert SEMVER.match(own), own

    accepting = MetadataWriter(autosave_interval_sec=999.0)
    try:
        accepting.hydrate(snap)  # same major as the writer emits: accepted
    finally:
        accepting.stop(emit_final=False)

    rejecting = MetadataWriter(autosave_interval_sec=999.0)
    try:
        bad = dict(snap)
        bad["schema_version"] = _bump_major(own)
        with pytest.raises(ValueError, match=r"schema_version major"):
            rejecting.hydrate(bad)
    finally:
        rejecting.stop(emit_final=False)


def test_driver_default_handshake_is_accepted_by_the_kernel() -> None:
    request, validation, conn = _driver_connect("tok-hidden")
    assert validation == (None, []), f"kernel rejected the driver's default handshake: {validation!r}"
    payload = request["payload"]
    assert payload["wire_version"] == wire.WIRE_VERSION
    assert list(payload["capabilities"]) == list(serve_mode.KERNEL_CAPABILITIES)
    assert conn.session_id == "sess-driver"


# ===========================================================================
# (b) single source: in-place mutation propagates everywhere
# ===========================================================================
def test_mutating_rfc_mapping_reaches_ready_frame_provider_and_drift(booted: _Boot) -> None:
    target = _mutable_source(pty_mode.RFC_VERSIONS)
    key = "rfc_002_version"
    before_rfc = _rfc_from_attrs(_ready_attrs())
    old = target[key]
    new = "1.9.0"
    assert old != new
    try:
        target[key] = new
        attrs = _ready_attrs()
        assert attrs[f"llmnb.kernel.{key}"] == new, "ready frame did not see the mutated source"
        assert pty_mode.RFC_VERSIONS[key] == new, "pty_mode.RFC_VERSIONS does not reflect the source"
        current = booted.collect()
        assert _kernel_block(current)[key] == new, (
            f"dispatcher's volatile provider did not see the mutated source: {current!r}"
        )
        # Drift: a notebook persisted before the bump now drifts on exactly this key.
        events = _kernel_events(DriftDetector().compare(_persisted(before_rfc), current_kernel=current))
        assert [e["field_path"].rsplit(".", 1)[-1] for e in events] == [key], events
        assert events[0]["previous_value"] == old and events[0]["current_value"] == new
        # ...and one persisted after the bump does not.
        after = DriftDetector().compare(_persisted(_rfc_from_attrs(attrs)), current_kernel=booted.collect())
        assert _kernel_events(after) == []
    finally:
        target[key] = old
    assert _rfc_from_attrs(_ready_attrs()) == before_rfc


def test_mutating_capabilities_reaches_handshake_and_driver_defaults() -> None:
    target = _mutable_source(serve_mode.KERNEL_CAPABILITIES)
    extra = "family_hidden_zz"
    assert extra not in target
    try:
        target.append(extra)
        assert extra in serve_mode._handshake_response("s")["payload"]["accepted_capabilities"]  # noqa: SLF001
        request, validation, _ = _driver_connect("tok-caps")
        assert validation[0] is None
        assert extra in request["payload"]["capabilities"], (
            "driver's default capability list is a copy, not derived from the kernel's advertised set"
        )
    finally:
        while extra in target:
            target.remove(extra)
    assert list(serve_mode.KERNEL_CAPABILITIES) == CANONICAL_CAPS


# ===========================================================================
# (c) drift detection is alive for the kernel block
# ===========================================================================
def test_drift_zero_events_when_persisted_equals_ready_frame(booted: _Boot) -> None:
    persisted_block = dict(_rfc_from_attrs(booted.ready_attrs))
    persisted_block["kernel_version"] = booted.ready_attrs["llmnb.kernel.version"]
    events = DriftDetector().compare(_persisted(persisted_block), current_kernel=booted.provider_output)
    assert _kernel_events(events) == []


def test_drift_event_when_persisted_rfc_006_differs_in_major(booted: _Boot) -> None:
    persisted_block = dict(_rfc_from_attrs(booted.ready_attrs))
    current_006 = persisted_block["rfc_006_version"]
    persisted_block["rfc_006_version"] = _bump_major(current_006)
    events = _kernel_events(
        DriftDetector().compare(_persisted(persisted_block), current_kernel=booted.provider_output)
    )
    named = [e for e in events if e["field_path"].endswith("rfc_006_version")]
    assert named, f"no drift event for rfc_006_version; events={events!r} current={booted.provider_output!r}"
    assert named[0]["previous_value"] == persisted_block["rfc_006_version"]
    assert named[0]["current_value"] == current_006


def test_drift_event_when_persisted_rfc_008_differs(booted: _Boot) -> None:
    persisted_block = dict(_rfc_from_attrs(booted.ready_attrs))
    persisted_block["rfc_008_version"] = _bump_major(persisted_block["rfc_008_version"])
    events = _kernel_events(
        DriftDetector().compare(_persisted(persisted_block), current_kernel=booted.provider_output)
    )
    assert any(e["field_path"].endswith("rfc_008_version") for e in events), (
        f"rfc_008_version is defined but not drift-checked; events={events!r}"
    )


def test_drift_over_the_wire_identical_persisted_versions_produce_no_event() -> None:
    """Real hydrate round trip: a notebook that persisted what the ready frame announced."""
    def block(attrs: Dict[str, Any]) -> Dict[str, Any]:
        b = dict(_rfc_from_attrs(attrs))
        b["kernel_version"] = attrs["llmnb.kernel.version"]
        return b

    boot = _boot_pty("hidden-vs-hydrate-same", hydrate_block=block)
    assert boot.drift_log is not None
    assert _kernel_events(boot.drift_log) == []


def test_drift_over_the_wire_differing_persisted_rfc_version_produces_event() -> None:
    """Real hydrate round trip: a persisted rfc version that differs from the running kernel."""
    def block(attrs: Dict[str, Any]) -> Dict[str, Any]:
        b = dict(_rfc_from_attrs(attrs))
        b["rfc_006_version"] = _bump_major(b["rfc_006_version"])
        return b

    boot = _boot_pty("hidden-vs-hydrate-diff", hydrate_block=block)
    assert boot.drift_log is not None
    events = _kernel_events(boot.drift_log)
    assert any(e["field_path"].endswith("rfc_006_version") for e in events), (
        f"running kernel produced no drift event for a differing persisted rfc_006_version: {boot.drift_log!r}"
    )


# ===========================================================================
# (d) exactly one module defines the semver literals
# ===========================================================================
_NAME_HINT = re.compile(r"(VERSION|_VER$|^_VER|RFC|SCHEMA)", re.I)
_EXCLUDED_NAMES = re.compile(r"(^__version__$|^implementation_version$|TEMPLATE)", re.I)


def _name_of(target: ast.expr) -> Optional[str]:
    if isinstance(target, ast.Name):
        return target.id
    if isinstance(target, ast.Attribute):
        return target.attr
    return None


def _semver_in(node: ast.AST) -> List[str]:
    return [
        n.value for n in ast.walk(node)
        if isinstance(n, ast.Constant) and isinstance(n.value, str) and SEMVER.match(n.value)
    ]


def _version_literal_sites(py_file: Path) -> List[str]:
    """Semver literals bound to a VERSION/_VER/RFC/SCHEMA-like name or dict key."""
    tree = ast.parse(py_file.read_text(encoding="utf-8", errors="replace"), filename=str(py_file))
    hits: List[str] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            names = [n for n in (_name_of(t) for t in targets) if n]
            if not names or node.value is None:
                continue
            if not any(_NAME_HINT.search(n) and not _EXCLUDED_NAMES.search(n) for n in names):
                continue
            lits = sorted(set(_semver_in(node.value)))
            if lits:
                hits.append(f"{node.lineno}: {names[0]} = ...{lits!r}")
        elif isinstance(node, ast.Dict):
            for k, v in zip(node.keys, node.values):
                if (
                    isinstance(k, ast.Constant) and isinstance(k.value, str)
                    and _NAME_HINT.search(k.value) and not _EXCLUDED_NAMES.search(k.value)
                    and isinstance(v, ast.Constant) and isinstance(v.value, str) and SEMVER.match(v.value)
                ):
                    hits.append(f"{node.lineno}: {k.value!r}: {v.value!r}")
    return sorted(set(hits), key=lambda s: (int(s.split(":", 1)[0]), s))


def test_version_literals_live_in_exactly_one_kernel_module() -> None:
    by_module: Dict[str, List[str]] = {}
    for py in sorted(KERNEL_PKG.rglob("*.py")):
        rel = py.relative_to(KERNEL_PKG)
        if "tests" in rel.parts or rel.parts[:2] == ("wire", "schemas"):
            continue
        sites = _version_literal_sites(py)
        if sites:
            by_module[rel.as_posix()] = sites
    assert len(by_module) == 1, (
        "the kernel/RFC/wire/schema version literals must be defined in exactly one module; "
        f"found {len(by_module)}: " + json.dumps(by_module, indent=1)
    )


# ===========================================================================
# (e) pass-to-pass guards: nothing on the wire changed, old names still work
# ===========================================================================
def test_wire_public_names_and_values_unchanged() -> None:
    from llm_kernel.wire import WIRE_MAJOR, WIRE_VERSION

    assert WIRE_VERSION == "1.0.0"
    assert WIRE_MAJOR == 1
    assert pty_mode.KERNEL_VERSION == "1.0.0"
    assert dict(pty_mode.RFC_VERSIONS) == CANONICAL_RFC
    assert _rfc_from_attrs(_ready_attrs()) == CANONICAL_RFC
    assert list(serve_mode.KERNEL_CAPABILITIES) == CANONICAL_CAPS
    from llm_kernel.transports.pty_mode import KERNEL_VERSION, RFC_VERSIONS  # noqa: F401
    from llm_kernel.transports.serve_mode import KERNEL_CAPABILITIES  # noqa: F401
    from llm_kernel.capture.metadata_writer import SCHEMA_VERSION
    assert SCHEMA_VERSION == "1.0.0"


def test_driver_lint_boundary_still_passes() -> None:
    lint = APP / "tests" / "test_lint_boundary.py"
    assert lint.exists(), lint
    proc = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "-o", "addopts=", str(lint)],
        cwd=str(APP), capture_output=True, text=True, timeout=120,
    )
    assert proc.returncode == 0, proc.stdout[-2000:] + proc.stderr[-1000:]



# ===========================================================================
# Drift detection must be alive in EVERY start path, not only pty-mode.
# Each boot gets one hydrate (RFC-006 §9: one per session). The persisted
# block differs from the running kernel in rfc_006 (major) and rfc_008
# (patch) only, so one hydrate checks both "differing keys are reported"
# and "identical keys are not".
# ===========================================================================
import asyncio as _asyncio
import shutil as _shutil


def _bump(value: str, *, major: bool) -> str:
    parts = value.split(".")
    idx = 0 if major else 2
    parts[idx] = str(int(parts[idx]) + 1)
    return ".".join(parts)


def _drifted_block() -> Dict[str, str]:
    block = dict(pty_mode.RFC_VERSIONS)
    block["rfc_006_version"] = _bump(block["rfc_006_version"], major=True)
    block["rfc_008_version"] = _bump(block["rfc_008_version"], major=False)
    return block


def _hydrate_envelope(kernel_block: Dict[str, Any]) -> Dict[str, Any]:
    scratch = MetadataWriter(autosave_interval_sec=999.0)
    try:
        snap = scratch.snapshot(trigger="save")
    finally:
        scratch.stop(emit_final=False)
    snap.setdefault("config", {}).setdefault("volatile", {})["kernel"] = dict(kernel_block)
    snap["drift_log"] = []
    return {
        "type": "notebook.metadata",
        "payload": {
            "mode": "hydrate",
            "snapshot_version": snap.get("snapshot_version", 0),
            "snapshot": snap,
            "trigger": "open",
        },
    }


def _is_hydrate_done(frame: Dict[str, Any]) -> bool:
    """hydrate_complete snapshot, whether the frame is the thin v2 shape
    (``type``) or the full envelope (``message_type``)."""
    payload = frame.get("payload") if isinstance(frame, dict) else None
    return (
        (frame.get("type") or frame.get("message_type")) == "notebook.metadata"
        and isinstance(payload, dict)
        and payload.get("trigger") == "hydrate_complete"
    )


def _keys_named(events: List[Dict[str, Any]]) -> set:
    """RFC keys mentioned anywhere in the kernel-block drift events."""
    named = set()
    for ev in events:
        text = json.dumps(ev)
        for key in pty_mode.RFC_VERSIONS:
            if key in text:
                named.add(key)
    return named


def _assert_drift_matches(events: List[Dict[str, Any]], where: str) -> None:
    named = _keys_named(events)
    assert "rfc_006_version" in named, f"{where}: no drift event for the bumped rfc_006 major; events={events!r}"
    assert "rfc_008_version" in named, f"{where}: no drift event for the bumped rfc_008; events={events!r}"
    identical = set(pty_mode.RFC_VERSIONS) - {"rfc_006_version", "rfc_008_version"}
    assert not (named & identical), f"{where}: drift reported for identical keys {sorted(named & identical)}"


def _drift_log_from_sink(sink: Any, timeout: float = 10.0) -> List[Dict[str, Any]]:
    """The hydrate_complete snapshot the kernel emits carries the drift_log;
    read it from the in-process sink (same frame a client would receive)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for frame in sink.snapshot():
            if _is_hydrate_done(frame):
                return list((frame["payload"].get("snapshot") or {}).get("drift_log") or [])
        time.sleep(0.05)
    raise AssertionError("hydrate was never confirmed (no hydrate_complete snapshot emitted)")


def _stop_quietly(*objs: Any) -> None:
    for obj in objs:
        if obj is None:
            continue
        for name, kwargs in (("stop", {"emit_final": False}), ("stop", {}), ("shutdown", {}), ("close", {})):
            fn = getattr(obj, name, None)
            if callable(fn):
                try:
                    fn(**kwargs)
                    break
                except TypeError:
                    continue
                except Exception:
                    break


# --- Kernel facade (library use) --------------------------------------------
def _facade_run(tmp_path: Path, block: Dict[str, Any]):
    from llm_kernel.kernel_facade import Kernel

    async def main():
        async with Kernel(workdir=tmp_path) as k:
            dispatcher = k._dispatcher  # noqa: SLF001
            sink = k._sink  # noqa: SLF001
            assert dispatcher is not None
            current = _kernel_block(dispatcher._collect_current_volatile())  # noqa: SLF001
            dispatcher._on_comm_msg({"content": {"data": _hydrate_envelope(block)}})  # noqa: SLF001
            return current, _drift_log_from_sink(sink)

    return _asyncio.run(main())


def test_facade_mode_reports_current_values_from_the_source(tmp_path: Path) -> None:
    current, _ = _facade_run(tmp_path, dict(pty_mode.RFC_VERSIONS))
    assert _rfc_only(current) == dict(pty_mode.RFC_VERSIONS), f"facade provider: {current!r}"
    assert current.get("kernel_version") == pty_mode.KERNEL_VERSION


def test_facade_mode_drift_alive(tmp_path: Path) -> None:
    _, log = _facade_run(tmp_path, _drifted_block())
    _assert_drift_matches(log, "facade")


def test_facade_mode_identical_block_no_drift(tmp_path: Path) -> None:
    _, log = _facade_run(tmp_path, dict(pty_mode.RFC_VERSIONS))
    assert not _keys_named(log), f"facade: spurious drift {log!r}"


# --- Legacy IPython kernel (attach_kernel_subsystems) -----------------------
def _legacy_run(monkeypatch: pytest.MonkeyPatch, block: Dict[str, Any]):
    from llm_kernel._kernel_hooks import attach_kernel_subsystems
    from llm_kernel.kernel_facade import _EmbeddedKernel, _EmbeddedSink

    monkeypatch.setenv("LLMKERNEL_LITELLM_ENDPOINT_URL", "http://127.0.0.1:1/v1")
    sink = _EmbeddedSink()
    kernel = _EmbeddedKernel(sink)
    dispatcher, tracker, bridge, supervisor, writer = attach_kernel_subsystems(kernel)
    try:
        current = _kernel_block(dispatcher._collect_current_volatile())  # noqa: SLF001
        dispatcher._on_comm_msg({"content": {"data": _hydrate_envelope(block)}})  # noqa: SLF001
        log = _drift_log_from_sink(sink)
    finally:
        _stop_quietly(writer, supervisor, bridge, dispatcher)
    return current, log


def test_legacy_kernel_mode_reports_current_values_from_the_source(monkeypatch: pytest.MonkeyPatch) -> None:
    current, _ = _legacy_run(monkeypatch, dict(pty_mode.RFC_VERSIONS))
    assert _rfc_only(current) == dict(pty_mode.RFC_VERSIONS), f"legacy provider: {current!r}"


def test_legacy_kernel_mode_drift_alive(monkeypatch: pytest.MonkeyPatch) -> None:
    _, log = _legacy_run(monkeypatch, _drifted_block())
    _assert_drift_matches(log, "legacy IPython kernel")


# --- TCP serve path (real subprocess, real handshake, real hydrate) ---------
def _spawn_serve(tmp_path: Path, token: str):
    env = dict(os.environ, LLMNB_AUTH_TOKEN=token, LLMKERNEL_LITELLM_ENDPOINT_URL="http://127.0.0.1:1/v1")
    proc = subprocess.Popen(
        [sys.executable, "-u", "-m", "llm_kernel", "serve", "--transport", "tcp",
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
                raise AssertionError(f"serve exited early rc={proc.returncode}; {banner!r}")
            continue
        banner += line
        if "listening on" in line:
            host_port = line.split("listening on", 1)[1].split(";", 1)[0].strip()
            host, port = host_port.rsplit(":", 1)
            threading.Thread(target=lambda: [None for _ in iter(proc.stderr.readline, b"")], daemon=True).start()
            return proc, host, int(port)
    proc.kill()
    raise AssertionError(f"serve never reported listening; stderr={banner!r}")


def test_serve_mode_drift_alive(tmp_path: Path) -> None:
    from llm_client.transport import tcp as _tcp

    proc, host, port = _spawn_serve(tmp_path, "hidden-drift-token")
    try:
        conn = _tcp.connect(bind=f"{host}:{port}", token="hidden-drift-token", timeout=30.0)
        try:
            conn.send(_hydrate_envelope(_drifted_block()))
            done: Optional[Dict[str, Any]] = None
            deadline = time.monotonic() + 20.0
            while time.monotonic() < deadline:
                frame = conn.recv(timeout=1.0)
                if frame and _is_hydrate_done(frame):
                    done = frame
                    break
            assert done is not None, "serve: hydrate was never confirmed (no hydrate_complete snapshot on the wire)"
            log = list((done["payload"].get("snapshot") or {}).get("drift_log") or [])
            _assert_drift_matches(log, "serve")
        finally:
            try:
                conn.close()
            except Exception:
                pass
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()


# --- uvicorn app (lifespan boots the kernel) ---------------------------------
def test_app_mode_drift_alive(monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi.testclient import TestClient
    from llm_kernel.app import app

    receiver = _Receiver()
    monkeypatch.setenv(pty_mode.ENV_IPC_SOCKET, receiver.address)
    monkeypatch.setenv(pty_mode.ENV_SESSION_ID, "hidden-app-drift-session")
    monkeypatch.delenv(pty_mode.ENV_PTY_MODE, raising=False)
    monkeypatch.setenv("LLMKERNEL_LITELLM_ENDPOINT_URL", "http://127.0.0.1:1/v1")
    try:
        with TestClient(app):
            ready = receiver.wait_for(_is_ready, timeout=30.0)
            assert ready is not None, f"app: no kernel.ready frame; frames={receiver.frames[:3]!r}"
            receiver.send(_hydrate_envelope(_drifted_block()))
            done = receiver.wait_for(_is_hydrate_done, timeout=20.0)
            assert done is not None, "app: hydrate was never confirmed"
            log = list((done["payload"].get("snapshot") or {}).get("drift_log") or [])
            _assert_drift_matches(log, "app")
    finally:
        receiver.stop()
