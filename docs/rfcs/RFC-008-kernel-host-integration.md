# RFC-008 — Kernel host integration (PTY + socket two-channel transport)

## Status

Draft. Date: 2026-04-29. Version: 1.0.1.

**Changelog**:
- v1.0.1 (additive, PLAN-S5.0.3d, 2026-04-29): adds §"Other transports" noting that TCP is supported behind the same envelope contract specified in [RFC-006](RFC-006-kernel-extension-wire-format.md) v2.1.0. PTY remains the V1 default for local extension-kernel integration; TCP (PLAN-S5.0.3d) is the V1.5 transport for headless / external-driver deployments. Both transports open with the `kernel.handshake` envelope and dispatch identical Family A/B/C/F/G payloads after handshake success. No PTY-side behavior changes.

This RFC is the layer-3/4 (transport binding) normative specification for how the VS Code extension hosts and communicates with LLMKernel. It is the V1 substitute for any "Jupyter Server" assumption inherited from `vscode-jupyter`'s legacy code: the extension launches LLMKernel as a subprocess directly, with no Jupyter Server, no kernelspec discovery, and no `@jupyterlab/services` dependency.

Conforming implementations attach to this exact version string; deviations require an RFC update, not a code workaround.

## Source ADRs and prior RFCs

- [DR-0009 — VS Code NotebookController API; no Jupyter kernel](../decisions/0009-notebook-controller-no-jupyter-kernel.md)
- [DR-0011 — Subtractive fork of vscode-jupyter](../decisions/0011-subtractive-fork-vscode-jupyter.md)
- [DR-0012 — LLMKernel as sole kernel](../decisions/0012-llmkernel-sole-kernel.md)
- [DR-0015 — paper-telephone bidirectional MCP between kernel and extension](../decisions/0015-kernel-extension-bidirectional-mcp.md)
- [DR-0016 — RFC-driven standards discipline](../decisions/0016-rfc-standards-discipline.md)
- [RFC-006](RFC-006-kernel-extension-wire-format.md) — wire format; this RFC binds it to a transport
- [RFC-007](RFC-007-tape-otlp-logs.md) — `.tape` files (queued); the data plane is a tape source verbatim
- [RFC-005](RFC-005-llmnb-file-format.md) — `metadata.rts` persistent format consumed by Family F over the data plane

## Context

[Chapter 06 §"Notebook UI without a Jupyter kernel"](../dev-guide/06-vscode-notebook-substrate.md) commits V1 to "no Jupyter kernel, no Python expectation collision, no kernel discovery and selection ceremony, no subprocess management for the kernel itself" — and adds the escape hatch: VS Code's `NotebookController.executeHandler` runs inside the extension host and dispatches to LLMKernel "over the daemon's existing transport (the same one the MCP server uses)."

[DR-0015 §"LLMKernel as MCP/PTY mediator"](../decisions/0015-kernel-extension-bidirectional-mcp.md) refines this further: the kernel sits in the path of every agent interaction "like a Unix PTY between two processes pretending to be a terminal to each, observing and potentially transforming everything that flows through." The PTY framing is *literal*, not metaphorical — and it composes recursively when the **extension** is the kernel's PTY parent and the **kernel** is each agent's PTY parent.

The R1 refactor's `JupyterKernelClient` used `@jupyterlab/services` to talk to a Jupyter Server. That was always a transition state — the production architecture has no Jupyter Server. This RFC specifies the V1 production transport: a two-channel arrangement that cleanly separates structured protocol traffic from human-facing terminal interaction.

The two-channel split is the load-bearing decision. A single PTY-stream that mixed JSON envelopes with Python tracebacks would conflate two different reliability domains: the data plane (parser-stable, no terminal-mode quirks) and the control plane (operator-readable, signal-deliverable, may carry pre-pipeline output). Separating them lets each be optimized for its job.

## Specification

### §1 — Architecture

