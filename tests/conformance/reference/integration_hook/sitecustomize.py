"""Verifier-side instrumentation for kernel subprocesses (integration tests).

Loaded automatically by the interpreter when this directory is first on
PYTHONPATH. Two independent, opt-in behaviours:

* ``LLMNB_HOOK_OUT`` set: count how often the public facade lifecycle
  (``llm_kernel.Kernel.start/shutdown``) and the legacy
  ``_kernel_hooks.attach_kernel_subsystems`` bootstrap run in the process,
  and append the counts (plus the live thread names at interpreter exit)
  to that file as one JSON line. Same hook as the facade-consumers merge
  task; wrappers are transparent.
* ``LLMNB_VERSION_PROBE`` set: before any entry point is imported, set the
  kernel version in the single version source the drift-everywhere branch
  introduced (``llm_kernel.wire.versions``, the module its own tests, its
  setup.py and the notebook client read). Every advertised kernel version
  must then follow it; a copy left behind by a merge keeps the old value.
"""
from __future__ import annotations

import atexit
import json
import os
import threading

_OUT = os.environ.get("LLMNB_HOOK_OUT")
_PROBE = os.environ.get("LLMNB_VERSION_PROBE")

if _PROBE:
    try:
        from llm_kernel.wire import versions as _versions

        _versions.KERNEL_VERSION = _PROBE
    except Exception as exc:  # reported by the test through the hook record
        os.environ["LLMNB_VERSION_PROBE_ERROR"] = repr(exc)

if _OUT:
    _counts = {"kernel_start": 0, "kernel_shutdown": 0, "attach_kernel_subsystems": 0}
    _lock = threading.Lock()

    def _bump(key: str) -> None:
        with _lock:
            _counts[key] += 1

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
        import llm_kernel._kernel_hooks as hooks

        _wrap_async(llm_kernel.Kernel, "start", "kernel_start")
        _wrap_async(llm_kernel.Kernel, "shutdown", "kernel_shutdown")
        original_attach = hooks.attach_kernel_subsystems

        def attach(*args, **kwargs):
            _bump("attach_kernel_subsystems")
            return original_attach(*args, **kwargs)

        hooks.attach_kernel_subsystems = attach

    def _dump() -> None:
        payload = dict(_counts)
        payload["pid"] = os.getpid()
        payload["threads_at_exit"] = sorted(
            t.name for t in threading.enumerate() if t is not threading.main_thread()
        )
        if os.environ.get("LLMNB_VERSION_PROBE_ERROR"):
            payload["probe_error"] = os.environ["LLMNB_VERSION_PROBE_ERROR"]
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
