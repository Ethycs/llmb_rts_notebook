"""
llm_client.__main__ — `python -m llm_client` entry point.

Delegates to the CLI dispatcher. The `llmnb` console-script entry point
(installed via pyproject.toml in S5.0.3e) calls the same ``main()``.
"""

from __future__ import annotations

from llm_client.cli.__main__ import main

if __name__ == "__main__":
    raise SystemExit(main())