```
                  ┌──────────────────────────────────────┐
                  │   Extension host (TypeScript)        │
                  │                                       │
                  │  PtyKernelClient                      │
                  │   ├─ node-pty.spawn → kernel proc     │
                  │   ├─ Socket listener (UDS / pipe)     │
                  │   ├─ JSON-line dispatcher:            │
                  │   │    ├─ traceId+spanId  → Family A  │
                  │   │    ├─ timeUnixNano    → LogRecord │
                  │   │    └─ type+payload    → Comm B-F  │
                  │   ├─ SIGINT on operator interrupt     │
                  │   └─ vscode.Pseudoterminal (debug)    │
                  └────┬───────────────────────┬──────────┘
                       │ PTY                   │ Socket
                       │ (control plane)       │ (data plane)
                  ┌────▼───────────────────────▼──────────┐
                  │   LLMKernel (Python, pty-mode)        │
                  │                                       │
                  │  - termios raw on startup              │
                  │  - logging.Handler → OTLP LogRecord    │
                  │  - run_tracker → Family A spans       │
                  │  - custom_messages → Comm B-F          │
                  │  - SIGINT handler → interrupt run      │
                  └────────────────┬──────────────────────┘
                                   │ PTY (kernel-managed)
                  ┌────────────────▼──────────────────────┐
                  │   Claude Code subprocess (agent)      │
                  └───────────────────────────────────────┘
```

Two transports bind the extension to the kernel:

- **Control plane (PTY)**: a `node-pty` instance. Carries kernel boot output, fatal tracebacks, signal delivery, and (optionally) interactive REPL/debug. Single OS-level pseudoterminal.
- **Data plane (socket)**: a Unix domain socket on POSIX, a named pipe on Windows, or loopback TCP as fallback. Carries every byte of structured protocol traffic — OTel `Span`, OTel `LogRecord`, RFC-006 Comm envelopes — as newline-delimited JSON.

The extension is the active party for both: it allocates the socket address before spawning the kernel, passes the address via env var, listens. It spawns the kernel via `node-pty` with the socket env var set. The kernel connects.

Agents (Claude Code) are kernel-spawned with their own PTYs. Their structured output (tool calls, stream-json messages) flows up through the kernel's normal protocol path onto the data plane. Their stderr text is captured by the kernel and re-emitted as LogRecords on the data plane. **Agents do not have their own socket to the extension.** Mediation happens at the kernel.

### §2 — Data plane: socket

#### Address and platform binding

| Platform | Transport | Address |
|---|---|---|
| Linux / macOS | Unix domain socket (UDS) | `<state_dir>/llmnb-<session_id>.sock` |
| Windows | Named pipe | `\\.\pipe\llmnb-<session_id>` |
| Fallback (any) | Loopback TCP | `127.0.0.1:<allocated_port>` |

`<state_dir>` is `$XDG_RUNTIME_DIR` if set, else `os.tmpdir()`. `<session_id>` is the same UUIDv4 used for `metadata.rts.session_id` per RFC-005.

UDS / named pipe is preferred. Loopback TCP is the fallback when the platform lacks UDS support or the implementation chooses to use TCP for portability. The kernel reads `LLMKERNEL_IPC_SOCKET=<address>` from its environment; the value's prefix (`unix:` / `pipe:` / `tcp:`) disambiguates the transport. UDS is the unprefixed default.

#### Permissions and security

- UDS files MUST be created with mode `0600` (owner read/write only). The extension verifies the mode after creation; rejects insecure permissions.
- Loopback TCP MUST bind to `127.0.0.1` only, never `0.0.0.0`. Implementations MUST NOT listen on a publicly routable interface.
- No authentication on the connection: the OS-level access controls (UDS permissions, pipe ACLs, loopback isolation) are the security boundary.
- Multi-client (a second extension or external tool connecting to the socket) is **not supported in V1**. Implementations MAY reject second connections with a `LogRecord` `event.name: "ipc.duplicate_connection_rejected"` and immediate close.

#### Framing

Newline-delimited JSON. One JSON object per line, terminated by a single `\n` byte. JSON values themselves do not contain unescaped newlines (per JSON spec); the framing is unambiguous.

