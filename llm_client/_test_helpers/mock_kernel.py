"""
Test scaffolding for kernel boot. Required because the in-process
kernel dispatcher currently expects a kernel-shaped object even when
no IPython is actually involved. Once the kernel is fully
process-separated (5.0.3d external transport), this scaffolding goes
away.

Lint exemption: this file imports from kernel internals via
unittest.mock.MagicMock for type compatibility, which violates the
llm_client → llm_kernel.wire boundary. Exempted because:
- it's test scaffolding only
- it's package-private (_test_helpers)
- it has no production callers

Trade-off documented: V1 boot_minimal_kernel must instantiate a
MagicMock-shaped kernel because CustomMessageDispatcher + AgentSupervisor
expect an IPython kernel object. The clean path is 5.0.3d's external
connect_to_kernel(), which runs without any in-process scaffolding.
"""

from unittest.mock import MagicMock


class _Sink:
    """Minimal session sink: swallows all send() calls silently."""

    def send(self, *args, **kwargs) -> None:  # noqa: ANN001, D401
        pass


class _CommMgr:
    """Minimal comm manager stub: no-ops register/unregister."""

    def register_target(self, name: str, cb) -> None:  # noqa: ANN001
        pass

    def unregister_target(self, name: str, cb) -> None:  # noqa: ANN001
        pass


def make_mock_kernel() -> MagicMock:
    """Return a MagicMock shaped like an IPython kernel.

    Provides the minimal surface that CustomMessageDispatcher and
    AgentSupervisor require:
    - kernel.session  (with a working .send())
    - kernel.iopub_socket
    - kernel.shell.comm_manager
    - kernel._parent_header
    """
    kernel = MagicMock()
    kernel.session = _Sink()
    kernel.iopub_socket = MagicMock()
    kernel.shell.comm_manager = _CommMgr()
    kernel._parent_header = {}
    return kernel
