"""RFC-008 §4 ready handshake: the first data-plane frame is a ``kernel.ready`` LogRecord carrying
``llmnb.kernel.version``, ``.session_id``, ``.python_version`` and one ``.rfc_NNN_version`` per RFC
the single version source defines."""
from __future__ import annotations

import sys
from typing import Any, Dict, List

from llm_kernel._internal._attrs import decode_attrs
from llm_kernel.transports import pty_mode
from llm_kernel.wire import versions


class _CaptureWriter:
    def __init__(self) -> None:
        self.frames: List[Dict[str, Any]] = []

    def write_frame(self, record: Dict[str, Any]) -> None:
        self.frames.append(record)


def _ready_attrs(session_id: str) -> Dict[str, Any]:
    w = _CaptureWriter()
    pty_mode._emit_ready_handshake(w, session_id)
    assert len(w.frames) == 1
    frame = w.frames[0]
    assert frame["body"]["stringValue"] == "kernel.ready"
    return decode_attrs(frame["attributes"])


def test_ready_frame_carries_the_rfc008_attributes():
    attrs = _ready_attrs("sess-ready-1")
    assert attrs["event.name"] == "kernel.ready"
    assert attrs["llmnb.kernel.session_id"] == "sess-ready-1"
    assert attrs["llmnb.kernel.version"] == versions.KERNEL_VERSION
    v = sys.version_info
    assert attrs["llmnb.kernel.python_version"] == f"{v.major}.{v.minor}.{v.micro}"
    for key, value in versions.RFC_VERSIONS.items():
        assert attrs[f"llmnb.kernel.{key}"] == value


def test_ready_frame_session_id_is_the_callers():
    assert _ready_attrs("a")["llmnb.kernel.session_id"] == "a"
    assert _ready_attrs("b")["llmnb.kernel.session_id"] == "b"