- Senders MUST emit `\n`-terminated JSON objects. CR (`\r`) is forbidden inside the framing layer; it MAY appear escaped inside JSON strings.
- Receivers MUST tolerate empty lines (skip them).
- No length prefix in V1. JSON parsers handle arbitrary-size frames fine over a byte-clean stream. (PTY's historical line-buffer limits do not apply — this is a socket, not a TTY.)
- Future versions MAY introduce length-prefix framing (LSP-style `Content-Length: N\r\n\r\n`) as a major-version bump if framing edge cases surface.

Frames in either direction:

- Extension → kernel: RFC-006 Comm envelopes (Family B–F), heartbeat envelopes, operator action envelopes.
- Kernel → extension: OTel `Span` records (Family A), OTel `LogRecord`s (kernel logs, agent stderr captures), RFC-006 Comm envelopes (Family B–F responses, Family F snapshots).

#### Frame types and dispatch

The receiver examines the top-level keys of each parsed JSON object to dispatch. Three frame types:

| Frame type | Identifying top-level keys | Carries |
|---|---|---|
| OTel `Span` | `traceId` AND `spanId` | RFC-006 Family A — run lifecycle (one span per emission; in-progress span has `endTimeUnixNano: null`) |
| OTel `LogRecord` | `timeUnixNano` AND `severityNumber` | Kernel internal logs, agent stderr captures, banners, OTel-shaped events that don't fit the trace/span model |
| RFC-006 Comm envelope | `type` (string) AND `payload` (object) | Comm families B–F (layout, agent_graph, operator.action, heartbeat, notebook.metadata) |

A frame whose top-level shape doesn't match any of these is malformed; receivers MUST log and discard. Frames are processed in arrival order; ordering across frame types is preserved by the single underlying socket.

### §3 — Control plane: PTY

#### Spawning and termios

The extension uses `node-pty` (or its language-local equivalent) to spawn the kernel. Default options:

- `name: "xterm-256color"` (terminal type)
- `cwd: <workspace root>`
- `env: { ...process.env, LLMKERNEL_IPC_SOCKET: <address>, LLMKERNEL_PTY_MODE: "1" }`
- `cols`, `rows`: extension's choice (typically 120 x 30; resize on operator panel resize)

The kernel SHOULD detect `LLMKERNEL_PTY_MODE=1` on startup and:

1. Set termios raw mode on its PTY-attached file descriptors so the slave-side ICANON line discipline does not buffer or interpret bytes. (Implementations MAY skip this if the PTY framing is not used for protocol — V1 reserves the PTY for control text only, so this is an optional hardening.)
2. Install a SIGINT handler that flags the currently-running operation for interrupt. Default Python behavior raises `KeyboardInterrupt`; the kernel MAY override this to emit a structured interrupt event on the data plane before re-raising.
3. Optionally write a boot banner to its PTY-attached `stderr` (e.g., `LLMKernel pty-mode v1.0.0; socket=<address>`) for the operator's visual confirmation.

#### What the PTY carries

The PTY carries text intended for human consumption or OS-level signal interaction:

- **Boot output**: kernel startup banners, version strings, warnings before the data-plane socket is ready.
- **Fatal tracebacks**: Python tracebacks raised before the OTel pipeline is initialized OR after it has crashed. These cannot ride the data plane because the data plane requires a working `logging.Handler` → `LogRecord` formatter; a fatal startup error may take that down.
- **SIGINT delivery**: `proc.kill('SIGINT')` from the extension; the OS delivers the signal via PTY foreground-process semantics.
- **SIGTERM delivery on shutdown**: `proc.kill('SIGTERM')`; same path.
- **Optional REPL**: V2 may permit the operator to open a Python REPL on the PTY for live kernel debugging. V1 does NOT support this; any input on the PTY's stdin is discarded by the kernel.

#### What the PTY does NOT carry

- Any OTel record (Span or LogRecord).
- Any RFC-006 Comm envelope.
- Anything that should round-trip through the protocol parser.

If a Python `logging` call happens at runtime (after the OTel pipeline is up), it MUST be formatted as a `LogRecord` and emitted on the data plane, NOT printed to stderr. The PTY is for output that genuinely cannot ride OTel.

#### Pseudoterminal panel (debug surface)

The extension MAY expose a `vscode.Pseudoterminal` that mirrors the PTY content in a VS Code Terminal panel. When opened:

- All PTY bytes flow into the panel verbatim (color codes preserved).
- Operator keystrokes in the panel are forwarded to the kernel's PTY stdin (subject to V1's "discard stdin" policy — V2 enables operator REPL).
- The panel is named `LLMKernel: <session_id>`.
- The panel is opt-in: operator command `LLMNB: Show kernel terminal`.

This is a debugging affordance, not a production user surface. Operators rarely open it; it's there when something is wrong.

### §4 — Connection lifecycle

