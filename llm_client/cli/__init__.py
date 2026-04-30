"""
llm_client.cli — `llmnb` command-line entry point (PLAN-S5.0.3 §6).

Subcommand modules live in this package; ``__main__.py`` is the
argparse dispatcher.

Public CLI surface (``python -m llm_client <subcommand>``):
    execute  <path> [--output OUT] [--mode {stub,live,replay}]
                    [--replay FILE] [--record FILE] [--unattended]
    convert  <input> <output>
    validate <path>
    smoke    {paper-telephone,supervisor,metadata-writer}
    auth     init
    serve    [--bind HOST:PORT] [--auth-token-env NAME]   (stub for S5.0.3d)
"""

from __future__ import annotations

__all__ = ["main"]

from .__main__ import main
