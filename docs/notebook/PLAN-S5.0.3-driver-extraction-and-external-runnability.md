# Plan: S5.0.3 — Driver extraction, public wire, external runnability

**Status**: ready
**Audience**: an LLM (or operator) picking this up cold. Self-contained.
**Goal**: separate the kernel (server) from the driver (client) at the package level; promote the wire envelope schemas to a public API; add a TCP+token transport so external clients (a headless `llmnb` CLI, future Rust/Go drivers, remote orchestrators) can drive the kernel without forking the codebase.
**Time budget**: ~2.3 dispatcher-days across 5 sub-slices (a/b/c sequential; d/e parallel after c).

---

## §1. Why this work exists

After S5.0 (cell-magic vocabulary) and S5.0.1 (injection defense) land, the kernel speaks a stable text-as-canonical surface and a stable JSON wire. Three pressures push toward formalizing the client side:

1. **No headless executor exists.** [extension/src/notebook/controller.ts](../../extension/src/notebook/controller.ts) is the only thing that drives a notebook end-to-end, and it requires VS Code. The kernel package contains *smokes* (`agent-supervisor-smoke`, `paper-telephone-smoke`, `metadata-writer-smoke` in [vendor/LLMKernel/llm_kernel/__main__.py](../../vendor/LLMKernel/llm_kernel/__main__.py)) that boot a kernel and drive it from outside, but each is hardcoded for one scenario and shares no boot/drive code. Tests-as-notebooks (an open question from S5.0 design) needs a reusable runner.

2. **Driver-as-internals risks drift.** The smokes import from `llm_kernel.agent_supervisor`, `llm_kernel.metadata_writer`, `llm_kernel.run_tracker`. Each new driver path that reaches into kernel internals creates a second code path that can drift from the wire-only path the extension uses. Without a lint boundary, "almost what I need from the wire" becomes "import the private module."

3. **External clients have no contract.** The wire envelope schemas live in `_rfc_schemas.py` (underscore-prefixed) and `custom_messages.py` (kernel-internal). A would-be Rust or Go driver has no published surface; the extension reverse-engineers shapes from the TypeScript side. RFCs document the wire but the code doesn't expose it as a public API.

S5.0.3 closes all three: the driver becomes a peer package, the wire becomes public, the executor becomes a real CLI, and TCP+token transport opens the kernel to external clients without compromising the trusted-local-PTY default.

---

## §2. Goals and non-goals

### Goals

- Three logical layers, two packages on disk: `llm_kernel/` (server), `llm_client/` (driver, new), with `llm_kernel/wire/` as the shared public surface.
- `llm_client.executor.run_notebook(path)` runs a `.llmnb` (or `.magic` text) end-to-end and writes the resulting outputs back. Both stub and live modes.
- `llmnb` CLI (installed entry-point) with subcommands: `execute`, `convert`, `validate`, `smoke`. Smokes move out of `llm_kernel/__main__.py`.
- TCP transport with token auth, behind a feature flag. `kernel.handshake` envelope negotiates wire-version. PTY remains the default for local.
- Lint rule: `llm_client/**` may not import any non-public `llm_kernel` module. Only `llm_kernel.wire` is public.
- Two PEP-517 distributions publishable independently: `llmnb-kernel` (server) and `llmnb` (CLI + driver). Shared workspace; CI publishes both.

### Non-goals (V1 — explicit)