```
1. Extension activate
   ├─ Allocate session_id (UUIDv4)
   ├─ Compute socket address (UDS path / pipe name / TCP port)
   ├─ Listen on socket
   └─ Spawn kernel via node-pty with LLMKERNEL_IPC_SOCKET set

2. Kernel startup (pty-mode)
   ├─ Read LLMKERNEL_IPC_SOCKET from env
   ├─ Set termios raw (optional)
   ├─ Install SIGINT/SIGTERM handlers
   ├─ Initialize subsystems (run_tracker, dispatcher, mcp_server, metadata_writer)
   ├─ Connect to socket
   └─ Emit OTel LogRecord: { event.name: "kernel.ready", attributes: { ... } }

3. Extension receives ready record
   ├─ Validate kernel version + RFC implementation versions
   ├─ Optional: emit drift events if version mismatch
   ├─ Mark client as ready
   └─ Begin servicing NotebookController.executeHandler

4. Steady state
   ├─ Data plane: bidirectional JSON frames
   ├─ Control plane: kernel writes occasional log/banner; quiet otherwise
   └─ Heartbeat envelopes (RFC-006 Family E) on data plane every 5s

5. Operator interrupt
   ├─ proc.kill('SIGINT') over PTY
   ├─ Kernel handler interrupts running operation
   └─ Kernel emits LogRecord on data plane: { event.name: "kernel.interrupt_handled" }

6. Clean shutdown
   ├─ Extension sends RFC-006 envelope: { type: "kernel.shutdown_request", payload: {} }
   ├─ Kernel emits final notebook.metadata snapshot
   ├─ Kernel emits LogRecord: { event.name: "kernel.shutting_down" }
   ├─ Kernel closes socket
   ├─ Kernel exits cleanly
   └─ PTY EOF detected by extension; kernelClient.dispose()

7. Dirty shutdown (kernel crash)
   ├─ PTY EOF detected by extension before any shutdown handshake
   ├─ Last few bytes on PTY likely contain Python traceback (visible in panel if open)
   ├─ Extension marks client as dead; surfaces operator-facing error
   └─ Restart logic per RFC-002 §"Process lifecycle"
```

#### Ready handshake

The kernel's first frame on the data plane MUST be a `LogRecord` with `event.name: "kernel.ready"`. Required attributes:

- `llmnb.kernel.version` (string) — kernel package version.
- `llmnb.kernel.session_id` (string) — echo of the env-provided session_id, for sanity.
- `llmnb.kernel.rfc_001_version` through `llmnb.kernel.rfc_008_version` (strings) — RFC implementation versions for compatibility checking.
- `llmnb.kernel.python_version` (string) — Python interpreter version for debug.

The extension MUST wait for this record (with a 30-second timeout) before considering the kernel usable. On timeout, the extension MUST kill the kernel via SIGTERM, log the timeout reason, and surface a user-facing error.

#### Drift on connect

Per RFC-005 §"Resume-time RFC version check", the extension compares the ready record's `rfc_*_version` attributes against the open `.llmnb`'s `metadata.rts.config.volatile.kernel.rfc_*_version`. Mismatches produce drift events appended to `metadata.rts.drift_log` with severity per the RFC-005 classification.

### §5 — Tape capture

[RFC-007](RFC-007-tape-otlp-logs.md) specifies `.tape` files as OTLP/JSON Logs persistence for raw kernel observability. Under this RFC's two-channel transport, the data plane is **already** an OTLP/JSON byte stream — Span, LogRecord, and Comm-envelope frames interleaved on a single socket.

Tape capture is therefore implemented as a **passive tee** of the data-plane socket bytes:

- When tapes are enabled (`config.recoverable.kernel.tape.enabled: true` per RFC-005 / RFC-007), the kernel MAY tee its socket-bound output to a tape file. Default location: `<state_dir>/llmnb-tapes/<session_id>.tape`.
- The tape is a verbatim copy of one direction (kernel → extension). For full forensic capture, both directions tee to a merged file with a synthetic `direction` attribute injected per record. V1 implementations SHOULD tee kernel-to-extension only; bidirectional tee is V1.5.
- RFC-007's per-line `LogRecord` shape is naturally satisfied for LogRecord and Span frames. RFC-006 Comm envelopes are NOT OTel records; the V1 tape includes them verbatim alongside (a `.tape` therefore contains a mix of three frame types, NOT pure OTLP/JSON Logs). RFC-007 v1.0.0 is amended (or its eventual draft notes) to allow this mixed shape.

The tee adds zero structural transformation. Bytes flow socket → file. RFC-007's redaction policy (default redact bearer tokens / API keys / secret-shaped fields) is applied at the **emission** layer (kernel-side, before bytes hit the socket), not at the tee — so the tee captures exactly what the wire saw.

