from __future__ import annotations

import os
import queue
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from jupyter_client import BlockingKernelClient, KernelManager

from llm_kernel.wire import versions as _versions

from llm_client.boot import KernelConnection

MIME_RUN: str = "application/vnd.rts.run+json"

__all__ = [
    "JupyterHandshakeError",
    "JupyterKernelConnection",
    "JupyterVersionMismatchError",
    "connect",
    "start_kernel",
]


class JupyterHandshakeError(RuntimeError):
    def __init__(
        self,
        reason: str,
        message: str,
        *,
        payload: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.reason = reason
        self.payload = payload


class JupyterVersionMismatchError(JupyterHandshakeError):
    def __init__(
        self, message: str, *, payload: Optional[Dict[str, Any]] = None
    ) -> None:
        super().__init__("version_mismatch_major", message, payload=payload)


class JupyterKernelConnection(KernelConnection):
    def __init__(
        self,
        *,
        client: BlockingKernelClient,
        comm_id: str,
        comm_target: str,
        session_id: str,
        wire_version: str,
        kernel_info: Dict[str, Any],
        manager: Optional[KernelManager] = None,
    ) -> None:
        self.session_id = session_id
        self.wire_version = wire_version
        self.comm_id = comm_id
        self.comm_target = comm_target
        self.kernel_info = kernel_info
        self.read_only = False
        self._client = client
        self._manager = manager
        self._supervisor = None
        self._closed = False

    @property
    def client(self) -> BlockingKernelClient:
        return self._client

    @property
    def connection_file(self) -> str:
        return str(self._client.connection_file)

    def send(self, envelope: dict) -> None:
        if self._closed:
            raise RuntimeError("KernelConnection is already closed")
        msg = self._client.session.msg(
            "comm_msg",
            {"comm_id": self.comm_id, "data": envelope},
        )
        self._client.shell_channel.send(msg)

    def recv(self, *, timeout: float | None = None) -> dict:
        if self._closed:
            raise RuntimeError("KernelConnection is already closed")
        budget = 0.0 if timeout is None else max(0.0, float(timeout))
        deadline = time.monotonic() + budget
        while True:
            remaining = max(0.0, deadline - time.monotonic())
            try:
                msg = self._client.get_iopub_msg(timeout=remaining)
            except queue.Empty:
                return {}
            msg_type = msg.get("msg_type") or (msg.get("header") or {}).get("msg_type")
            content = msg.get("content") or {}
            if msg_type == "comm_msg" and content.get("comm_id") == self.comm_id:
                data = content.get("data")
                if isinstance(data, dict):
                    return data
            elif msg_type in ("display_data", "update_display_data"):
                data = content.get("data") or {}
                run_span = data.get(MIME_RUN)
                if isinstance(run_span, dict):
                    return run_span
            elif msg_type == "comm_close" and content.get("comm_id") == self.comm_id:
                self._closed = True
                return {}
            if time.monotonic() >= deadline:
                return {}

    def execute_cell(
        self,
        code: str,
        *,
        silent: bool = False,
        store_history: bool = True,
        user_expressions: Optional[Dict[str, str]] = None,
        allow_stdin: bool = False,
        cell_id: Optional[str] = None,
        timeout: float = 30.0,
    ) -> Dict[str, Any]:
        if self._closed:
            raise RuntimeError("KernelConnection is already closed")
        content = {
            "code": code,
            "silent": silent,
            "store_history": store_history,
            "user_expressions": user_expressions or {},
            "allow_stdin": allow_stdin,
            "stop_on_error": True,
        }
        metadata: Dict[str, Any] = {}
        if cell_id is not None:
            metadata["cellId"] = cell_id
        msg = self._client.session.msg("execute_request", content, metadata=metadata)
        msg_id = msg["header"]["msg_id"]
        self._client.shell_channel.send(msg)

        deadline = time.monotonic() + timeout
        outputs: List[Dict[str, Any]] = []
        idle_seen = False
        while not idle_seen and time.monotonic() < deadline:
            remaining = max(0.05, min(0.5, deadline - time.monotonic()))
            try:
                io_msg = self._client.get_iopub_msg(timeout=remaining)
            except queue.Empty:
                continue
            if (io_msg.get("parent_header") or {}).get("msg_id") != msg_id:
                continue
            mtype = io_msg.get("msg_type")
            mcontent = io_msg.get("content") or {}
            if mtype == "status" and mcontent.get("execution_state") == "idle":
                idle_seen = True
            elif mtype in (
                "display_data",
                "update_display_data",
                "execute_result",
                "stream",
                "error",
            ):
                outputs.append({"msg_type": mtype, "content": mcontent})

        reply_content: Dict[str, Any] = {}
        while time.monotonic() < deadline:
            remaining = max(0.05, deadline - time.monotonic())
            reply = self._client.get_shell_msg(timeout=remaining)
            if (reply.get("parent_header") or {}).get("msg_id") == msg_id:
                reply_content = reply.get("content") or {}
                break

        return {"reply": reply_content, "outputs": outputs}

    def close(self) -> None:
        if self._closed and self._manager is None:
            return
        if not self._closed:
            self._closed = True
            try:
                close_msg = self._client.session.msg(
                    "comm_close", {"comm_id": self.comm_id, "data": {}}
                )
                self._client.shell_channel.send(close_msg)
            except Exception:
                pass
            try:
                self._client.stop_channels()
            except Exception:
                pass
        manager = self._manager
        self._manager = None
        if manager is not None:
            try:
                if manager.is_alive():
                    manager.shutdown_kernel(now=False)
            except Exception:
                try:
                    manager.shutdown_kernel(now=True)
                except Exception:
                    pass

    def __enter__(self) -> "JupyterKernelConnection":
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.close()


def connect(
    connection_file: str | Path,
    *,
    comm_target: Optional[str] = None,
    timeout: float = 30.0,
    _manager: Optional[KernelManager] = None,
) -> JupyterKernelConnection:
    raw = str(connection_file)
    if raw.startswith("jupyter://"):
        raw = raw[len("jupyter://"):]
    cf_path = Path(raw)
    if not cf_path.exists():
        raise FileNotFoundError(f"Jupyter connection file not found: {cf_path}")

    target = comm_target or _versions.COMM_TARGET
    if _manager is not None:
        client = _manager.client()
    else:
        client = BlockingKernelClient(connection_file=str(cf_path))
        client.load_connection_file()
    client.start_channels()
    try:
        try:
            client.wait_for_ready(timeout=timeout)
        except RuntimeError as exc:
            raise JupyterHandshakeError("timeout", str(exc)) from exc

        req_id = client.kernel_info()
        deadline = time.monotonic() + timeout
        info: Dict[str, Any] = {}
        while time.monotonic() < deadline:
            reply = client.get_shell_msg(timeout=max(0.1, deadline - time.monotonic()))
            if (reply.get("parent_header") or {}).get("msg_id") == req_id:
                info = reply.get("content") or {}
                break

        llmnb_meta = info.get("llmnb") if isinstance(info.get("llmnb"), dict) else {}
        remote_wire = llmnb_meta.get("wire_version") or _versions.WIRE_VERSION
        if _versions.semver_major(remote_wire) != _versions.semver_major(_versions.WIRE_VERSION):
            raise JupyterVersionMismatchError(
                f"wire major mismatch: kernel={remote_wire!r} client={_versions.WIRE_VERSION!r}",
                payload=info,
            )

        comm_id = uuid.uuid4().hex
        open_msg = client.session.msg(
            "comm_open",
            {"comm_id": comm_id, "target_name": target, "data": {}},
        )
        client.shell_channel.send(open_msg)

        ci_id = client.comm_info(target_name=target)
        open_comms: Dict[str, Any] = {}
        while time.monotonic() < deadline:
            reply = client.get_shell_msg(timeout=max(0.1, deadline - time.monotonic()))
            if (reply.get("parent_header") or {}).get("msg_id") == ci_id:
                open_comms = (reply.get("content") or {}).get("comms") or {}
                break
        if comm_id not in open_comms:
            raise JupyterHandshakeError(
                "comm_rejected",
                f"kernel rejected Comm open for target {target!r}",
                payload=info,
            )

        session_id = str(client.session.session or uuid.uuid4())
        return JupyterKernelConnection(
            client=client,
            comm_id=comm_id,
            comm_target=target,
            session_id=session_id,
            wire_version=remote_wire,
            kernel_info=info,
            manager=_manager,
        )
    except BaseException:
        try:
            client.stop_channels()
        except Exception:
            pass
        raise


def start_kernel(
    *,
    kernel_name: str = "llmnb",
    workdir: Optional[Path] = None,
    notebook_path: Optional[Path] = None,
    extra_env: Optional[Dict[str, str]] = None,
    timeout: float = 30.0,
) -> JupyterKernelConnection:
    env = dict(os.environ)
    if workdir is not None:
        env["LLMNB_WORKDIR"] = str(Path(workdir).resolve())
    if notebook_path is not None:
        env["LLMNB_NOTEBOOK_PATH"] = str(Path(notebook_path).resolve())
    if extra_env:
        env.update(extra_env)

    km = KernelManager(kernel_name=kernel_name)
    km.start_kernel(env=env)
    try:
        return connect(km.connection_file, timeout=timeout, _manager=km)
    except BaseException:
        try:
            km.shutdown_kernel(now=True)
        except Exception:
            pass
        raise
