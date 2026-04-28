# RFC-009: Zone control — configuration sources, precedence, and discovery

**Status**: Draft, Issue 1, 2026-04-28
**Version**: 1.0.0
**Related**: RFC-002 (agent supervisor argv + env), RFC-005 (`metadata.rts.config`), RFC-006 §6 (operator.action), RFC-008 (PTY transport env vars), Engineering Guide §11.8 (VS Code config-priority anti-pattern)
**Driver**: Two recent failures (workspace-shadows-global useStub, PATH-not-inherited claude discovery) traced to no spec defining how settings flow between the operator, the extension, the kernel, and Claude Code. Each subsystem reinvents discovery; each rediscovery is a defect class.

## 1. Scope

This RFC specifies **zone control** — the canonical mechanism by which a notebook zone's runtime behavior is parameterized. It enumerates the settings sources, defines precedence among them, and pins the discovery contracts that the kernel and extension must follow.

A "zone" per BSP-002 §1 is one notebook. "Zone control" is the act of resolving the effective value for any given setting at the moment it is read.

In scope:
- Setting sources (env vars, CLI args, settings.json, `metadata.rts.config`, defaults, runtime probes)
- Precedence rules per setting class
- Discovery contracts (e.g., where claude lives)
- Naming conventions (env var prefixes, settings namespace)
- Failure modes (K-class)
- The `zone_control` module (kernel-side) that implements §3-§5

Out of scope (deferred, V2+):
- Per-cell setting overrides (would need RFC-005 amendment)
- Multi-zone settings sharing (V4 multi-everything)
- Config hot-reload (today: read at boot; restart to change)

## 2. Source enumeration

| # | Source | Side | Lifetime | Examples | Documented in |
|---|---|---|---|---|---|
| 1 | Process env vars | both | per-process | `LLMNB_CLAUDE_BIN`, `LLMNB_MARKER_FILE`, `LLMKERNEL_USE_BARE`, `ANTHROPIC_API_KEY` | This RFC §4 |
| 2 | CLI args (kernel) | kernel | per-spawn | `--bare`, `--model`, `--session-id` | RFC-002 §argv |
| 3 | CLI args (claude subprocess) | kernel→claude | per-spawn | `--system-prompt-file`, `--mcp-config` | RFC-002 §argv |
| 4 | VS Code workspace settings (`.vscode/settings.json`) | extension | per-workspace | `llmnb.kernel.useStub`, `llmnb.kernel.pythonPath` | This RFC §4 + Engineering Guide §11.8 |
| 5 | VS Code user settings (Global) | extension | per-user | (any `llmnb.*` setting) | This RFC §4 |
| 6 | `package.json contributes.configuration` defaults | extension | static | default for any `llmnb.*` setting | extension manifest |
| 7 | `metadata.rts.config` (recoverable + volatile) | kernel | per-notebook (persisted) | template version, agent recoverable list | RFC-005 §config |
| 8 | `pyproject.toml` (pixi/python deps) | kernel | static | claude binary install location | pyproject |
| 9 | Pixi env layout (filesystem probe) | both | static | `<repo>/.pixi/envs/kernel/claude.cmd` | This RFC §5 |

Each source has a different lifetime, scope, and trust level. The RFC's job is to define how they compose.

## 3. Precedence — general rule

For any setting `S`, the effective value is the **first present** entry in this ordered list:

1. CLI arg (kernel only; per-spawn override; never `metadata.rts.config`-persisted)
2. Process env var (per-process; always honored)
3. VS Code workspace settings (extension only)
4. VS Code user (Global) settings (extension only)
5. `metadata.rts.config` (kernel only; recoverable subsection)
6. `package.json contributes.configuration` default (extension only)
7. Module-level constant (kernel only; documented in source)
8. Discovery probe (filesystem walk, last resort)