### §6 — Frame type dispatch (data plane)

A receiver-side dispatch table:

```typescript
function dispatchFrame(json: unknown): void {
  if (typeof json !== 'object' || json === null) {
    log.warn('malformed frame: not an object');
    return;
  }
  const f = json as Record<string, unknown>;

  // OTel Span: traceId + spanId at top level
  if (typeof f.traceId === 'string' && typeof f.spanId === 'string') {
    routeFamilyA(f as OtlpSpan);
    return;
  }

  // OTel LogRecord: timeUnixNano + severityNumber at top level
  if (typeof f.timeUnixNano === 'string' && typeof f.severityNumber === 'number') {
    routeLogRecord(f as OtlpLogRecord);
    return;
  }

  // RFC-006 Comm envelope: type + payload
  if (typeof f.type === 'string' && typeof f.payload === 'object' && f.payload !== null) {
    routeCommEnvelope(f as RtsV2Envelope);
    return;
  }

  log.warn('malformed frame: no recognized top-level shape', f);
}
```

Order of checks matters when shapes overlap (V1 has none, but additive evolution must preserve precedence). Spans are checked first because the OTLP shape is most distinctive (32+16-hex IDs). LogRecords are next. Envelopes are last because their `type` field is the loosest discriminator.

A frame that would match more than one type (e.g., a malformed envelope that happens to include a `traceId`) is a producer bug; receivers dispatch using the first match per the order above.

### §7 — Kernel-side: `logging.Handler` for OTLP/JSON LogRecord

Python `logging` is used throughout the kernel for internal observability. To route `logging` output to the data plane, the kernel installs a `LogRecord`-shaping handler at startup:

```python
import logging
import json
import time
import sys

class OtlpDataPlaneHandler(logging.Handler):
    """Formats Python LogRecords as OTLP/JSON LogRecords on the data-plane socket."""

    SEVERITY_MAP = {
        logging.DEBUG:    5,   # OTel TRACE
        logging.INFO:     9,   # OTel INFO
        logging.WARNING:  13,  # OTel WARN
        logging.ERROR:    17,  # OTel ERROR
        logging.CRITICAL: 21,  # OTel FATAL
    }

    def __init__(self, socket_writer):
        super().__init__()
        self._writer = socket_writer

    def emit(self, record):
        otlp = {
            "timeUnixNano": str(int(record.created * 1e9)),
            "observedTimeUnixNano": str(time.time_ns()),
            "severityNumber": self.SEVERITY_MAP.get(record.levelno, 9),
            "severityText": record.levelname,
            "body": {"stringValue": self.format(record)},
            "attributes": [
                {"key": "logger.name",   "value": {"stringValue": record.name}},
                {"key": "code.function", "value": {"stringValue": record.funcName}},
                {"key": "code.lineno",   "value": {"intValue": str(record.lineno)}},
            ],
        }
        self._writer.write_frame(otlp)
```

Agent subprocess stderr is read line-by-line by the kernel's agent supervisor and fed through the same handler with `severityNumber` set per heuristics (lines containing `error` / `exception` / `traceback` → ERROR; `warning` → WARN; default INFO).

Lines that genuinely cannot be shaped (kernel boot output before the handler is installed, fatal startup tracebacks) go to PTY stderr instead. This is the only path to the PTY for non-control content; once the handler is up, no Python text reaches the PTY.

### §8 — Extension-side: `PtyKernelClient`

The extension's `JupyterKernelClient` (R1-era) is replaced by `PtyKernelClient` exposing the same observable surface (the existing `KernelEventSink` interface stays) but with the new transport underneath:

