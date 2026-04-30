# Transport mode

**Status**: V1.5 shipped (PTY shipped in V1; TCP shipped in PLAN-S5.0.3d 2026-04-29; outer commit pin TBD-after-commit; submodule pin TBD-after-commit; Unix socket remains V1.5 partial — handshake/contract complete, transport adapter in V1)
**Source specs**: [PLAN-S5.0.3 §5](../../notebook/PLAN-S5.0.3-driver-extraction-and-external-runnability.md#5-external-transport-tcp--token), [PLAN-S5.0.3 §7.1](../../notebook/PLAN-S5.0.3-driver-extraction-and-external-runnability.md#71-round-0-operator-30min) (RFC-008 v1.0.1 amendment noting TCP), [RFC-008 §"Transport boundary"](../../rfcs/RFC-008-pty-transport.md), [RFC-006](../../rfcs/RFC-006-kernel-extension-wire-format.md) (envelope contract is transport-invariant)
**Related atoms**: [protocols/wire-handshake](../protocols/wire-handshake.md), [discipline/wire-as-public-api](../discipline/wire-as-public-api.md), [concepts/driver](../concepts/driver.md), [contracts/kernel-client](../contracts/kernel-client.md)

## Definition

A **transport mode** is the connection mechanism between a [driver](driver.md) and the kernel. Three modes exist: PTY (parent-child), Unix socket (local same-user), and TCP (remote / container-to-container). All three speak the **same envelope contract** — Family A/B/C/F/G shapes, `WIRE_VERSION`, [`kernel.handshake`](../protocols/wire-handshake.md). Anything transport-specific (auth model, advertisement path, default bind) is isolated at the transport boundary; envelope dispatch never knows which transport it's running over.

## V1 → V1.5 mode catalogue

| Mode | When | Auth | Status | Default invocation |
|---|---|---|---|---|
| **PTY** | Kernel spawned by extension/CLI as a child process | Implicit parent-child trust | V1 shipped (RFC-008) | `python -m llm_kernel pty-mode` |
| **Unix socket** | Local same-user IPC; advertised at `~/.llmnb/runtime/<pid>.sock` (mode 0600); token in `<pid>.token` (mode 0600) | Filesystem perms + bearer token | V1.5 (PLAN-S5.0.3b/c) | `llmnb execute notebook.llmnb --connect unix:///tmp/llmnb-1234.sock` |
| **TCP** | Remote or container-to-container | Bearer token via `LLMNB_AUTH_TOKEN` env (never argv); constant-time compare (`hmac.compare_digest`); default-bind `127.0.0.1`; one-connection-at-a-time | V1.5 shipped (PLAN-S5.0.3d) | `python -m llm_kernel serve --transport tcp --bind 127.0.0.1:7474 --auth-token-env LLMNB_AUTH_TOKEN` |

## What's transport-specific vs envelope-invariant

### Transport-specific (lives in `llm_client/transport/{pty,unix,tcp}.py`)

| Concern | PTY | Unix | TCP |
|---|---|---|---|
| Auth model | parent-child | filesystem perms + token | bearer token, constant-time compare |
| Advertisement | none (parent owns child PID) | `~/.llmnb/runtime/<pid>.sock` | explicit `--connect` URL |
| Default bind | n/a | local socket path | `127.0.0.1` (loopback only; `0.0.0.0` requires explicit operator opt-in) |
| Lifecycle signals | SIGCHLD / PTY-EOF | socket close | TCP RST/FIN |
| Multi-client (V1) | n/a (1:1) | refused (V1 single) | refused (V1 single, `kernel_busy`) |

### Envelope-invariant (lives in `llm_kernel/wire/`)

- `WIRE_VERSION` semantics ([discipline/wire-as-public-api](../discipline/wire-as-public-api.md))
- [`kernel.handshake`](../protocols/wire-handshake.md) shape (first envelope on every transport)
- Family A/B/C/F/G envelope shapes (per RFC-006)
- Tool catalog (`TOOL_CATALOG` from `llm_kernel.wire.tools`)
- Family routing rules (`type` discriminator drives dispatch)
- Error envelopes (`wire-failure` LogRecord, K-class errors)

A driver that works correctly over PTY works correctly over Unix and TCP **without any envelope-layer code change**. Only its transport adapter swaps.

## Invariants

- **One transport per connection.** A driver picks a transport at connect time; it cannot "promote" PTY to TCP mid-session.
- **Envelope contract is invariant.** Any future fourth transport (e.g., WebSocket — V2+) speaks the same envelope grammar.
- **Default bind is loopback.** TCP `--bind 0.0.0.0:...` requires explicit operator action; bare `llmnb serve --transport tcp` binds `127.0.0.1` only.
- **Token comparison is constant-time** — `hmac.compare_digest` (PLAN-S5.0.3 §5.2). Never `==`.
- **Token never on argv** — leaks to `ps`. Always env or `.env` file (`python-dotenv` already supported).
- **Handshake mandatory on all transports.** PTY's "advisory" handshake is still emitted; the contract is uniform even where it could in principle be skipped.

## V1 vs V2+

- **V1 shipped**: PTY only. RFC-008 §2 forbids multi-client; the kernel accepts the first connection.
- **V1.5** (PLAN-S5.0.3b/c/d): Unix socket + TCP. Single-client invariant retained.
- **V2+**: multi-client kernel; mTLS / cert-pinning over TCP; WebSocket transport for browser drivers; multi-kernel orchestration (one driver fanning out).

## Anti-shapes

| Anti-shape | Why wrong |
|---|---|
| Encoding transport-specific assumptions in envelope handlers (e.g., a Family F handler that calls `os.fork()` because it assumes PTY) | Couples wire to transport; breaks on Unix/TCP. Transport adapters do their own framing only. |
| `--bind 0.0.0.0` as default | Exposes kernel to any reachable host. Loopback default + explicit opt-in is the [zachtronics](../discipline/zachtronics.md) visible-tile rule applied to bind addresses. |
| Token in argv (`--token abc123`) | Leaks to `ps`. Always env-var-indirected. |
| Skipping handshake on PTY because "we trust the parent" | Version-skew detection still matters; one code path is simpler than two. |
| Multi-transport per connection (e.g., "fall back to TCP if PTY fails") | V1 kernel doesn't support; introduces ambiguity in error reporting. |

## See also

- [protocols/wire-handshake](../protocols/wire-handshake.md) — the envelope every transport opens with.
- [discipline/wire-as-public-api](../discipline/wire-as-public-api.md) — what stays invariant across transports.
- [concepts/driver](../concepts/driver.md) — each driver picks one transport at connect.
- [contracts/kernel-client](../contracts/kernel-client.md) — extension's PTY-mode driver implementation.
