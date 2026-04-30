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