- **Jupyter ZMQ kernel protocol compatibility.** Cell-format compatibility (read `.ipynb`, map cells to magic) is in scope; `jupyter_client` / ZMQ wire is not. (Reasoning: nbclient/papermill interop has no current consumer; ZMQ is a much larger commitment.)
- **WASM target.** The driver is trivially portable Python. WASM doesn't sandbox the kernel (PTY/fork/SIGCHLD/HTTP — none stable in WASI) so there's no value in compiling the trusted half.
- **mTLS / cert-pinning.** Bearer-token auth over TCP suffices for V1. mTLS is a V2+ amendment.
- **Discovery beyond local socket file.** No mDNS, no broadcast. Local: `~/.llmnb/runtime/<pid>.sock` advertises path + token (mode 0600). Remote: explicit `--connect`.
- **Multi-kernel orchestration.** One driver, one kernel. A driver fanning out to multiple kernels is V2+.
- **Cross-version client/server compatibility within a major.** Kernel rejects mismatched major; minor mismatch logs a warning and proceeds. No graceful capability-degradation matrix.

---

## §3. Reorg shape

### §3.1 Package layout

| Layer | Lives in | May import | Role |
|---|---|---|---|
| **Kernel** (server) | `vendor/LLMKernel/llm_kernel/` | `llm_kernel.wire`, stdlib, third-party deps from `pyproject.toml` | PTY transport, dispatcher, agent supervisor, metadata writer, MCP server, LiteLLM proxy. Existing entry points: `mcp-server`, `litellm-proxy`, `pty-mode`. |
| **Wire** (public API) | `vendor/LLMKernel/llm_kernel/wire/` | stdlib only | Envelope schemas (Family A/B/C/F/G), version constants, validators, JSON-Schema exports. Imported by kernel AND clients. **No imports of other `llm_kernel.*` modules.** |
| **Driver** (client library) | NEW: top-level `llm_client/` | `llm_kernel.wire`, stdlib, third-party from its own `pyproject.toml` | Boot helpers, envelope shippers, snapshot collectors, `.llmnb`↔magic converters, executor. Smokes refactored to consume this. |
| **CLI** | NEW: `llm_client/cli/` | `llm_client.*` | `llmnb` entry-point with subcommands. |

### §3.2 What moves where

| From | To | Notes |
|---|---|---|
| `llm_kernel/_rfc_schemas.py` | `llm_kernel/wire/tools.py` | Tool input/output schemas. Public. |
| `llm_kernel/custom_messages.py` (envelope shape definitions only) | `llm_kernel/wire/families.py` | Family A/B/C/F/G envelope shapes. The dispatcher itself stays in `custom_messages.py`. |
| `llm_kernel/_provisioning.py` (nothing) | — | Stays kernel-internal. |
| Boot block in `llm_kernel/__main__.py:_run_agent_supervisor_smoke` lines 210-258 | `llm_client/boot.py:boot_minimal_kernel()` | Reusable. |
| `llm_kernel/__main__.py` smokes | `llm_client/cli/smoke.py` | `llmnb smoke supervisor`, `llmnb smoke paper-telephone`, etc. Old `python -m llm_kernel agent-supervisor-smoke` aliased for one release. |

### §3.3 Lint boundary

Add to repo lint config (ruff or per-import allowlist):

```
# llm_client must not import non-public llm_kernel modules
forbidden_imports:
  - source: llm_client/**
    pattern: llm_kernel\.(?!wire(\.|$))
```

CI fails the build on violation. The extension already follows this rule by virtue of being TypeScript; the lint formalizes it for the Python driver.

---

## §4. Wire interface contract

### §4.1 Public surface (`llm_kernel.wire`)

```python
# llm_kernel/wire/__init__.py
from .version import WIRE_VERSION, WIRE_MAJOR, WIRE_MINOR
from .families import (
    Envelope, FamilyA_OperatorAction, FamilyB_LayoutEdit,
    FamilyC_AgentGraphCommand, FamilyF_NotebookSnapshot, FamilyG_Lifecycle,
    HandshakeRequest, HandshakeResponse,
)
from .tools import TOOL_CATALOG, validate_tool_input, validate_tool_output

__all__ = [
    "WIRE_VERSION", "WIRE_MAJOR", "WIRE_MINOR",
    "Envelope", "HandshakeRequest", "HandshakeResponse",
    "FamilyA_OperatorAction", "FamilyB_LayoutEdit",
    "FamilyC_AgentGraphCommand", "FamilyF_NotebookSnapshot",
    "FamilyG_Lifecycle",
    "TOOL_CATALOG", "validate_tool_input", "validate_tool_output",
]
```