```typescript
import * as net from 'node:net';
import * as pty from 'node-pty';
import * as os from 'node:os';
import * as path from 'node:path';

export class PtyKernelClient implements KernelClient {
  private ptyProcess?: pty.IPty;
  private socket?: net.Socket;
  private server?: net.Server;
  private socketPath: string;

  constructor(private sessionId: string, private sink: KernelEventSink) {
    this.socketPath = this.allocateSocketAddress();
  }

  async start(): Promise<void> {
    await this.listenSocket();
    this.spawnKernel();
    await this.waitForReady(30_000);
  }

  private allocateSocketAddress(): string {
    if (process.platform === 'win32') {
      return `\\\\.\\pipe\\llmnb-${this.sessionId}`;
    }
    const dir = process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
    return path.join(dir, `llmnb-${this.sessionId}.sock`);
  }

  private async listenSocket(): Promise<void> {
    this.server = net.createServer((sock) => {
      this.socket = sock;
      sock.on('data', (buf) => this.onData(buf));
      sock.on('end', () => this.onSocketClose());
    });
    return new Promise((resolve) => this.server!.listen(this.socketPath, resolve));
  }

  private spawnKernel(): void {
    this.ptyProcess = pty.spawn('python', ['-m', 'llm_kernel', 'pty-mode'], {
      name: 'xterm-256color',
      cwd: vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? process.cwd(),
      env: { ...process.env, LLMKERNEL_IPC_SOCKET: this.socketPath, LLMKERNEL_PTY_MODE: '1' },
    });
    this.ptyProcess.onData((data) => this.onPtyData(data));
    this.ptyProcess.onExit(({ exitCode }) => this.onPtyExit(exitCode));
  }

  // ... onData (frame parser), onPtyData (forward to debug terminal), interrupt(), shutdown() ...
}
```

The frame parser buffers incoming socket bytes, splits on `\n`, parses each line as JSON, and dispatches per §6.

### §9 — Drop `@jupyterlab/services`

Once `PtyKernelClient` is in place, `@jupyterlab/services` is no longer used. The dependency MUST be removed from `extension/package.json`. Removal is observable: extension bundle size drops by ~3–5 MB.

The `JupyterKernelClient` file is deleted (or kept temporarily as `// deprecated` for one minor version). The `KernelClient` interface stays — only the implementation rotates.

## Other transports (v1.0.1)

The PTY+socket two-channel arrangement specified above is the V1 default for **local extension-kernel** integration. PLAN-S5.0.3d adds a sibling transport — TCP — for **headless** and **external-driver** deployments (CI runners, containers, Rust/Go orchestrators, the `llmnb execute` CLI talking to a remote kernel). The TCP transport is specified normatively in [RFC-006 §"Transports"](RFC-006-kernel-extension-wire-format.md) v2.1.0; this section anchors the cross-reference.

**Invariant carried over:** every transport opens with the [`kernel.handshake`](../atoms/protocols/wire-handshake.md) envelope and then carries identical Family A/B/C/F/G payloads. PTY remains the local default. The Comm-target name (`llmnb.rts.v2`) is the layer-1 major-version identifier on PTY; the handshake envelope's `wire_version` field is the source of truth on TCP (and unifies version negotiation across all transports going forward).

**What's new in v1.0.1:**
- A new entry-point `python -m llm_kernel serve --transport tcp --bind HOST:PORT --auth-token-env LLMNB_AUTH_TOKEN` (PLAN-S5.0.3 §5.2). Default bind is `127.0.0.1` (loopback). Token comparison is constant-time. Token never on argv.
- The kernel-side serve loop accepts one connection at a time in V1.5; second client receives `kernel_busy` and is closed. Multi-client is V2+.
- The PTY transport is unchanged; this RFC's §1–§9 continue to specify the load-bearing local transport.

