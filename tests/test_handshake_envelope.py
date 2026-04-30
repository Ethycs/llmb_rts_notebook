"""tests/test_handshake_envelope.py — handshake envelope validation (S5.0.3d).

Exercises the kernel-side handshake validator in
``llm_kernel.serve_mode._validate_handshake`` directly (no socket plumbing).
This keeps the unit tests fast; full TCP boot is in
``test_tcp_transport.py``.

Cases:
    * Right token + right wire-version  -> accepted (no error code).
    * Wrong token                       -> ``auth_failed``.
    * Missing auth block                -> ``auth_failed``.
    * Missing token field               -> ``auth_failed``.
    * Major-version mismatch            -> ``version_mismatch_major``.
    * Minor-version skew                -> accepted, ``minor_version_skew`` warning.
    * Malformed envelope (no ``type``)  -> ``wire-failure``.
    * Malformed payload                 -> ``wire-failure``.
"""

from __future__ import annotations

import pytest

from llm_kernel.serve_mode import _validate_handshake
from llm_kernel.wire import WIRE_MAJOR, WIRE_VERSION


_GOOD_TOKEN = "good-token-not-real"
_BAD_TOKEN = "wrong-token-not-real"


def _request(
    *,
    wire_version: str = WIRE_VERSION,
    token: str | None = _GOOD_TOKEN,
    auth_block: dict | None = None,
    transport: str = "tcp",
    drop_payload: bool = False,
    drop_type: bool = False,
) -> dict:
    payload: dict = {
        "client_name": "test",
        "client_version": "0.0.1",
        "wire_version": wire_version,
        "transport": transport,
        "capabilities": ["family_a", "family_b", "family_c", "family_f", "family_g"],
    }
    if auth_block is not None:
        payload["auth"] = auth_block
    elif token is not None:
        payload["auth"] = {"scheme": "bearer", "token": token}
    envelope: dict = {"type": "kernel.handshake", "payload": payload}
    if drop_payload:
        envelope.pop("payload")
    if drop_type:
        envelope.pop("type")
    return envelope


def test_handshake_accepted_with_right_token() -> None:
    err, warnings = _validate_handshake(_request(), expected_token=_GOOD_TOKEN)
    assert err is None
    assert warnings == []


def test_handshake_minor_skew_accepts_with_warning() -> None:
    # WIRE_VERSION is "1.0.0" in V1.5; a "1.99.0" client is forward-minor-skew.
    err, warnings = _validate_handshake(
        _request(wire_version=f"{WIRE_MAJOR}.99.0"), expected_token=_GOOD_TOKEN,
    )
    assert err is None
    assert "minor_version_skew" in warnings


def test_handshake_rejects_wrong_token() -> None:
    err, _ = _validate_handshake(
        _request(token=_BAD_TOKEN), expected_token=_GOOD_TOKEN,
    )
    assert err == "auth_failed"


def test_handshake_rejects_missing_auth_block() -> None:
    err, _ = _validate_handshake(
        _request(token=None), expected_token=_GOOD_TOKEN,
    )
    assert err == "auth_failed"


def test_handshake_rejects_empty_token() -> None:
    err, _ = _validate_handshake(
        _request(token=""), expected_token=_GOOD_TOKEN,
    )
    assert err == "auth_failed"


def test_handshake_rejects_wrong_scheme() -> None:
    err, _ = _validate_handshake(
        _request(auth_block={"scheme": "basic", "token": _GOOD_TOKEN}),
        expected_token=_GOOD_TOKEN,
    )
    assert err == "auth_failed"


def test_handshake_rejects_major_mismatch() -> None:
    err, _ = _validate_handshake(
        _request(wire_version=f"{WIRE_MAJOR + 1}.0.0"),
        expected_token=_GOOD_TOKEN,
    )
    assert err == "version_mismatch_major"


def test_handshake_rejects_missing_type() -> None:
    err, _ = _validate_handshake(
        _request(drop_type=True), expected_token=_GOOD_TOKEN,
    )
    assert err == "wire-failure"


def test_handshake_rejects_missing_payload() -> None:
    err, _ = _validate_handshake(
        _request(drop_payload=True), expected_token=_GOOD_TOKEN,
    )
    assert err == "wire-failure"


def test_handshake_rejects_non_dict() -> None:
    err, _ = _validate_handshake([], expected_token=_GOOD_TOKEN)  # type: ignore[arg-type]
    assert err == "wire-failure"


def test_handshake_rejects_non_string_wire_version() -> None:
    bad = _request()
    bad["payload"]["wire_version"] = 1.0  # type: ignore[index]
    err, _ = _validate_handshake(bad, expected_token=_GOOD_TOKEN)
    assert err == "wire-failure"


def test_handshake_rejects_garbage_wire_version() -> None:
    err, _ = _validate_handshake(
        _request(wire_version="not-a-version"), expected_token=_GOOD_TOKEN,
    )
    assert err == "wire-failure"


@pytest.mark.parametrize("token_a,token_b,expected", [
    (_GOOD_TOKEN, _GOOD_TOKEN, None),
    (_GOOD_TOKEN, _GOOD_TOKEN + "x", "auth_failed"),
    (_GOOD_TOKEN, _GOOD_TOKEN[:-1], "auth_failed"),
])
def test_handshake_constant_time_compare_semantics(
    token_a: str, token_b: str, expected: str | None,
) -> None:
    """Sanity-check that the validator uses equality semantics that pass
    constant-time compare (subtle off-by-one truncation must reject)."""
    err, _ = _validate_handshake(_request(token=token_a), expected_token=token_b)
    assert err == expected
