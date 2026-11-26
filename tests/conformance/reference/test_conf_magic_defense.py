"""Hidden verifier tests for llmnb-magic-defense-01 (invariants I1-I7).

Every test here must FAIL on the starting code (the defense library exists
but production never enforces it) and PASS on the reference. Offline,
in-process, no network, no API keys, no ``claude`` binary. State is
isolated with ``tmp_path`` / ``monkeypatch``; ``os.environ`` is never
mutated directly.

Vocabulary (from the working spec): *hash mode* is on when the writer
config says ``magic_hash_enabled`` AND an operator pin is available
through ``MetadataWriter.get_operator_pin()`` (env ``LLMNB_OPERATOR_PIN``
whose fingerprint matches ``magic_pin_fingerprint``).
"""

from __future__ import annotations

import asyncio
import json
import signal
import socket
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Dict, List, Optional

import pytest
from mcp import types
from mcp.shared.exceptions import McpError

from llm_kernel.capture.metadata_writer import SCHEMA_VERSION, MetadataWriter
from llm_kernel.capture.socket_writer import sanitize_outbound_record
from llm_kernel.magics.magic_emit_tool import MagicEmitError, emit_magic_cell
from llm_kernel.mcp.intent_handlers.promote_stream_magic import (
    handle_promote_stream_magic,
)
from llm_kernel.mcp.mcp_server import OperatorBridgeServer
from llm_kernel.notebook.cell_manager import (
    CellManager,
    CellManagerPreconditionError,
)
from llm_kernel.notebook.notebook_format import magic_to_llmnb
from llm_kernel.supervision._provisioning import build_env
from llm_kernel.supervision.agent_supervisor import AgentHandle
from llm_kernel.text.cell_text import K35_PLAIN_MAGIC_IN_HASH_MODE
from llm_kernel.text.magic_hash import magic_hash, magic_pin_fingerprint


PIN = "hunter2-pin-ok"
PIN_ENV = "LLMNB_OPERATOR_PIN"