### §4.2 Version constants (locked)

```python
# llm_kernel/wire/version.py
WIRE_VERSION = "1.0.0"   # semver. Bumped by RFC-006 amendments.
WIRE_MAJOR = 1
WIRE_MINOR = 0
WIRE_PATCH = 0
```

Kernel rejects connections with mismatched major. Minor mismatch on either side logs a warning and proceeds (newer minor must be backward-compatible per RFC-006 versioning rules).

### §4.3 Handshake envelope (NEW — first envelope on any connection)

```jsonc
// Client → Kernel, immediately after connect
{
  "type": "kernel.handshake",
  "payload": {
    "client_name": "llmnb-cli" | "vscode-extension" | "<custom>",
    "client_version": "<semver>",
    "wire_version": "1.0.0",
    "transport": "pty" | "unix" | "tcp",
    "auth": {                                  // present for tcp; absent for pty/unix
      "scheme": "bearer",
      "token": "<token>"
    },
    "capabilities": ["family_a", "family_b", "family_c", "family_f", "family_g"]
  }
}

// Kernel → Client
{
  "type": "kernel.handshake",
  "payload": {
    "kernel_version": "<semver>",
    "wire_version": "1.0.0",
    "session_id": "<uuid>",
    "accepted_capabilities": ["family_a", "family_b", "family_c", "family_f", "family_g"],
    "warnings": ["minor_version_skew"]   // optional
  }
}
```

On version mismatch (major) or auth failure, kernel sends an error envelope and closes the transport. RFC-006 amendment captures this — register it in §"Round 0" below.

**Capabilities are informational in V1.** Every V1 driver advertises the full Family A/B/C/F/G set and the kernel echoes them in `accepted_capabilities`. The kernel does not enforce capability subsets — a driver claiming `["family_a"]` and then sending a Family B envelope is processed normally; the field exists so V2+ partial-driver implementations (e.g., a read-only observer claiming only `family_f`) can negotiate without a wire-version bump. V1 lint check: drivers must include the full set.

### §4.4 JSON Schema export

`llm_kernel/wire/schemas/*.json` — generated from the Python validators. Non-Python clients (extension TypeScript, future drivers) consume these directly. Generation happens at build time via `python -m llm_kernel.wire.export schemas/`.

---

## §5. External transport (TCP + token)

### §5.1 Transport modes

| Mode | When | Auth | Example |
|---|---|---|---|
| **PTY** (current default) | Kernel spawned by extension/CLI as a child process | Implicit (parent-child trust) | `python -m llm_kernel pty-mode` |
| **Unix socket** | Local same-user IPC, advertised at `~/.llmnb/runtime/<pid>.sock` (mode 0600) | Token in companion file `<pid>.token` (mode 0600) | `llmnb execute notebook.llmnb --connect unix:///tmp/llmnb-1234.sock` |
| **TCP** (NEW) | Remote or container-to-container | Bearer token via `LLMNB_AUTH_TOKEN` env or `--token` argv | `llmnb execute notebook.llmnb --connect tcp://kernel.host:7474 --token-env LLMNB_AUTH_TOKEN` |

### §5.2 TCP server

Kernel CLI gains:

```
python -m llm_kernel serve --transport tcp --bind 127.0.0.1:7474 --auth-token-env LLMNB_AUTH_TOKEN
```

- Default bind: `127.0.0.1` (loopback only). Operator must explicitly set `--bind 0.0.0.0:...` to expose externally.
- Token comparison: constant-time (`hmac.compare_digest`).
- Token absent or mismatched on handshake → close with `auth_failed` error.
- One connection at a time (V1). Second client gets `kernel_busy`. (Multi-client is V2+.)