**A setting is read once at "effective time"** (process boot, kernel spawn, agent spawn, depending on the setting's lifetime — see §6). Subsequent changes to lower-priority sources do NOT take effect until next read.

## 4. Per-setting class precedence

Different setting classes have different effective times and sensible source sets. The RFC enumerates the canonical classes; new settings MUST be assigned to one of these classes.

### 4.1 Booleans / mode switches (e.g., `useStub`, `useBare`, `usePassthrough`)

| Priority | Source |
|---|---|
| 1 | env var (`LLMNB_*` extension; `LLMKERNEL_*` kernel) |
| 2 | VS Code workspace setting (extension) |
| 3 | VS Code user setting (extension) |
| 4 | `metadata.rts.config.volatile` (kernel) |
| 5 | `package.json` default / module-level constant |

Effective time: process boot for extension settings; agent spawn for kernel settings.

### 4.2 File paths to system tools (e.g., `claudePath`, `pythonPath`)

| Priority | Source |
|---|---|
| 1 | env var override (`LLMNB_CLAUDE_BIN`, `LLMNB_PYTHON_BIN`) |
| 2 | VS Code workspace setting (`llmnb.kernel.claudePath`, `llmnb.kernel.pythonPath`) |
| 3 | VS Code user setting |
| 4 | `package.json` default (often `null` / unset) |
| 5 | PATH lookup via `shutil.which` (kernel) / `where`/`which` (extension) |
| 6 | Pixi env discovery probe — walk up from cwd looking for `<repoRoot>/.pixi/envs/kernel/<bin>` |

Effective time: agent spawn (kernel); extension activation (extension).

The pixi-env probe (#6) is the lowest priority and only fires when steps 1-5 produce nothing. Probe rules (kernel side):
- Walk up from `os.getcwd()` for at most 6 levels looking for `.pixi/envs/kernel/`.
- On Windows, look for `<binname>.cmd` then `<binname>.exe` then `<binname>` inside that dir.
- On POSIX, look for `<binname>` inside `.pixi/envs/kernel/bin/`.
- On match, return the absolute path AND set the corresponding env var (`LLMNB_CLAUDE_BIN`, etc.) so subsequent subprocess spawns inherit it.

### 4.3 String values with constrained domains (e.g., `model`, `agentTask`)

| Priority | Source |
|---|---|
| 1 | CLI arg (kernel; per-spawn) |
| 2 | env var |
| 3 | `metadata.rts.config.volatile` |
| 4 | `package.json` default (rarely; usually unset) |

### 4.4 Authentication credentials (e.g., `ANTHROPIC_API_KEY`)

| Priority | Source |
|---|---|
| 1 | env var ONLY (security: never persisted in VS Code settings or `metadata.rts.config`) |

This is a hard rule. Credentials in workspace settings or in `metadata.rts.config` are a forbidden-field violation per RFC-005 §"Forbidden secrets" and the metadata-loader's secret scan (extension side) MUST refuse to load any `.llmnb` carrying them.

### 4.5 Diagnostic toggles (e.g., `LLMNB_E2E_VERBOSE`, `LLMNB_MARKER_FILE`)

| Priority | Source |
|---|---|
| 1 | env var ONLY |

Diagnostic settings are test-infra concerns and never belong in user-facing config. Kept env-only so production never inadvertently turns on test instrumentation.

## 5. Naming conventions

| Source | Prefix / namespace | Example |
|---|---|---|
| Extension env var | `LLMNB_*` | `LLMNB_CLAUDE_BIN` |
| Kernel env var | `LLMKERNEL_*` | `LLMKERNEL_USE_BARE` |
| Cross-cutting / shared env var | `LLMNB_*` | `LLMNB_MARKER_FILE` (extension and kernel both write) |
| VS Code setting | `llmnb.<area>.<name>` | `llmnb.kernel.useStub`, `llmnb.kernel.claudePath` |
| Kernel CLI arg | RFC-002 §argv | `--bare`, `--model`, `--session-id` |
| `metadata.rts.config` field | RFC-005 §config | `config.recoverable.agents[]`, `config.volatile.kernel.rfc_006_version` |

When a setting has both an env var and a VS Code setting form, the env var name MUST be the upper-snake-case of the setting key with the `llmnb.` prefix replaced by `LLMNB_`. Example: `llmnb.kernel.claudePath` → `LLMNB_CLAUDE_PATH` (or `LLMNB_CLAUDE_BIN` per common usage). Document the mapping in the module-level docstring of `zone_control`.

## 6. The `zone_control` module (kernel side)

A new module at `vendor/LLMKernel/llm_kernel/zone_control.py` is the canonical entry point for the kernel to read any setting. The module:

1. Exposes a `ZoneConfig` dataclass typed by setting class.
2. Provides `resolve_zone_config(...)` factory that applies §3 / §4 precedence.
3. Provides per-setting helpers (`locate_claude_bin()`, `effective_use_bare()`, etc.) that document the precedence applied for that specific setting.
4. Logs a `zone_control.resolved` diagnostic mark per lookup with `{setting_name, value, source}` so an operator can answer "where did this value come from?" by reading the marker file.
5. Caches at the module level for the process lifetime — re-resolution requires explicit invalidation (V1 doesn't expose this; restart kernel to change).

Skeleton:

```python
# zone_control.py — RFC-009 implementation.

@dataclass(frozen=True)
class ZoneConfig:
    claude_bin: Optional[str]
    use_bare: bool
    use_passthrough: bool
    model: Optional[str]
    anthropic_api_key: Optional[str]  # NEVER persisted; env-only
    marker_file: Optional[str]        # diagnostic
    # ... others as added

def resolve_zone_config(*, cli_args: Mapping[str, Any] = ...) -> ZoneConfig:
    """Apply RFC-009 §3 + §4 precedence to produce the effective config."""

def locate_claude_bin() -> Optional[str]:
    """RFC-009 §4.2 — env > settings (passed via env from extension) > PATH > pixi probe."""
```

Existing call sites must migrate:
- `agent_supervisor.py`'s `shutil.which("claude")` → `zone_control.locate_claude_bin()`
- `_provisioning.py`'s `--bare` flag application → reads `zone_control.effective_use_bare()`
- `pty_mode.py`'s env reads → resolved through `zone_control` at boot
- Extension-side preflight → invokes its own discovery (mirrors §4.2) before launch and exports the resolved values via env so the kernel inherits them

Migration is non-atomic: each call site can move independently. The contract is the precedence rules, not the module.

## 7. Wire integration

The wire (RFC-006) is unchanged. The extension still ships `notebook.metadata mode:"hydrate"` envelopes carrying `config.recoverable.agents[]`; the kernel still reads the kernel-side env vars set by the extension's `node-pty.spawn`. This RFC just makes the precedence rules explicit and the discovery contracts pinned.

If V2+ wants a `notebook.metadata mode:"config_change"` envelope to push setting changes mid-session, that's an additive amendment to RFC-006 and a corresponding `zone_control.invalidate_and_resolve()` entry point. Not in V1.

## 8. Failure modes (K-class — config namespace, K80+)

| Code | Symptom | Marker | Operator action |
|---|---|---|---|
| K80 | Required setting unresolved (no source provided a value, no default) | `zone_control_missing_required` with `setting_name` | Set the env var or add a setting |
| K81 | Setting value out of declared domain (e.g., `model: "not-a-real-model"`) | `zone_control_invalid_value` with `setting_name`, `value`, `expected_domain` | Correct the value at the highest-priority source |
| K82 | Forbidden secret in non-env source (e.g., `api_key` in workspace settings) | `zone_control_forbidden_secret` with `setting_name`, `source` | Move to env var; remove from settings |
| K83 | Discovery probe failed (e.g., pixi env not found, claude not on PATH and not in pixi env) | `zone_control_discovery_failed` with `binary`, `searched_paths[]` | Set the explicit env var; install the binary |
| K84 | Source priority violation detected at runtime (e.g., workspace setting shadows a Global update — caught at debug-log level only) | `zone_control_priority_shadow` with `setting_name`, `winning_source`, `lower_source` | Informational; not an error. Surfaces as a warning when `LLMNB_DEBUG_CONFIG=1`. |

K80-K83 are kernel-fatal at agent-spawn time (the supervisor refuses to spawn). K84 is informational.

## 9. Test surface

`vendor/LLMKernel/tests/test_zone_control.py`:

- `test_resolve_with_only_default` — no env, no settings → `ZoneConfig` carries the package-default values.
- `test_env_var_beats_default` — for each setting in §4.1-§4.4, env var overrides default.
- `test_credentials_are_env_only` — setting `anthropic_api_key` via any non-env source raises K82.
- `test_locate_claude_path_first_then_pixi` — PATH hit returns PATH; PATH miss falls through to pixi probe.
- `test_locate_claude_pixi_probe_walks_up` — finds `.pixi/envs/kernel/claude.cmd` from a deep cwd.
- `test_locate_claude_no_source_returns_none` — exhaustive miss returns `None`; caller surfaces K83.
- `test_diagnostic_marker_per_resolution` — every `resolve_zone_config` call writes one `zone_control.resolved` marker per setting touched.

## 10. Implementation slice

Single ~3h slice owned by **K-ZC**:

1. RFC-009 ratification (this doc) — operator-only, ~15min.
2. Create `zone_control.py` skeleton + `ZoneConfig` dataclass + `resolve_zone_config()` (~1h).
3. Implement `locate_claude_bin()` per §4.2 (~30min).
4. Refactor `agent_supervisor.spawn` and `_provisioning.build_argv` to read through `zone_control` (~30min).
5. Tests per §9 (~30min).
6. Update extension-side preflight (`extension/test/util/preflight.ts`) to mirror §4.2 discovery (resolve claude path, export `LLMNB_CLAUDE_BIN` to process env so the kernel inherits it). The current heuristic in `locateClaudeAndUpdatePath()` becomes the spec'd path.

## 11. Why this isn't overengineering

Every config-class anti-pattern this project has hit could be re-cast as "a setting was read from a source the operator didn't expect to win":

- §11.8 Engineering Guide: workspace settings shadowed Global update. Resolved by deletion.
- claude-binary discovery: PATH didn't propagate; the test heuristic worked around it.
- `useStub: false` in fixture: same root cause as §11.8.

These will keep repeating until the precedence is pinned. RFC-009 pins it. The `zone_control` module is the canonical implementation; once every call site routes through it, the precedence is a question we never have to answer ad-hoc again.

## Changelog

- **Issue 1, 2026-04-28**: initial. Source enumeration §2; general precedence §3; per-class rules §4; naming §5; module skeleton §6; K80-K84 namespace §8; tests §9; ~3h K-ZC slice §10.
