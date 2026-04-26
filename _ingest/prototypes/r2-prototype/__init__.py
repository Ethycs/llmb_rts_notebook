"""R2-prototype harness for verifying the RFC-002 Claude Code provisioning recipe.

This package is a self-contained smoke test for the paper-telephone topology:
a stub LLMKernel MCP server, a stub LiteLLM proxy that forwards to the real
Anthropic API, and a Claude Code subprocess wired to talk to both.

Entry point: ``run_smoke.py``.
"""
