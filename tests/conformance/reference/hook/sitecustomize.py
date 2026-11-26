"""Verifier-side instrumentation for kernel subprocesses.

Loaded automatically by the interpreter when this directory is first on
PYTHONPATH. When ``LLMNB_HOOK_OUT`` is set, counts how often the public
facade and subsystem lifecycles run in the process and writes the counts
(plus the live thread names at interpreter exit) to that file as JSON.

Only public names are wrapped: ``llm_kernel.Kernel`` (start/shutdown),
``CustomMessageDispatcher`` (construction/start), ``MetadataWriter``
(construction/start) and ``_kernel_hooks.attach_kernel_subsystems``. The
wrappers are transparent: they call the original and return its result.
"""
from __future__ import annotations

import atexit
import json
import os
import threading

_OUT = os.environ.get("LLMNB_HOOK_OUT")

if _OUT:
    _counts = {
        "kernel_start": 0,
        "kernel_shutdown": 0,
        "dispatcher_init": 0,
        "dispatcher_start": 0,
        "metadata_writer_init": 0,
        "metadata_writer_start": 0,
        "attach_kernel_subsystems": 0,
    }
    _lock = threading.Lock()

    def _bump(key: str) -> None:
        with _lock:
            _counts[key] += 1

    def _wrap_sync(cls, name: str, key: str) -> None:
        original = getattr(cls, name)

        def wrapper(self, *args, **kwargs):
            _bump(key)
            return original(self, *args, **kwargs)

        wrapper.__name__ = getattr(original, "__name__", name)
        wrapper.__doc__ = getattr(original, "__doc__", None)
        setattr(cls, name, wrapper)

    def _wrap_async(cls, name: str, key: str) -> None:
        original = getattr(cls, name)

        async def wrapper(self, *args, **kwargs):
            _bump(key)
            return await original(self, *args, **kwargs)

        wrapper.__name__ = getattr(original, "__name__", name)
        wrapper.__doc__ = getattr(original, "__doc__", None)
        setattr(cls, name, wrapper)

    def _install() -> None:
        import llm_kernel
        from llm_kernel.capture.custom_messages import CustomMessageDispatcher
        from llm_kernel.capture.metadata_writer import MetadataWriter
        import llm_kernel._kernel_hooks as hooks

        _wrap_async(llm_kernel.Kernel, "start", "kernel_start")
        _wrap_async(llm_kernel.Kernel, "shutdown", "kernel_shutdown")
        _wrap_sync(CustomMessageDispatcher, "__init__", "dispatcher_init")
        _wrap_sync(CustomMessageDispatcher, "start", "dispatcher_start")
        _wrap_sync(MetadataWriter, "__init__", "metadata_writer_init")
        _wrap_sync(MetadataWriter, "start", "metadata_writer_start")

        original_attach = hooks.attach_kernel_subsystems

        def attach(*args, **kwargs):
            _bump("attach_kernel_subsystems")
            return original_attach(*args, **kwargs)

        hooks.attach_kernel_subsystems = attach

    def _dump() -> None:
        payload = dict(_counts)
        payload["threads_at_exit"] = sorted(
            t.name for t in threading.enumerate() if t is not threading.main_thread()
        )
        payload["pid"] = os.getpid()
        try:
            with open(_OUT, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(payload) + "\n")
        except OSError:
            pass

    try:
        _install()
    except Exception as exc:  # the test reports a missing hook as a failure
        _counts["hook_error"] = repr(exc)  # type: ignore[assignment]
    atexit.register(_dump)