### §5.3 Token storage

- **Operator-side**: `LLMNB_AUTH_TOKEN` env var (default name). Loaded from `.env` (already supported via `python-dotenv`). Never on argv (would leak to `ps`).
- **Custom var name**: `--token-env <NAME>` overrides the default. Resolution order:
  1. If `--token-env <NAME>` is set, the kernel/driver reads `os.environ[<NAME>]`. Missing → `auth_failed`. Default `LLMNB_AUTH_TOKEN` is **ignored** even if also set (explicit overrides default; no implicit fallback that could leak the wrong token).
  2. If `--token-env` is omitted, the kernel/driver reads `os.environ["LLMNB_AUTH_TOKEN"]`. Missing → `auth_failed`.
  3. Both kernel and driver MUST agree on which env var to consult; mismatch presents as `auth_failed`. (Same-host operator typically sets one var; CI/devcontainers use `--token-env CI_LLMNB_TOKEN` to keep the project token namespaced.)
- **Generation**: `llmnb auth init` generates a random token, writes to `.env` (gitignored; CLI errors if `.env` is tracked).
- **No keychain integration in V1.** Could land in V2.

### §5.4 RFC amendments needed (Round 0 of this slice)

- **RFC-006 §"Transports"** — add TCP transport spec referencing handshake envelope shape (§4.3 above) and auth model (§5.2).
- **RFC-008 §"Transport boundary"** — note that TCP is an additional supported transport behind the same envelope contract; PTY remains the default.
- Bump RFC-006 to v2.1.0 (minor — additive change).

---

## §6. CLI surface

### §6.1 `llmnb` subcommands

| Subcommand | Purpose | Example |
|---|---|---|
| `llmnb execute <notebook>` | Run a `.llmnb` or `.magic` end-to-end. Default: live mode. Modes: `--mode {stub,live,replay}`. Output: writes outputs back to the notebook (or `--output OUT`). | `llmnb execute tests/fixtures/spawn-and-notify.magic --mode stub` |
| `llmnb convert <in> <out>` | Format conversion. Supports `.llmnb ↔ .magic`, `.ipynb → .llmnb` (one-way). | `llmnb convert experiment.ipynb experiment.llmnb` |
| `llmnb validate <notebook>` | Parse + check magic syntax (calls `cell_text.parse_cell` per cell). Emits K3x errors as exit codes. | `llmnb validate experiment.llmnb` |
| `llmnb smoke {paper-telephone,supervisor,metadata-writer}` | Run a named smoke. Replaces `python -m llm_kernel <name>-smoke`. | `llmnb smoke supervisor` |
| `llmnb auth init` | Generate `LLMNB_AUTH_TOKEN`, write to `.env`. | `llmnb auth init` |
| `llmnb serve` | Boot a kernel in TCP mode. Thin wrapper over `python -m llm_kernel serve --transport tcp`. | `llmnb serve --bind 127.0.0.1:7474` |

### §6.2 `execute` modes

| Mode | Behavior | Use case |
|---|---|---|
| `live` (default) | Full kernel boot, real LiteLLM proxy or Anthropic passthrough, real claude-code spawns | End-to-end runs |
| `stub` | Kernel boot but agent endpoints replaced with deterministic stubs from `llm_client/stubs/` (canned responses keyed by cell text hash) | Tests-as-notebooks; CI without API keys |
| `replay` | Kernel boot + a `.replay.jsonl` recording (captured from a prior `live` run); responses served from the recording | Debug repro; offline regression tests |

### §6.3 Format converters

```python
# llm_client/notebook.py
def llmnb_to_magic(llmnb: dict) -> str: ...
def magic_to_llmnb(magic_text: str, *, base_metadata: dict | None = None) -> dict: ...
def ipynb_to_llmnb(ipynb: dict) -> dict: ...   # one-way; preserves code+markdown cells, drops outputs
```