#: Every separator ``str.splitlines`` honours. A smuggled magic line can
#: hide behind any of them, not just ``\n``.
SPLITLINE_SEPARATORS = [
    "\n", "\r", "\x0b", "\x0c", "\x1c", "\x1d", "\x1e", "\x85",
    " ", " ",
]
SEPARATOR_IDS = [
    "LF", "CR", "VT", "FF", "FS", "GS", "RS", "NEL", "LSEP", "PSEP",
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _enable_hash_mode(
    writer: MetadataWriter, monkeypatch: pytest.MonkeyPatch, pin: str = PIN,
) -> None:
    """Turn hash mode on the way ``@auth set`` does: fingerprint + env pin."""
    monkeypatch.setenv(PIN_ENV, pin)
    writer.set_hash_mode(True, magic_pin_fingerprint(pin))


def _hydrate_cells(writer: MetadataWriter, magic_text: str) -> List[str]:
    """Load cells into ``writer`` through the public notebook path.

    ``magic_to_llmnb`` derives ``bound_agent_id`` for ``@@agent <id>``
    cells; ``hydrate`` is what a notebook open does. Returns the cell
    ids in document order (``cell-0``, ``cell-1``, ...).
    """
    rts = magic_to_llmnb(magic_text)["metadata"]["rts"]
    writer.hydrate(rts)
    return list(rts["cells"].keys())


def _k_codes(view: Any) -> List[str]:
    return [e.get("code") for e in getattr(view, "k_class_emissions", [])]


def _assistant_stdout_line(text: str) -> str:
    """One Claude stream-json ``assistant`` record carrying a text block."""
    return json.dumps({
        "type": "assistant",
        "message": {"content": [{"type": "text", "text": text}]},
    }) + "\n"


def _handle_with_stdout(
    lines: List[str], *, agent_id: str, zone_id: str, work_dir: Path,
) -> AgentHandle:
    """An AgentHandle whose "process" stdout is the given lines."""
    return AgentHandle(
        agent_id=agent_id, zone_id=zone_id,
        popen=SimpleNamespace(stdout=list(lines), stdin=None),
        started_at=time.monotonic(), work_dir=work_dir,
        stdout_thread=threading.Thread(), stderr_thread=threading.Thread(),
        claude_session_id="sess-magic-defense",
    )


def _expect_magic_emit_error(fn: Callable[[], Any]) -> MagicEmitError:
    """Run ``fn``; it must raise MagicEmitError carrying a K-code."""
    try:
        result = fn()
    except MagicEmitError as exc:
        assert isinstance(exc.code, str) and exc.code.startswith("K"), (
            f"MagicEmitError must carry a K-code; got {exc.code!r}"
        )
        return exc
    except Exception as exc:  # noqa: BLE001 - we want the type in the message
        pytest.fail(
            f"expected MagicEmitError, got {type(exc).__name__}: {exc}"
        )
    pytest.fail(f"expected MagicEmitError; emission was accepted: {result!r}")


def _emit_scratch(
    writer: MetadataWriter, cm: CellManager, **overrides: Any,
) -> Dict[str, str]:
    kwargs: Dict[str, Any] = dict(
        agent_id="alpha", zone_id="z1", name="scratch", args={}, body=None,
        position={"after_cell_id": "c_anchor"},
        writer=writer, cell_manager=cm,
    )
    kwargs.update(overrides)
    return emit_magic_cell(**kwargs)


# -- MCP in-process invocation (idiom from test_mcp_server_round_trip) ----


async def _mcp_call(
    bridge: OperatorBridgeServer, name: str, arguments: Dict[str, Any],
) -> Dict[str, Any]:
    handler = bridge.server.request_handlers[types.CallToolRequest]
    request = types.CallToolRequest(
        method="tools/call",
        params=types.CallToolRequestParams(name=name, arguments=arguments),
    )
    server_result = await handler(request)
    inner = server_result.root
    assert isinstance(inner, types.CallToolResult)
    assert inner.structuredContent is not None
    return inner.structuredContent


async def _mcp_tool_names(bridge: OperatorBridgeServer) -> set:
    handler = bridge.server.request_handlers[types.ListToolsRequest]
    server_result = await handler(types.ListToolsRequest(method="tools/list"))
    return {tool.name for tool in server_result.root.tools}


# -- Loopback receiver for the pty data plane (idiom from test_pty_mode) --


class _Receiver:
    """Bind a loopback server; accept one connection; collect JSON frames."""

    def __init__(self) -> None:
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(1)
        self.server.settimeout(15.0)
        self.port = self.server.getsockname()[1]
        self.frames: List[Dict[str, Any]] = []
        self.conn: Optional[socket.socket] = None
        self._thread = threading.Thread(target=self._accept_loop, daemon=True)
        self._stop = threading.Event()

    @property
    def address(self) -> str:
        return f"tcp:127.0.0.1:{self.port}"

    def start(self) -> None:
        self._thread.start()

    def _accept_loop(self) -> None:
        try:
            conn, _addr = self.server.accept()
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
                if not line.strip():
                    continue
                try:
                    self.frames.append(json.loads(line.decode("utf-8")))
                except ValueError:
                    pass

    def wait_for(
        self, predicate: Callable[[Dict[str, Any]], bool], timeout: float = 10.0,
    ) -> Optional[Dict[str, Any]]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for frame in list(self.frames):
                if predicate(frame):
                    return frame
            time.sleep(0.02)
        return None

    def stop(self) -> None:
        self._stop.set()
        try:
            if self.conn is not None:
                self.conn.shutdown(socket.SHUT_RDWR)
                self.conn.close()
        except OSError:
            pass
        try:
            self.server.close()
        except OSError:
            pass
        self._thread.join(timeout=2)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def writer(tmp_path: Path) -> MetadataWriter:
    w = MetadataWriter(workspace_root=tmp_path, autosave_interval_sec=999.0)
    w.set_cell_text("c_anchor", "@@scratch anchor")
    return w


@pytest.fixture
def cm(writer: MetadataWriter) -> CellManager:
    return CellManager(writer)


@pytest.fixture
def pty_state(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """Boot the pty-mode kernel in-process against a loopback receiver.

    Mirrors what the pty entry point does once it is a consumer of the
    facade: a ``PtyTransport`` is prepared (connect, ready handshake, OTLP
    handler; the owned proxy is skipped by declaring an external endpoint
    URL that is never contacted), then one ``Kernel`` is built on the
    transport's egress and the transport is bound through the facade.
    Yields ``(state, receiver)`` where ``state`` exposes the writer, the
    supervisor and the metadata writer the booted kernel owns.
    """
    import asyncio
    import threading

    from llm_kernel.kernel_facade import Kernel
    from llm_kernel.transports import pty_mode

    receiver = _Receiver()
    receiver.start()
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv(pty_mode.ENV_IPC_SOCKET, receiver.address)
    monkeypatch.setenv(pty_mode.ENV_SESSION_ID, "session-magic-defense")
    monkeypatch.delenv(pty_mode.ENV_PTY_MODE, raising=False)
    monkeypatch.setenv("LLMKERNEL_LITELLM_ENDPOINT_URL", "http://127.0.0.1:1/v1")
    saved_signals = {
        sig: signal.getsignal(sig)
        for sig in (signal.SIGINT, signal.SIGTERM)
        if hasattr(signal, sig.name)
    }
    transport = pty_mode.PtyTransport(
        address=receiver.address, session_id="session-magic-defense", pty_flag=False,
    )
    kernel = None
    loop = None
    loop_thread = None
    try:
        rc = transport.prepare()
        assert rc == 0, f"pty transport failed to prepare: rc={rc!r}"
        loop = asyncio.new_event_loop()
        loop_thread = threading.Thread(
            target=loop.run_forever, name="magic-defense-pty-loop", daemon=True,
        )
        loop_thread.start()
        kernel = Kernel(workdir=tmp_path, kernel_shell=transport.kernel_shell, loop=loop)

        async def _start() -> None:
            await kernel.start()
            await kernel.bind_transport(transport)

        asyncio.run_coroutine_threadsafe(_start(), loop).result(timeout=60.0)
        state = {
            "facade": kernel,
            "transport": transport,
            "writer": transport.writer,
            "supervisor": kernel.supervisor,
            "metadata_writer": kernel.metadata_writer,
        }
        assert receiver.wait_for(lambda f: "severityNumber" in f, timeout=10.0), (
            "no ready handshake on the data plane"
        )
        yield state, receiver
    finally:
        if kernel is not None and loop is not None:
            try:
                asyncio.run_coroutine_threadsafe(kernel.shutdown(), loop).result(timeout=30.0)
            except Exception:
                pass
            loop.call_soon_threadsafe(loop.stop)
            if loop_thread is not None:
                loop_thread.join(timeout=5.0)
            if not loop.is_running():
                loop.close()
        transport.close()
        receiver.stop()
        for sig, prev in saved_signals.items():
            try:
                signal.signal(sig, prev)
            except (ValueError, OSError):
                pass


# ===========================================================================
# I1 - Hash mode governs every production parse
# ===========================================================================


def test_I1_writer_cell_view_is_pin_aware(
    writer: MetadataWriter, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """I1: in hash mode ``cell_view`` treats plain ``@@spawn`` as body (K35) and the hashed form as the magic."""
    _enable_hash_mode(writer, monkeypatch)
    h = magic_hash(PIN, "spawn")
    writer.set_cell_text("c_plain", "@@spawn a task:\"x\"\nbody\n")
    writer.set_cell_text("c_hashed", f"@@{h}:spawn a task:\"x\"\nbody\n")

    plain = writer.cell_view("c_plain")
    assert plain is not None
    assert plain.kind != "spawn", (
        "plain @@spawn under hash mode must not dispatch as an agent cell"
    )
    assert plain.args.get("agent_id") != "a"
    assert K35_PLAIN_MAGIC_IN_HASH_MODE in _k_codes(plain)
    assert "@@spawn a" in plain.body

    hashed = writer.cell_view("c_hashed")
    assert hashed is not None
    assert hashed.kind == "spawn"
    assert hashed.args.get("agent_id") == "a"
    assert _k_codes(hashed) == []


def test_I1_cell_view_cache_is_keyed_on_hash_state(
    writer: MetadataWriter, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """I1: toggling hash mode re-parses a cell whose text did not change (cache keyed on hash state, not only text)."""
    writer.set_cell_text("c1", "@@spawn a\nbody\n")
    before = writer.cell_view("c1")
    assert before is not None and before.kind == "spawn"  # hash mode off

    _enable_hash_mode(writer, monkeypatch)
    during = writer.cell_view("c1")
    assert during is not None
    assert during.kind != "spawn", (
        "cell_view returned the pre-hash-mode parse: the view cache was "
        "not invalidated by the hash-mode toggle"
    )
    assert K35_PLAIN_MAGIC_IN_HASH_MODE in _k_codes(during)

    writer.set_hash_mode(False, None)
    after = writer.cell_view("c1")
    assert after is not None and after.kind == "spawn", (
        "turning hash mode off must re-parse back to the plain dispatch"
    )
    assert _k_codes(after) == []


def test_I1_cell_manager_view_is_pin_aware(
    writer: MetadataWriter, cm: CellManager, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """I1: ``CellManager.view`` honours hash mode exactly like the writer's view."""
    _enable_hash_mode(writer, monkeypatch)
    h = magic_hash(PIN, "spawn")
    writer.set_cell_text("c_plain", "@@spawn a\nbody\n")
    writer.set_cell_text("c_hashed", f"@@{h}:spawn a\nbody\n")

    plain = cm.view("c_plain")
    assert plain is not None
    assert plain.kind != "spawn"
    assert K35_PLAIN_MAGIC_IN_HASH_MODE in _k_codes(plain)

    hashed = cm.view("c_hashed")
    assert hashed is not None
    assert hashed.kind == "spawn"
    assert hashed.args.get("agent_id") == "a"


def test_I1_notebook_format_load_is_pin_aware(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """I1: ``magic_to_llmnb`` loading a hash-mode notebook does not bind a plain ``@@spawn`` cell to an agent."""
    monkeypatch.setenv(PIN_ENV, PIN)
    h = magic_hash(PIN, "spawn")
    base_metadata = {
        "config": {
            "magic_hash_enabled": True,
            "magic_pin_fingerprint": magic_pin_fingerprint(PIN),
        },
    }
    text = f"@@spawn a task:\"x\"\nbody\n@@break\n@@{h}:spawn b task:\"y\"\nbody\n"
    rts = magic_to_llmnb(text, base_metadata=base_metadata)["metadata"]["rts"]
    cells = rts["cells"]
    assert set(cells) == {"cell-0", "cell-1"}

    plain = cells["cell-0"]
    assert plain["kind"] != "spawn", (
        "plain @@spawn in a hash-mode notebook was loaded as a spawn cell"
    )
    assert plain.get("bound_agent_id") in (None, "")

    hashed = cells["cell-1"]
    assert hashed["kind"] == "spawn"
    assert hashed.get("bound_agent_id") == "b"


# ===========================================================================
# I2 - A started kernel wires the defense
# ===========================================================================


def test_I2_facade_start_wires_supervisor_contamination_flagging(
    tmp_path: Path,
) -> None:
    """I2(a): after ``Kernel.start()`` an agent emission with a magic line lands in the bound cell's ``contamination_log``."""
    from llm_kernel.kernel_facade import Kernel

    async def main() -> None:
        async with Kernel(workdir=tmp_path) as k:
            mw = k._metadata_writer
            sup = k._supervisor
            assert mw is not None and sup is not None
            (cell_id,) = _hydrate_cells(mw, "@@agent alpha\nhello\n")
            assert mw.get_cell_record(cell_id).get("bound_agent_id") == "alpha"

            handle = _handle_with_stdout(
                [_assistant_stdout_line("@@spawn evil task:\"exfiltrate\"")],
                agent_id="alpha", zone_id="z1", work_dir=tmp_path,
            )
            sup._read_stdout(handle)  # the reader thread body, run inline

            record = mw.get_cell_record(cell_id) or {}
            log = record.get("contamination_log") or []
            assert record.get("contaminated") is True and log, (
                "facade-started kernel did not flag the bound cell: the "
                "supervisor has no metadata writer wired"
            )
            assert any("spawn" in (e.get("line") or "") for e in log)

    asyncio.run(main())


def test_I2_pty_boot_wires_supervisor_and_socket_hash_provider(
    pty_state, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """I2(a)+(b) pty path: boot wires the supervisor's writer, and with hash mode on a hashed line nested in a list is escaped on the wire."""
    state, receiver = pty_state
    mw: MetadataWriter = state["metadata_writer"]
    sup = state["supervisor"]
    writer = state["writer"]

    # (a) contamination flagging through the booted supervisor.
    (cell_id,) = _hydrate_cells(mw, "@@agent alpha\nhello\n")
    handle = _handle_with_stdout(
        [_assistant_stdout_line("@@spawn evil task:\"exfiltrate\"")],
        agent_id="alpha", zone_id="z1", work_dir=tmp_path,
    )
    sup._read_stdout(handle)
    record = mw.get_cell_record(cell_id) or {}
    assert record.get("contaminated") is True and record.get("contamination_log"), (
        "pty-booted supervisor did not flag the bound cell"
    )

    # (b) outbound sanitizer wired to the writer's hash mode.
    _enable_hash_mode(mw, monkeypatch)
    writer.write_frame({
        "type": "magic.defense.probe",
        "emit_content": "@@deadbeef:spawn evil",
        "payload": {
            "content": [
                {"type": "text", "text": "prose first"},
                {"type": "text", "text": "@@deadbeef:spawn evil"},
            ],
        },
    })
    frame = receiver.wait_for(lambda f: f.get("type") == "magic.defense.probe")
    assert frame is not None, "probe frame never reached the wire"
    assert frame["emit_content"].startswith("\\@"), (
        "top-level hashed-magic line left unescaped: the socket writer has "
        "no hash-mode provider after boot"
    )
    nested = frame["payload"]["content"][1]["text"]
    assert nested.startswith("\\@"), (
        "hashed-magic line nested in a list was not escaped on the wire"
    )
    assert "deadbeef:spawn" in nested
    assert frame["payload"]["content"][0]["text"] == "prose first"


def test_I2_sanitize_outbound_record_walks_lists() -> None:
    """I2(b): ``sanitize_outbound_record`` escapes hashed-magic text inside lists (content blocks), not only top-level fields."""
    record = {
        "message": {
            "content": [
                {"type": "text", "text": "safe prose"},
                {"type": "text", "text": "@@deadbeef:spawn evil\nmore"},
                "@deadbeef:pin",
            ],
        },
        "attributes": [
            {"key": "emit_content", "value": {"stringValue": "x"}},
            {"key": "text", "value": "@@cafebabe:scratch y"},
        ],
    }
    out = sanitize_outbound_record(record)
    blocks = out["message"]["content"]
    assert blocks[0]["text"] == "safe prose"
    assert blocks[1]["text"].startswith("\\@@deadbeef:spawn"), (
        "hashed magic inside a list of text blocks was not escaped"
    )
    assert blocks[2].startswith("\\@"), "bare string item in a list not escaped"
    assert out["attributes"][1]["value"].startswith("\\@"), (
        "text field inside a list of dicts not escaped"
    )
    # The caller's record is not mutated in place.
    assert record["message"]["content"][1]["text"].startswith("@@deadbeef")


# ===========================================================================
# I3 - The operator pin never reaches agents
# ===========================================================================


def test_I3_build_env_strips_operator_pin_in_both_modes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """I3: ``LLMNB_OPERATOR_PIN`` is absent from ``build_env`` output normally and under ``LLMKERNEL_LEAK_ENV=1``."""
    parent = {
        "PATH": "/usr/bin", "HOME": str(tmp_path), PIN_ENV: PIN,
        "CLAUDE_CODE_SOMETHING": "keep",
    }
    common = dict(
        api_key="k", llm_endpoint_url="http://127.0.0.1:1/v1",
        mcp_config_path=tmp_path / "mcp.json",
        system_prompt_path=tmp_path / "prompt.md", work_dir=tmp_path,
        agent_id="alpha", zone_id="z1", trace_id="t",
    )
    monkeypatch.delenv("LLMKERNEL_LEAK_ENV", raising=False)
    strict = build_env(parent, **common)
    assert PIN_ENV not in strict, "operator pin leaked into the agent env"
    assert strict["CLAUDE_CODE_SOMETHING"] == "keep"

    monkeypatch.setenv("LLMKERNEL_LEAK_ENV", "1")
    leaky = build_env(parent, **common)
    assert leaky["PATH"] == "/usr/bin"  # LEAK_ENV still inherits the rest
    assert PIN_ENV not in leaky, (
        "operator pin leaked into the agent env under LLMKERNEL_LEAK_ENV=1"
    )


def test_I3_run_command_child_does_not_see_operator_pin(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """I3: a ``run_command`` child started by the MCP server never observes ``LLMNB_OPERATOR_PIN``."""
    monkeypatch.setenv(PIN_ENV, PIN)
    monkeypatch.setenv("LLMKERNEL_WORKSPACE_ROOT", str(tmp_path))
    bridge = OperatorBridgeServer(agent_id="alpha", zone_id="z1")
    probe = f"import os; print('PIN=' + os.environ.get({PIN_ENV!r}, '<absent>'))"

    async def main() -> None:
        for env_override in (None, {"PROBE_EXTRA": "1"}):
            args: Dict[str, Any] = {
                "command": sys.executable, "args": ["-c", probe],
                "timeout_ms": 20000,
            }
            if env_override is not None:
                args["env"] = env_override
            payload = await _mcp_call(bridge, "run_command", args)
            assert payload["exit_code"] == 0, payload
            assert PIN not in payload["stdout"], (
                f"run_command child saw the operator pin (env={env_override!r})"
            )
            assert "PIN=<absent>" in payload["stdout"]

    asyncio.run(main())


def test_I3_get_operator_pin_requires_matching_fingerprint(
    writer: MetadataWriter, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """I3: ``get_operator_pin`` returns None when the env pin does not match the stored fingerprint."""
    writer.set_hash_mode(True, magic_pin_fingerprint(PIN))

    monkeypatch.setenv(PIN_ENV, "wrong-pin-5678")
    assert writer.get_operator_pin() is None, (
        "a pin whose fingerprint does not match the notebook validated"
    )

    monkeypatch.setenv(PIN_ENV, PIN)
    assert writer.get_operator_pin() == PIN

    monkeypatch.delenv(PIN_ENV)
    assert writer.get_operator_pin() is None


# ===========================================================================
# I4 - emit_magic_cell cannot smuggle extra magic
# ===========================================================================


@pytest.mark.parametrize("sep", SPLITLINE_SEPARATORS, ids=SEPARATOR_IDS)
def test_I4_emit_rejects_magic_after_any_line_separator(
    writer: MetadataWriter, cm: CellManager, sep: str,
) -> None:
    """I4: an args value or body hiding ``@<magic>`` behind any ``str.splitlines`` separator is rejected with MagicEmitError."""
    writer.grant_magic_emit_privilege(
        agent_id="alpha", zone_id="z1", scope={"magics": ["scratch"]},
    )
    _expect_magic_emit_error(lambda: _emit_scratch(
        writer, cm, args={"note": f"x{sep}@handoff beta"},
    ))
    _expect_magic_emit_error(lambda: _emit_scratch(
        writer, cm, body=f"prose{sep}@handoff beta",
    ))
    # Nothing was inserted by the rejected attempts.
    assert set(writer.snapshot().get("cells", {})) == {"c_anchor"}


def test_I4_emit_rejects_cell_magic_smuggled_via_scratch_grant(
    writer: MetadataWriter, cm: CellManager,
) -> None:
    """I4: a ``["scratch"]`` grant cannot carry ``@@spawn`` in an args value or body; benign values still emit."""
    writer.grant_magic_emit_privilege(
        agent_id="alpha", zone_id="z1", scope={"magics": ["scratch"]},
    )
    ok = _emit_scratch(writer, cm, args={"note": "plain value"}, body="plain body")
    rec = writer.get_cell_record(ok["cell_id"])
    assert rec is not None and rec["text"].startswith("@@scratch")

    _expect_magic_emit_error(lambda: _emit_scratch(
        writer, cm, args={"note": "x\n@@spawn beta task:\"y\""},
    ))
    _expect_magic_emit_error(lambda: _emit_scratch(
        writer, cm, body="prose\n@@spawn beta task:\"y\"",
    ))
    _expect_magic_emit_error(lambda: _emit_scratch(
        writer, cm, body="@@spawn beta task:\"y\"",
    ))
    assert set(writer.snapshot().get("cells", {})) == {"c_anchor", ok["cell_id"]}


def test_I4_emit_name_must_be_a_cell_magic_and_never_break(
    writer: MetadataWriter, cm: CellManager,
) -> None:
    """I4: ``name`` must be a registered cell magic and ``break`` is refused even under an ``all`` grant."""
    writer.grant_magic_emit_privilege(
        agent_id="alpha", zone_id="z1", scope={"magics": "all"},
    )
    _expect_magic_emit_error(lambda: _emit_scratch(writer, cm, name="break"))
    _expect_magic_emit_error(lambda: _emit_scratch(writer, cm, name="pin"))
    _expect_magic_emit_error(lambda: _emit_scratch(writer, cm, name="xyzzy"))
    assert set(writer.snapshot().get("cells", {})) == {"c_anchor"}


# ===========================================================================
# I5 - emit_magic_cell is an MCP tool only for granted agents
# ===========================================================================


def test_I5_list_tools_omits_emit_magic_cell_without_grant(
    writer: MetadataWriter,
) -> None:
    """I5: ``list_tools`` hides ``emit_magic_cell`` from an agent without a grant and shows it once granted."""
    bridge = OperatorBridgeServer(agent_id="alpha", zone_id="z1")
    bridge.metadata_writer = writer

    async def main() -> None:
        names = await _mcp_tool_names(bridge)
        assert "notify" in names
        assert "emit_magic_cell" not in names, (
            "emit_magic_cell advertised to an agent with no privilege grant"
        )
        writer.grant_magic_emit_privilege(
            agent_id="alpha", zone_id="z1", scope={"magics": ["scratch"]},
        )
        assert "emit_magic_cell" in await _mcp_tool_names(bridge)

    asyncio.run(main())


def test_I5_call_without_grant_is_a_permission_error_not_method_not_found(
    writer: MetadataWriter,
) -> None:
    """I5: calling ``emit_magic_cell`` without a grant yields a privilege error (not -32601); with a grant the cell is created."""
    bridge = OperatorBridgeServer(agent_id="alpha", zone_id="z1")
    bridge.metadata_writer = writer
    arguments = {
        "name": "scratch", "args": {"note": "hello"},
        "position": {"after_cell_id": "c_anchor"},
    }

    async def main() -> None:
        with pytest.raises(McpError) as exc_info:
            await _mcp_call(bridge, "emit_magic_cell", arguments)
        err = exc_info.value.error
        assert err.code != types.METHOD_NOT_FOUND, (
            "emit_magic_cell is not registered as a tool at all (-32601)"
        )
        assert "privilege" in (err.message or "").lower(), err.message
        assert set(writer.snapshot().get("cells", {})) == {"c_anchor"}

        writer.grant_magic_emit_privilege(
            agent_id="alpha", zone_id="z1", scope={"magics": ["scratch"]},
        )
        payload = await _mcp_call(bridge, "emit_magic_cell", arguments)
        rec = writer.get_cell_record(payload["cell_id"])
        assert rec is not None
        assert rec["generated_by"] == "alpha"
        assert rec["text"].startswith("@@scratch")

    asyncio.run(main())


def test_I5_operator_grant_without_scope_grants_no_magics(
    writer: MetadataWriter,
) -> None:
    """I5: an operator ``grant_magic_emit_privilege`` action with no scope does not default to all magics."""
    bridge = OperatorBridgeServer(agent_id="alpha", zone_id="z1")
    bridge.metadata_writer = writer
    bridge._route_operator_action({
        "type": "operator.action",
        "payload": {
            "action_type": "grant_magic_emit_privilege",
            "parameters": {"agent_id": "alpha", "zone_id": "z1"},
        },
    })
    for magic in ("spawn", "scratch", "template"):
        assert not writer.has_magic_emit_privilege(
            agent_id="alpha", zone_id="z1", magic_name=magic,
        ), f"scope-less grant silently covered {magic!r}"

    # An explicit list still works through the same route.
    bridge._route_operator_action({
        "type": "operator.action",
        "payload": {
            "action_type": "grant_magic_emit_privilege",
            "parameters": {
                "agent_id": "alpha", "zone_id": "z1",
                "scope": {"magics": ["scratch"]},
            },
        },
    })
    assert writer.has_magic_emit_privilege(
        agent_id="alpha", zone_id="z1", magic_name="scratch",
    )
    assert not writer.has_magic_emit_privilege(
        agent_id="alpha", zone_id="z1", magic_name="spawn",
    )


# ===========================================================================
# I6 - Promotion is anchored to evidence
# ===========================================================================


def test_I6_promotion_requires_the_line_in_contamination_log(
    writer: MetadataWriter, cm: CellManager,
) -> None:
    """I6: ``promote_stream_magic`` refuses a line that is not in the source cell's ``contamination_log``."""
    (src,) = _hydrate_cells(writer, "@@agent alpha\nhello\n")
    writer.grant_magic_emit_privilege(
        agent_id="alpha", zone_id="z1", scope={"magics": "all"},
    )
    # Clean cell: no evidence at all.
    result = handle_promote_stream_magic(
        params={"cell_id": src, "line": "@@scratch hello"},
        writer=writer, cell_manager=cm, zone_id="z1",
    )
    assert result is None, "promoted a line the agent never stream-emitted"
    assert set(writer.snapshot().get("cells", {})) == {src}

    # Contaminated by a different line: still no evidence for this one.
    writer.flag_cells_contaminated_by_agent(
        agent_id="alpha", line="@@spawn evil", source="prose", layer="plain",
    )
    result = handle_promote_stream_magic(
        params={"cell_id": src, "line": "@@scratch hello"},
        writer=writer, cell_manager=cm, zone_id="z1",
    )
    assert result is None, "promoted a line absent from contamination_log"
    assert set(writer.snapshot().get("cells", {})) == {src}


def test_I6_promotion_from_contaminated_cell_succeeds(
    writer: MetadataWriter, cm: CellManager,
) -> None:
    """I6: promoting a logged line from a genuinely contaminated cell succeeds (K3E must not escape)."""
    (src,) = _hydrate_cells(writer, "@@agent alpha\nhello\n")
    writer.grant_magic_emit_privilege(
        agent_id="alpha", zone_id="z1", scope={"magics": "all"},
    )
    line = "@@scratch hello"
    flagged = writer.flag_cells_contaminated_by_agent(
        agent_id="alpha", line=line, source="prose", layer="plain",
    )
    assert flagged == [src] and writer.is_cell_contaminated(src)

    try:
        result = handle_promote_stream_magic(
            params={"cell_id": src, "line": line},
            writer=writer, cell_manager=cm, zone_id="z1",
        )
    except CellManagerPreconditionError as exc:
        pytest.fail(
            f"promotion from a contaminated cell raised {exc.k_code}: {exc}"
        )
    assert result is not None, "promotion of a logged line was refused"
    rec = writer.get_cell_record(result["cell_id"])
    assert rec is not None
    assert rec.get("promoted_from_stream") is True
    assert rec["generated_by"] == "alpha"
    assert rec["text"].startswith("@@scratch")
    assert "hello" in rec["text"]


# ===========================================================================
# I7 - Trust does not come from a file
# ===========================================================================


def test_I7_persisted_grants_are_not_trusted_until_regranted(
    tmp_path: Path,
) -> None:
    """I7: ``magic_emit_privileges`` arriving through ``hydrate`` confer nothing until an operator grants in-session."""
    # A notebook file pre-seeding a grant.
    file_snapshot = {
        "schema_version": SCHEMA_VERSION,
        "config": {
            "magic_emit_privileges": [{
                "agent_id": "alpha", "zone_id": "z1",
                "granted_at": "2026-04-29T00:00:00.000Z",
                "scope": {"magics": "all"},
            }],
        },
    }
    w = MetadataWriter(workspace_root=tmp_path, autosave_interval_sec=999.0)
    w.hydrate(file_snapshot)
    assert not w.has_magic_emit_privilege(
        agent_id="alpha", zone_id="z1", magic_name="scratch",
    ), "a grant authored in the notebook file was honoured"

    # In-session grant works, and survives into the snapshot ...
    w.grant_magic_emit_privilege(
        agent_id="alpha", zone_id="z1", scope={"magics": ["scratch"]},
    )
    assert w.has_magic_emit_privilege(
        agent_id="alpha", zone_id="z1", magic_name="scratch",
    )
    snap = w.snapshot()
    persisted = (snap.get("config") or {}).get("magic_emit_privileges")
    assert isinstance(persisted, list) and persisted, (
        "in-session grant must still round-trip into the snapshot"
    )
    # ... but a fresh session hydrating that snapshot starts untrusted.
    w2 = MetadataWriter(workspace_root=tmp_path, autosave_interval_sec=999.0)
    w2.hydrate(snap)
    assert not w2.has_magic_emit_privilege(
        agent_id="alpha", zone_id="z1", magic_name="scratch",
    ), "a persisted grant became effective on hydrate without an operator"


def test_I7_file_hash_mode_needs_matching_in_session_pin(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """I7: ``magic_hash_enabled`` from a file governs parsing only while the in-session pin matches its fingerprint."""
    file_pin = "file-pin-12345"
    h = magic_hash(file_pin, "spawn")
    file_snapshot = {
        "schema_version": SCHEMA_VERSION,
        "config": {
            "magic_hash_enabled": True,
            "magic_pin_fingerprint": magic_pin_fingerprint(file_pin),
        },
        "cells": {
            "c_plain": {"text": "@@spawn a\nbody\n", "outputs": [], "kind": "agent"},
            "c_hashed": {"text": f"@@{h}:spawn a\nbody\n", "outputs": [], "kind": "agent"},
        },
    }
    w = MetadataWriter(workspace_root=tmp_path, autosave_interval_sec=999.0)

    # Matching pin in the session: the file's hash mode is honoured.
    monkeypatch.setenv(PIN_ENV, file_pin)
    w.hydrate(file_snapshot)
    assert w.get_operator_pin() == file_pin
    plain = w.cell_view("c_plain")
    assert plain is not None and plain.kind != "spawn", (
        "plain @@spawn dispatched although hash mode is on with a matching pin"
    )
    assert K35_PLAIN_MAGIC_IN_HASH_MODE in _k_codes(plain)
    hashed = w.cell_view("c_hashed")
    assert hashed is not None and hashed.kind == "spawn"

    # Pin changes underneath: the file's fingerprint no longer validates,
    # so the file-authored hashed magic must not dispatch (and the
    # cached hashed view must not survive the pin change).
    monkeypatch.setenv(PIN_ENV, "another-pin-9")
    assert w.get_operator_pin() is None
    stale = w.cell_view("c_hashed")
    assert stale is not None and stale.kind != "spawn", (
        "hashed magic keyed to the file's pin still dispatched after the "
        "session pin stopped matching"
    )


def test_I4_emit_requires_a_covering_grant(
    writer: MetadataWriter, cm: CellManager,
) -> None:
    """certified-magic-emitter / PLAN-S5.0.4 §3.1: ``emit_magic_cell`` refuses an agent with no covering grant (K3K); another agent's grant does not cover it; its own grant does."""
    _expect_magic_emit_error(lambda: _emit_scratch(writer, cm))
    writer.grant_magic_emit_privilege(
        agent_id="beta", zone_id="z1", scope={"magics": ["scratch"]},
    )
    _expect_magic_emit_error(lambda: _emit_scratch(writer, cm))
    assert set(writer.snapshot().get("cells", {})) == {"c_anchor"}
    writer.grant_magic_emit_privilege(
        agent_id="alpha", zone_id="z1", scope={"magics": ["scratch"]},
    )
    ok = _emit_scratch(writer, cm)
    assert writer.get_cell_record(ok["cell_id"]) is not None
