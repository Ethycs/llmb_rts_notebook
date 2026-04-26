"""Stub LiteLLM-shaped proxy for the R2-prototype harness.

A FastAPI server with a single route, ``POST /v1/messages``, that forwards
to ``https://api.anthropic.com/v1/messages`` using ``ANTHROPIC_API_KEY`` from
the parent environment. Streams the upstream response through, and logs each
request/response pair as one JSON line to ``run.log`` next to this file.

Allocates a free ephemeral port up front (via a transient socket bind) and
prints the bound URL on stdout as the *first* line, so the orchestrator can
parse it out and feed it to ``ANTHROPIC_BASE_URL``. Subsequent stdout is
uvicorn's startup banner; the orchestrator ignores it.

Claude Code uses the Anthropic-native Messages API when ``ANTHROPIC_BASE_URL``
is set, so this proxy does not need to translate the OpenAI shape.
"""

from __future__ import annotations

import json
import os
import pathlib
import signal
import socket
import sys
from datetime import datetime, timezone
from typing import Any

import httpx
import uvicorn
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse

_HERE = pathlib.Path(__file__).resolve().parent
_RUN_LOG = _HERE / "run.log"
_UPSTREAM_BASE = "https://api.anthropic.com"
_FORWARD_HEADERS = {
    "x-api-key",
    "anthropic-version",
    "anthropic-beta",
    "content-type",
    "accept",
}

app = FastAPI(title="r2-prototype-stub-litellm-proxy")


def _allocate_free_port() -> int:
    """Bind a transient socket to port 0, read back the OS-assigned port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _log_pair(record: dict[str, Any]) -> None:
    """Append one JSON line documenting a request/response pair."""
    record["ts"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    try:
        _RUN_LOG.parent.mkdir(parents=True, exist_ok=True)
        with _RUN_LOG.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError as exc:  # pragma: no cover — best-effort logging
        print(f"[stub_proxy] run.log write failed: {exc}", file=sys.stderr)


def _filter_request_headers(incoming: dict[str, str]) -> dict[str, str]:
    """Pass through only headers Anthropic's API needs; inject the API key."""
    out: dict[str, str] = {}
    for key, value in incoming.items():
        if key.lower() in _FORWARD_HEADERS:
            out[key] = value
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if api_key:
        out["x-api-key"] = api_key
    out.setdefault("anthropic-version", "2023-06-01")
    return out


@app.post("/v1/messages")
async def forward_messages(request: Request) -> Response:
    """Forward the incoming Messages-API request to Anthropic and stream back."""
    body_bytes = await request.body()
    try:
        body_json = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}
    except json.JSONDecodeError:
        body_json = {"_raw": body_bytes.decode("utf-8", errors="replace")}
    headers = _filter_request_headers(dict(request.headers))
    streaming = bool(body_json.get("stream"))

    client = httpx.AsyncClient(timeout=httpx.Timeout(60.0, read=120.0))
    upstream_req = client.build_request(
        "POST", f"{_UPSTREAM_BASE}/v1/messages", content=body_bytes, headers=headers
    )
    upstream = await client.send(upstream_req, stream=streaming)

    if not streaming:
        try:
            payload = await upstream.aread()
        finally:
            await upstream.aclose()
            await client.aclose()
        try:
            parsed: Any = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            parsed = {"_raw_bytes": len(payload)}
        _log_pair(
            {
                "direction": "non-stream",
                "request": body_json,
                "status": upstream.status_code,
                "response": parsed,
            }
        )
        return Response(
            content=payload,
            status_code=upstream.status_code,
            media_type=upstream.headers.get("content-type", "application/json"),
        )

    async def _streamer() -> Any:
        chunks: list[bytes] = []
        try:
            async for chunk in upstream.aiter_bytes():
                chunks.append(chunk)
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()
            _log_pair(
                {
                    "direction": "stream",
                    "request": body_json,
                    "status": upstream.status_code,
                    "response_bytes": sum(len(c) for c in chunks),
                    "response_preview": b"".join(chunks)[:2048].decode(
                        "utf-8", errors="replace"
                    ),
                }
            )

    return StreamingResponse(
        _streamer(),
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type", "text/event-stream"),
    )


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    """Liveness probe used by the orchestrator before it spawns Claude Code."""
    return {"status": "ok"}


def _install_signal_handlers() -> None:
    """Translate SIGTERM into a clean shutdown via SIGINT semantics."""

    def _handler(signum: int, frame: Any) -> None:  # pragma: no cover
        raise KeyboardInterrupt

    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _handler)


def main() -> None:
    """Bind a port, announce it on stdout, run uvicorn until shutdown."""
    port = _allocate_free_port()
    url = f"http://127.0.0.1:{port}"
    print(url, flush=True)
    _install_signal_handlers()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