`llmnb ↔ magic` is round-trip identical (same parse rules as S5.0). `ipynb → llmnb` is one-way: code cells map to `@@scratch` (or `@@native` if `metadata.kernelspec.name == "python3"`), markdown cells map to `@@markdown`.

---

## §7. Slice breakdown

Five sub-slices. **a/b/c are sequential** (each builds on the prior). **d and e fan out parallel** after c lands.

| Slice | Scope | Sizing | Depends on |
|---|---|---|---|
| **S5.0.3a** Wire promotion | Move schemas to `llm_kernel/wire/`, export JSON, add `WIRE_VERSION`, no behavior change | S (~0.3d) | S5.0 shipped |
| **S5.0.3b** Driver extraction | Create `llm_client/` package with `boot.py`, `driver.py`, `notebook.py`; refactor `_run_agent_supervisor_smoke` boot block; smokes consume driver | M (~0.5d) | S5.0.3a |
| **S5.0.3c** Notebook executor | `llm_client.executor.run_notebook`, stub/live/replay modes, `llmnb execute` CLI, format converters | M (~0.7d) | S5.0.3b |
| **S5.0.3d** TCP + auth | TCP transport, token auth, handshake envelope, RFC-006/-008 amendments | M (~0.5d) | S5.0.3c |
| **S5.0.3e** PEP-517 split | Two distributions, shared workspace, CI publish path, deprecation notice on `python -m llm_kernel <smoke>-smoke` | S (~0.3d) | S5.0.3c |

### §7.1 Round 0 (operator, ~30min)

Two RFC amendments must land before slice d dispatches:

1. **RFC-006 v2.1.0** — adds §"Transports" with TCP spec; adds `kernel.handshake` envelope shape; specifies version-mismatch behavior.
2. **RFC-008 v1.0.1** — note that TCP is supported behind the same envelope contract.

### §7.2 Dispatch shape

- a → b → c on a single agent or coordinator (file-disjoint within each, but later slices need earlier package layout in place).
- d and e in parallel after c, file-disjoint:
  - d touches `llm_kernel/wire/`, `llm_kernel/__main__.py` (serve subcommand), `llm_client/transport/tcp.py`, RFC docs.
  - e touches `pyproject.toml` (split), CI workflows, `llm_client/cli/__main__.py` (deprecation aliases).

---

## §8. Test surface

### §8.1 Per-slice tests

| Slice | New tests |
|---|---|
| **a** | `test_wire_public_api.py` (importing `llm_kernel.wire` exports the documented surface; `_rfc_schemas` aliases to wire); `test_wire_version.py` (constants present, semver-shaped); `test_schema_export.py` (JSON files generated match Python validators). |
| **b** | `test_boot_minimal_kernel.py` (driver boots a kernel, hands back a connection); `test_smokes_use_driver.py` (existing smokes pass after refactor); `test_lint_boundary.py` (driver imports of non-public kernel modules fail lint check, run as unit test). |
| **c** | `test_executor_stub_mode.py` (run a fixture notebook with stubbed agents, deterministic outputs); `test_executor_live_mode.py` (gated by `ANTHROPIC_API_KEY`, runs a small notebook end-to-end); `test_executor_replay_mode.py` (record then replay); `test_format_converters.py` (llmnb↔magic round-trip, ipynb→llmnb mapping); `test_cli_execute.py` (CLI invocation). |
| **d** | `test_tcp_transport.py` (kernel binds, client connects); `test_handshake_envelope.py` (version match, mismatch, missing); `test_auth_token.py` (correct, wrong, missing → close); `test_one_connection_at_a_time.py` (second client gets `kernel_busy`). |
| **e** | `test_pyproject_split.py` (each pyproject builds independently); `test_smoke_alias_deprecation.py` (`python -m llm_kernel agent-supervisor-smoke` still works, prints deprecation notice). |

### §8.2 Smoke targets after slice c

