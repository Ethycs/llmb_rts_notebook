"""
Package-private test scaffolding for llm_client.

Modules here may use unittest.mock and kernel internals that violate the
llm_client → llm_kernel.wire lint boundary. This exemption is intentional
and documented in each module's header. Do not import these helpers from
production code.
"""
