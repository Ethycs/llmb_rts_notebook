"""
Test-scaffolding shim: exposes kernel smoke functions for llmnb smoke <name>.

Lint exemption: this module imports directly from llm_kernel internals
(agent_supervisor, paper_telephone, metadata_writer dispatch functions).
Exempted because:
- It is package-private (_test_helpers)
- It has no production callers — only llm_client.cli.smoke calls it
- Smokes are test-scaffolding per PLAN-S5.0.3 §3 option (a)

V2 plan: remove the smoke aliases entirely and ship smoke coverage via
llmnb execute against a test fixture instead.
"""

from llm_kernel.__main__ import (  # noqa: F401
    _run_agent_supervisor_smoke as run_supervisor,
    _run_paper_telephone_smoke as run_paper_telephone,
    _run_metadata_writer_smoke as run_metadata_writer,
    _run_pty_mode_smoke as run_pty,
)


def run_jupyter() -> int:
    import tempfile
    from pathlib import Path

    from llm_client.transport.jupyter import MIME_RUN, start_kernel
    from llm_kernel.wire import versions as _versions

    with tempfile.TemporaryDirectory(prefix="llmnb-jupyter-smoke-") as tmp:
        with start_kernel(kernel_name="llmnb", workdir=Path(tmp), timeout=30.0) as conn:
            info = conn.kernel_info
            if info.get("implementation") != "llmnb":
                print(f"FAIL: unexpected implementation={info.get('implementation')!r}", flush=True)
                return 1
            lang = info.get("language_info") or {}
            if lang.get("name") != "llmnb":
                print(f"FAIL: unexpected language_info={lang!r}", flush=True)
                return 1
            if conn.comm_target != _versions.COMM_TARGET:
                print(f"FAIL: unexpected comm_target={conn.comm_target!r}", flush=True)
                return 1
            result = conn.execute_cell("@status", cell_id="smoke-cell-1", timeout=15.0)
            if (result.get("reply") or {}).get("status") != "ok":
                print(f"FAIL: @status reply={result.get('reply')!r}", flush=True)
                return 1
            outputs = result.get("outputs") or []
            saw_family_a = any(
                o["msg_type"] in ("display_data", "update_display_data")
                and MIME_RUN in ((o.get("content") or {}).get("data") or {})
                for o in outputs
            )
            if not saw_family_a:
                print("FAIL: missing Family A application/vnd.rts.run+json IOPub span", flush=True)
                return 1
    print("OK: jupyter smoke complete", flush=True)
    return 0