- `llmnb smoke supervisor` (replaces `python -m llm_kernel agent-supervisor-smoke`) — passes Tier 3 acceptance: 7+ Anthropic calls intercepted, `notify` + `report_completion` observed.
- `llmnb execute tests/fixtures/spawn-and-notify.magic --mode stub` — runs a hand-authored magic-text fixture end-to-end without API keys, in <5s, byte-identical outputs across runs.

### §8.3 Tier-4 smoke (after slice d)

- Boot kernel with `llmnb serve --bind 127.0.0.1:7474`, run `llmnb execute notebook.llmnb --connect tcp://127.0.0.1:7474 --token …` from a separate process, verify equivalent execution to local-PTY mode.

---

## §9. Interface contracts (locked before dispatch)

These signatures are the cross-module call sites. Each agent's brief carries the relevant subset.

### `llm_client.boot` (slice b exposes; c, d consume)

```python
def boot_minimal_kernel(
    *,
    proxy: Literal["litellm", "passthrough", "stub"] = "litellm",
    work_dir: Path | None = None,
    transport: Literal["pty", "unix", "tcp"] = "pty",
    bind: str | None = None,                  # for tcp
    auth_token: str | None = None,            # for tcp
) -> KernelConnection:
    """Boot a kernel + proxy + dispatcher + tracker. Returns a connection
    handle. Caller calls .close() to tear down."""

class KernelConnection:
    session_id: str
    wire_version: str
    def send(self, envelope: dict) -> None: ...
    def recv(self, *, timeout: float | None = None) -> dict: ...
    def close(self) -> None: ...
```

### `llm_client.driver` (slice b exposes; c consumes)

```python
def ship_envelope(conn: KernelConnection, envelope: dict) -> dict:
    """Send + await matching response (by correlation_id). Raises on timeout."""

def collect_snapshots(conn: KernelConnection, *, until: Callable[[dict], bool]) -> list[dict]:
    """Drain Family F snapshots until `until(snapshot)` returns True."""
```

### `llm_client.executor` (slice c exposes)

```python
def run_notebook(
    path: Path,
    *,
    output: Path | None = None,
    mode: Literal["stub", "live", "replay"] = "live",
    replay_recording: Path | None = None,
    record_to: Path | None = None,             # capture .replay.jsonl
) -> ExecutionResult:
    """Boot a kernel, ship every operator-action implied by the notebook,
    collect snapshots, write outputs back. ExecutionResult carries
    success/error counts + final notebook state."""
```

### `llm_client.notebook` (slice c exposes)

```python
def llmnb_to_magic(llmnb: dict) -> str: ...
def magic_to_llmnb(magic_text: str, *, base_metadata: dict | None = None) -> dict: ...
def ipynb_to_llmnb(ipynb: dict) -> dict: ...
```

---

## §10. Risks (may force RFC erratum or scope adjustment)

1. **Hidden non-wire kernel imports inside smokes.** When refactoring `_run_agent_supervisor_smoke` (slice b), some currently-imported internals (e.g., `MagicMock` kernel + `_CommMgr`) may leak into the driver because they're not envelopes — they're test scaffolding the supervisor expects. Mitigation: those go in `llm_client/_test_helpers/` with the same lint exemption tests already have.

2. **Tool input/output schemas are only half the wire.** Family A/B/C/F/G envelope shapes currently live as Python dicts in `custom_messages.py`, not as JSON Schemas. Slice a must derive schemas from the dict shapes. If any envelope shape is ambiguous (optional fields not enumerated), that's an RFC-006 erratum.

3. **TCP exposes the kernel to a wider attack surface.** A token-only model is fine for trusted-network use (CI, devcontainers, single-tenant cloud). A truly hostile network needs mTLS (V2+). Document explicitly in `llmnb serve --help`: "TCP mode is for trusted networks only; bind to 0.0.0.0 only inside an authorized perimeter."

