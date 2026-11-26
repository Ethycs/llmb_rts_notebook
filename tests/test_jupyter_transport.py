from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict

import pytest
from jupyter_client.kernelspec import KernelSpecManager

from llm_client.boot import connect_to_kernel
from llm_client.cli.__main__ import main as cli_main
from llm_client.transport.jupyter import (
    JupyterHandshakeError,
    MIME_RUN,
    connect as jupyter_connect,
    start_kernel,
)
from llm_kernel.wire import versions as _versions


def _shell_reply(client, msg_id: str, timeout: float = 15.0) -> Dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        msg = client.get_shell_msg(timeout=max(0.1, deadline - time.monotonic()))
        if (msg.get("parent_header") or {}).get("msg_id") == msg_id:
            return msg.get("content") or {}
    raise TimeoutError(f"no shell reply for {msg_id}")


def test_llmnb_kernelspec_installed_and_cli_round_trip(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    specs = KernelSpecManager().get_all_specs()
    assert "llmnb" in specs
    assert specs["llmnb"]["spec"]["language"] == "llmnb"
    assert specs["llmnb"]["spec"]["interrupt_mode"] == "message"

    assert cli_main(["kernelspec", "show"]) == 0
    shown = json.loads(capsys.readouterr().out)
    assert shown["display_name"] == "LLMNB"
    assert shown["language"] == "llmnb"
    assert shown["metadata"]["llmnb"]["comm_target"] == _versions.COMM_TARGET

    prefix = tmp_path / "custom-prefix"
    assert cli_main(["kernelspec", "install", "--prefix", str(prefix), "--name", "llmnb_custom"]) == 0
    installed = prefix / "share" / "jupyter" / "kernels" / "llmnb_custom" / "kernel.json"
    assert installed.exists()
    capsys.readouterr()

    assert cli_main(["kernelspec", "list"]) == 0
    assert "llmnb" in capsys.readouterr().out


@pytest.mark.integration
def test_live_zmq_kernel_full_protocol_and_multiclient(tmp_path: Path) -> None:
    nb_path = tmp_path / "live.llmnb"
    with start_kernel(
        kernel_name="llmnb",
        workdir=tmp_path,
        notebook_path=nb_path,
        extra_env={"LLMKERNEL_LITELLM_ENDPOINT_URL": "http://127.0.0.1:1/v1"},
        timeout=30.0,
    ) as primary:
        info = primary.kernel_info
        assert info["status"] == "ok"
        assert info["implementation"] == "llmnb"
        assert info["language_info"]["name"] == "llmnb"
        assert info["llmnb"]["comm_target"] == _versions.COMM_TARGET

        assert primary.client.is_alive()

        exec_status = primary.execute_cell(
            "@status",
            cell_id="zmq-c1",
            user_expressions={"ver": "snapshot_version"},
        )
        assert exec_status["reply"]["status"] == "ok"
        assert exec_status["reply"]["user_expressions"]["ver"]["status"] == "ok"
        assert any(
            o["msg_type"] == "display_data" and MIME_RUN in o["content"]["data"]
            for o in exec_status["outputs"]
        )
        assert any(
            o["msg_type"] == "update_display_data"
            and o["content"]["data"][MIME_RUN]["status"]["code"] == "STATUS_CODE_OK"
            for o in exec_status["outputs"]
        )
        assert any(o["msg_type"] == "execute_result" for o in exec_status["outputs"])

        exec_sec = primary.execute_cell(
            '@@section "Live Section" id:"sec_live"', cell_id="zmq-c2"
        )
        assert exec_sec["reply"]["status"] == "ok"

        exec_exp = primary.execute_cell(
            '@@export path:"out.magic"', cell_id="zmq-c3"
        )
        assert exec_exp["reply"]["status"] == "ok"
        assert (tmp_path / "out.magic").exists()

        exec_err = primary.execute_cell("@@no_such_magic", cell_id="zmq-err")
        assert exec_err["reply"]["status"] == "error"
        assert exec_err["reply"]["ename"] == "K31"
        assert any(o["msg_type"] == "error" for o in exec_err["outputs"])

        kc = primary.client
        comp = _shell_reply(kc, kc.complete("@@se", 4))
        assert comp["status"] == "ok"
        assert "@@section" in comp["matches"]

        insp = _shell_reply(kc, kc.inspect("@@export", 4, detail_level=1))
        assert insp["status"] == "ok"
        assert insp["found"] is True
        assert "K3M" in insp["data"]["text/plain"]

        isc = _shell_reply(kc, kc.is_complete("@@markdown"))
        assert isc["status"] == "incomplete"
        isc_ok = _shell_reply(kc, kc.is_complete('@@section "Done"'))
        assert isc_ok["status"] == "complete"

        hist = _shell_reply(kc, kc.history(raw=True, output=True, hist_access_type="tail", n=2))
        assert hist["status"] == "ok"
        assert len(hist["history"]) == 2

        with pytest.raises(JupyterHandshakeError) as exc_info:
            jupyter_connect(
                primary.connection_file, comm_target="llmnb.rts.v99", timeout=10.0
            )
        assert exc_info.value.reason == "comm_rejected"

        with connect_to_kernel(
            f"jupyter://{primary.connection_file}", transport="jupyter", timeout=15.0
        ) as secondary:
            corr_id = "33333333-3333-4333-8333-333333333333"
            secondary.send(
                {
                    "type": "agent_graph.query",
                    "correlation_id": corr_id,
                    "payload": {"query_type": "list_agents"},
                }
            )
            deadline = time.monotonic() + 10.0
            seen_primary = False
            seen_secondary = False
            while time.monotonic() < deadline and not (seen_primary and seen_secondary):
                if not seen_primary:
                    p_frame = primary.recv(timeout=0.2)
                    if p_frame.get("type") == "agent_graph.response" and p_frame.get("correlation_id") == corr_id:
                        seen_primary = True
                if not seen_secondary:
                    s_frame = secondary.recv(timeout=0.2)
                    if s_frame.get("type") == "agent_graph.response" and s_frame.get("correlation_id") == corr_id:
                        seen_secondary = True
            assert seen_primary and seen_secondary

        primary._manager.interrupt_kernel()
        alive_exec = primary.execute_cell(
            "@@scratch\nstill alive",
            cell_id="zmq-c4",
            user_expressions={"secs": "sections"},
        )
        assert alive_exec["reply"]["status"] == "ok"
        assert "sec_live" in alive_exec["reply"]["user_expressions"]["secs"]["data"]["application/json"]

        src_magic = tmp_path / "attach.magic"
        out_llmnb = tmp_path / "attach_out.llmnb"
        src_magic.write_text('@@section "Via CLI" id:"sec_cli"\n', encoding="utf-8")
        rc = cli_main(
            [
                "execute",
                str(src_magic),
                "--output",
                str(out_llmnb),
                "--mode",
                "live",
                "--connect",
                f"jupyter://{primary.connection_file}",
                "--quiescence-window",
                "0.5",
            ]
        )
        assert rc == 0
        assert out_llmnb.exists()

        assert primary.execute_cell(
            '@@section "After Attach" id:"sec_after"', cell_id="zmq-c5"
        )["reply"]["status"] == "ok"

    assert nb_path.exists()
    saved = json.loads(nb_path.read_text(encoding="utf-8"))
    assert saved["metadata"]["kernelspec"]["name"] == "llmnb"
    assert "sec_cli" in saved["metadata"]["rts"]["zone"]["sections"]
    assert "sec_after" in saved["metadata"]["rts"]["zone"]["sections"]