**Trusted-network model:** TCP is for trusted networks only. There is no mTLS in V1.5 (PLAN-S5.0.3 §10 risk #3). Operators binding to `0.0.0.0` MUST do so explicitly and only inside an authorized perimeter.

## Backward-compatibility analysis

This RFC introduces V1's first kernel-host transport. There is no prior locked transport binding — the R1-era `@jupyterlab/services` use was a transition state, not a normative spec.

**Within v1.x (additive, minor bump):**

- New optional fields on the ready handshake `LogRecord` (additive attributes).
- New optional env vars passed to the kernel.
- New optional ready-record `event.name` values.
- New supported socket-address transports (e.g., explicit `tcp:` prefix variants).

**Within v1.x (deprecating, minor bump):**

- A field marked obsolete. Producers continue emitting both forms.

**Major bump (v2.0):**

- Switching from newline-delimited JSON to length-prefix framing.
- Splitting the data plane into multiple sockets.
- Removing the PTY entirely.
- Changing the `LLMKERNEL_IPC_SOCKET` env var name or contract.

V1 implementations attach to v1.0.0 of this RFC.

## Failure modes

| # | Trigger | Recipient response | Recovery surface |
|---|---|---|---|
| K1 | Socket bind fails (path exists / permission denied / port taken) | Extension surfaces "kernel transport unavailable" with the OS error string. Does NOT spawn the kernel. | Operator restart of VS Code; check `<state_dir>` permissions. |
| K2 | Kernel fails to spawn (executable not found, bad argv) | Extension catches `node-pty` spawn error; surfaces "kernel binary not found" or similar. | Operator action: install / reinstall the Pixi kernel env. |
| K3 | Kernel spawned but never connects to socket within 30s | Extension kills via SIGTERM, surfaces "kernel ready timeout". PTY content (if any visible in panel) is captured to logs for diagnosis. | Operator action: open the kernel terminal panel for traceback; common cause is a Python import error pre-handshake. |
| K4 | Ready record has wrong shape or missing required attributes | Extension surfaces "kernel handshake malformed"; SIGTERMs kernel; logs the malformed bytes. | Kernel/extension version mismatch; operator updates one or the other. |
| K5 | Ready record's `rfc_*_version` majors differ from extension's | Extension surfaces a blocking modal: "Kernel implements RFC-005 v2; extension expects v1. Cannot continue." | Operator updates one side; or switches to a compatible kernel version. |
| K6 | Data-plane socket EOF mid-session | Extension marks kernel as dead; surfaces error; PTY EOF likely follows. | Restart per RFC-002 lifecycle. |
| K7 | PTY EOF before data-plane socket EOF | Kernel crashed before clean shutdown. Extension still has a few seconds of socket data potentially in flight; drains it, then closes. | Restart per RFC-002 lifecycle. |
| K8 | Malformed frame on data plane (not parseable JSON, or no recognized shape) | Log and discard. Don't terminate. | Producer bug; investigate via tape replay. |
| K9 | Frame larger than receive buffer | Implementations buffer until newline; no inherent limit. If memory exhaustion threatens, log + close socket + restart. | Operator: examine why a frame exceeded reasonable size; likely a `notebook.metadata` snapshot needing patch mode (V1.5+). |
| K10 | Second client tries to connect to data-plane socket | Reject with `LogRecord` + close. Single-client only in V1. | None. Multi-client is V2. |
| K11 | SIGINT delivered but kernel doesn't respond | Extension waits 5s, escalates to SIGTERM. After 10s total, SIGKILL. | Operator: kernel logs may show what hung; restart after kill. |
| K12 | Kernel writes structured JSON to PTY stderr instead of socket | Extension's PTY reader sees JSON-shaped bytes; logs warning; does NOT dispatch. The terminal panel renders them as text. | Kernel bug — handler installed late or handler crashed. Investigate kernel log capture. |

## Worked example

Operator opens `session.llmnb` in VS Code. Trace from extension activate to first cell execution:

```
Extension host                          Kernel (Python)            PTY     Socket
──────────────────────────────────────────────────────────────────────────────────
[activate]
  allocate session_id = "9c1a3b2d-..."
  socket_path = "/tmp/llmnb-9c1a3b2d-...sock"
  net.createServer().listen(socket_path)
  pty.spawn("python -m llm_kernel pty-mode",
    env={LLMKERNEL_IPC_SOCKET: socket_path, LLMKERNEL_PTY_MODE: "1"})
                                        [boot]                      ──→     listening
                                        read env
                                        install SIGINT handler
                                        (boot banner)               ──→
                                        initialize subsystems
                                        connect to socket           ─────→   accept
                                        emit ready LogRecord                ──→ recv
  parse: LogRecord, event.name=kernel.ready
  validate version + RFC versions
  drift_detector.compare(persisted, ready)
  begin steady state

[operator types /spawn alpha task:"hello" in cell-0; presses Shift+Enter]
  controller.executeHandler(cell)
  send envelope { type: "operator.action",
                  payload: { action_type: "cell_execute",
                             cell_id: "cell-0", source: "/spawn alpha ..." } }
                                                                            ←── recv
                                        dispatch to MCP supervisor
                                        spawn agent (its own PTY)
                                        run agent → tool_use(notify)
                                        emit Family A run.start span        ──→ recv
  parse: Span (traceId+spanId)
  routeFamilyA → cell-0 output renders
                                        emit Family A run.complete span     ──→ recv
  parse: Span; close cell exec; status=success

[autosave 30s timer fires]
                                        metadata_writer.snapshot()
                                        emit Family F notebook.metadata     ──→ recv
  parse: envelope (type+payload)
  metadata-applier.apply()
  vscode.NotebookEdit.updateNotebookMetadata
                                        emit heartbeat envelope             ──→ recv
                                        (every 5s)

[operator hits Ctrl+C in kernel terminal panel]
  proc.kill('SIGINT')              ──→  SIGINT delivered via PTY    ←──
                                        handler.interrupt()
                                        emit LogRecord
                                          event.name=kernel.interrupt_handled ──→ recv
  log to extension output

[operator closes notebook]
  send envelope { type: "kernel.shutdown_request", payload: {} }
                                                                            ←── recv
                                        emit final snapshot                 ──→
                                        close socket             ←─── close
                                        exit clean              ──→ EOF
  ptyClient.dispose()
```

Both channels are visible. The PTY carries boot output and the SIGINT signal. The socket carries every protocol byte. Their timelines are independent but coordinated at the lifecycle handshakes.

## Consumers

- **Kernel `pty_mode.py` (new in V1):** the kernel's `python -m llm_kernel pty-mode` entry point. Sets up termios, installs the `OtlpDataPlaneHandler`, connects to the socket, runs the kernel main loop.
- **Kernel `socket_writer.py` (new):** thin abstraction over the socket; provides `write_frame(dict) -> None` that JSON-encodes + appends `\n` + writes; thread-safe.
- **Extension `extension/src/notebook/pty-kernel-client.ts` (new):** the PTY+socket-binding `KernelClient` implementation. Replaces the R1-era `JupyterKernelClient`.
- **Extension `extension/src/notebook/kernel-terminal.ts` (new):** the `vscode.Pseudoterminal` provider that mirrors PTY content into a debug terminal panel.
- **Tape writer (RFC-007):** subscribes to the data-plane socket bytes; tees to disk.
- **Drift detector (RFC-005):** consumes the ready handshake's `rfc_*_version` attributes.

## Open issues queued for amendment

| Issue | Surfaced by | Disposition |
|---|---|---|
| Bidirectional tape capture (extension→kernel frames also recorded) | RFC-007 §5 | V1.5 — needs a synthetic `direction` attribute injected per record on tee. |
| Operator REPL on the PTY (V2) | Useful for live kernel debugging | V2 — the kernel listens to PTY stdin and feeds it to a Python REPL. Careful to not interfere with SIGINT semantics. |
| Length-prefix framing (LSP-style) as v2 of this RFC | If newline-JSON proves too fragile in some platform corner case | Major bump; not anticipated for V1 but reserved. |
| Multi-client data-plane (V2) | If a monitoring tool wants to observe a session simultaneously with the extension | V2 — likely a separate read-only "audit socket" rather than multi-attach to the primary. |
| Bidirectional auth on the socket | Operationally not needed in V1 (UDS perms / pipe ACLs / loopback isolation) | If a future deployment crosses a trust boundary, add a shared-secret handshake on the ready record. |
| `cols`/`rows` resize forwarding | If the operator resizes the kernel terminal panel | V1.5 — wire `pty.resize(cols, rows)` to operator panel resize events. Currently fixed at spawn-time defaults. |

## Source

- ADR: [DR-0009 — VS Code NotebookController API; no Jupyter kernel](../decisions/0009-notebook-controller-no-jupyter-kernel.md)
- ADR: [DR-0011 — Subtractive fork of vscode-jupyter](../decisions/0011-subtractive-fork-vscode-jupyter.md)
- ADR: [DR-0012 — LLMKernel as sole kernel](../decisions/0012-llmkernel-sole-kernel.md)
- ADR: [DR-0015 — paper-telephone bidirectional MCP](../decisions/0015-kernel-extension-bidirectional-mcp.md)
- ADR: [DR-0016 — RFC standards discipline](../decisions/0016-rfc-standards-discipline.md)
- Sibling RFCs: [RFC-005](RFC-005-llmnb-file-format.md) (file format consumed by Family F over data plane), [RFC-006](RFC-006-kernel-extension-wire-format.md) (wire format this binds), [RFC-007](RFC-007-tape-otlp-logs.md) (tape capture from data-plane bytes)
- External: [node-pty](https://github.com/microsoft/node-pty), [Unix domain sockets](https://man7.org/linux/man-pages/man7/unix.7.html), [Windows Named Pipes](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipes), [Language Server Protocol — Base Protocol](https://microsoft.github.io/language-server-protocol/specifications/base/0.9/specification/) (for reference framing comparison; we deliberately do NOT use LSP framing in V1)