4. **One-connection-at-a-time may surprise users.** A user running `llmnb execute` against a remote kernel that the extension is also connected to will get `kernel_busy`. Mitigation: clear error message + V2 multi-client tracking issue. Don't hack around it in V1 (the kernel currently assumes a single dispatcher).

5. **`ipynb → llmnb` cell mapping is lossy by design.** Code cells become `@@scratch` (no agent binding); markdown stays markdown; outputs drop. Fine for "import an existing notebook to play with" but not for "round-trip a Jupyter workflow." The CLI prints a warning summarizing what was dropped.

6. **PEP-517 split increases CI complexity.** Two builds, two publish steps, version coupling. Mitigation: single source of truth for `WIRE_VERSION` in `llm_kernel.wire.version`; both packages import it. CI builds both in one workflow.

7. **Headless executor needs operator-action authority.** The executor implicitly issues operator actions (cell execute, drift acknowledge, approval response). In stub mode this is fine. In live mode, an unattended executor could approve mock-prod-divergent escalations. Slice c must ship with an `--unattended` flag that auto-rejects all `escalate` requests by default. Operator opts in to auto-approve only for trusted notebooks.

If any risk surfaces an RFC ambiguity, the implementing agent flags it (Engineering Guide §8.5 — flag, don't guess); operator ratifies an erratum before implementation continues.

---

## §11. Critical files (by slice)

| Path | Owning slice | Edit nature |
|---|---|---|
| `vendor/LLMKernel/llm_kernel/_rfc_schemas.py` | a | Aliased; content moves to `wire/tools.py` |
| **NEW** `vendor/LLMKernel/llm_kernel/wire/__init__.py` | a | Public API surface |
| **NEW** `vendor/LLMKernel/llm_kernel/wire/version.py` | a | Wire version constants |
| **NEW** `vendor/LLMKernel/llm_kernel/wire/families.py` | a | Family A/B/C/F/G envelope shapes |
| **NEW** `vendor/LLMKernel/llm_kernel/wire/tools.py` | a | Promoted from `_rfc_schemas.py` |
| **NEW** `vendor/LLMKernel/llm_kernel/wire/schemas/*.json` | a | Build-time JSON exports |
| **NEW** `vendor/LLMKernel/llm_kernel/wire/export.py` | a | `python -m llm_kernel.wire.export` generator |
| **NEW** top-level `llm_client/` package | b | New driver package |
| **NEW** `llm_client/boot.py` | b | `boot_minimal_kernel` |
| **NEW** `llm_client/driver.py` | b | Envelope shipping + snapshot draining |
| **NEW** `llm_client/transport/{pty.py,unix.py,tcp.py}` | b (pty/unix), d (tcp) | Transport implementations |
| **NEW** `llm_client/_test_helpers/` | b | MagicMock kernel + CommMgr scaffolding |
| `vendor/LLMKernel/llm_kernel/__main__.py` | b, e | Smokes refactored to call `llm_client`; deprecation aliases |
| **NEW** `llm_client/executor.py` | c | `run_notebook()` |
| **NEW** `llm_client/notebook.py` | c | Format converters |
| **NEW** `llm_client/stubs/` | c | Canned responses for stub mode |
| **NEW** `llm_client/cli/__main__.py` | c | `llmnb` entry-point |
| **NEW** `llm_client/cli/{execute,convert,validate,smoke,auth,serve}.py` | c, d | Subcommands |
| `docs/rfcs/RFC-006-kernel-extension-wire-format.md` | Round 0 | Add §"Transports" + handshake envelope; bump v2.1.0 |
| `docs/rfcs/RFC-008-pty-transport.md` | Round 0 | Note TCP as additional transport; bump v1.0.1 |
| **NEW** `pyproject.toml` (root, workspace) | e | Workspace config |
| `vendor/LLMKernel/pyproject.toml` | e | `llmnb-kernel` distribution |
| **NEW** top-level `pyproject.toml` for `llm_client` | e | `llmnb` distribution |
| **NEW** `tests/test_lint_boundary.py` | b | Lint rule enforcement |

**File-disjoint by design**: a touches `wire/` only; b touches `llm_client/` + boot block in `__main__.py`; c touches `llm_client/executor.py` + `cli/`; d touches `transport/tcp.py` + handshake; e touches packaging only. No two slices edit the same file simultaneously.

---

## §12. Acceptance (whole slice, gate at end)

1. **Per-slice tests green** under `pytest -n auto --dist=loadfile --timeout=60`.
2. **Lint boundary holds** — no `llm_client/**` imports of non-public `llm_kernel` modules.
3. **`llmnb execute tests/fixtures/spawn-and-notify.magic --mode stub`** runs end-to-end in <5s with byte-identical outputs across 10 consecutive runs.
4. **`llmnb smoke supervisor`** with `LLMKERNEL_USE_PASSTHROUGH=1` + valid `ANTHROPIC_API_KEY` intercepts 7+ Anthropic calls, observes `notify` + `report_completion`, equivalent to the legacy `python -m llm_kernel agent-supervisor-smoke`.
5. **TCP smoke** (slice d): kernel + driver in separate processes, full notebook run completes equivalently to PTY mode.
6. **PEP-517 split** (slice e): both `pip install ./vendor/LLMKernel` and `pip install .` succeed in clean envs; `llmnb --help` works after the latter; `python -m llm_kernel mcp-server` works after the former.
7. **Engineering Guide refinement check** — any new architectural learning surfaced during the slice (e.g., a non-wire dependency the smokes turned out to need) lands as a guide amendment before signoff.
8. **Operator approves** — typically as a tag (`v1-driver-extracted`) or a commit message marker.

---

## §13. After this slice

S5.0.3 unlocks:

- **Tests-as-notebooks**: `llmnb execute tests/fixtures/*.magic --mode stub` becomes a pytest target. Hand-authored fixtures replace narrow per-method tests for end-to-end behavior.
- **CI without VS Code**: `llmnb execute` is the headless equivalent of the extension; CI smokes the kernel without booting an editor.
- **External orchestrators**: a Rust or Go driver consumes `llm_kernel/wire/schemas/*.json` and speaks TCP. No Python dependency.
- **Future Jupyter ZMQ shim** (V2+, optional): a separate `llmnb-jupyter` package wraps the driver to expose the ZMQ wire. Out of scope here.
- **Multi-kernel orchestration** (V2+): a driver fanning out to multiple kernels shares the same handshake protocol. Slice S5.0.3 lays the foundation; multi-client kernel work is a separate slice.

---

## §14. See also

- [PLAN-S5.0-cell-magic-vocabulary.md](PLAN-S5.0-cell-magic-vocabulary.md) — text canonicalization this builds on
- [PLAN-S5.0.1-cell-magic-injection-defense.md](PLAN-S5.0.1-cell-magic-injection-defense.md) — bidirectional hash strip discipline preserved across the wire
- [docs/rfcs/RFC-001-mcp-tool-taxonomy.md](../rfcs/RFC-001-mcp-tool-taxonomy.md) — tool schemas being promoted to public API
- [docs/rfcs/RFC-006-kernel-extension-wire-format.md](../rfcs/RFC-006-kernel-extension-wire-format.md) — wire format being amended in Round 0
- [docs/rfcs/RFC-008-pty-transport.md](../rfcs/RFC-008-pty-transport.md) — current transport that TCP joins
- [docs/atoms/discipline/sub-agent-dispatch.md](../atoms/discipline/sub-agent-dispatch.md) — dispatch methodology this slice uses
- [docs/atoms/discipline/zachtronics.md](../atoms/discipline/zachtronics.md) — visible-tile principle (CLI surface honors it: every flag visible, no hidden config)
