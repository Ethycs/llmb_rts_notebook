"""
llm_client.transport — transport adapters for KernelConnection.

V1 supports:
    pty   — in-process boot via boot_minimal_kernel (default)
    unix  — Unix socket client (thin wrapper, same process or local)
    tcp   — TCP + bearer-token auth (S5.0.3d; stub raises NotImplementedError)

Each submodule exposes ``connect(...) -> KernelConnection``.
"""
