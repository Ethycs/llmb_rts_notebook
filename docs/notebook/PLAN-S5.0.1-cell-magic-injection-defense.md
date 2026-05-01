# Plan: S5.0.1 — Cell-magic injection defense (HMAC-hash pin + emission ban)

**Status**: V1 shipped (§3.1–§3.11 all landed across multiple commits). Implementation history:
- §3.1–§3.4 (HMAC primitive + contamination detector + sanitizer + bidirectional hash strip): `magic_hash.py` (272 LoC), submodule `360b658` (S5.0.1a foundation).
- §3.5, §3.7 (pin-aware parser + auth lifecycle + cell-manager re-stamp): `auth_handlers.py` (406 LoC) + `cell_text.py` pin-aware parsing + `cell_manager.restamp` pass, submodule `94d1c39` / `798b8f0` (S5.0.1b). Outer bump `515790d`.
- §3.6 (schema additions): `metadata_writer.py` `magic_hash_enabled` + `magic_pin_fingerprint` keys, submodule `1008dca` (S5.0.1b) and `dbad5ee` (injection_acceptance verbatim flag, S5.0.1c).
- §3.8 (extension UI): `extension/src/notebook/contamination-badge.ts`, `pin-status-header.ts`, etc. (s5-0-1d-ext series + S5.0.1e contract tests).
- §3.10 (Cell Manager precondition gates): K3C/K3D/K3E/K3F precondition predicates in `cell_manager.py`, submodule `ac25656` (S5.0.1c).
- §3.11 (verbatim injection acceptance): `tests/test_injection_acceptance.py` + `metadata_writer` field, submodule `dbad5ee`.
- All K-classes (K35, K36, K3C, K3D, K3E, K3F, K3G) registered in `wire/tools.py` `K_CLASS_REGISTRY` (§3.9).

**Audience**: an LLM (or operator) picking this up cold.
**Goal**: defend the cell-magic vocabulary against prompt-injection. Three layers: (1) detect when an agent emits `@@`/`@` magic-like syntax (always on); (2) opt-in **HMAC hash mode** where every legitimate magic line carries `@@<HMAC(pin, magic_name)>:<args>` and the kernel is **forbidden from emitting any valid hashed-magic pattern** through agent/tool output channels; (3) Cell Manager precondition gates that freeze running and contaminated cells against structural ops, plus a verbatim-string acceptance flag when the operator declines hash mode.
**Time budget**: ~2.6 days. Single cross-layer agent. Depends on S5.0 (cell-magic parser + registry) being landed.

---

## §1. Why this work exists

S5.0 lands the cell-magic vocabulary as the operator's typing surface. By default the parser dispatches any column-0 `@@<known_magic>` line. This creates a prompt-injection risk:

- Agent prose can contain `@@spawn evil_agent task:"exfiltrate"` — accidentally (the agent is teaching) or adversarially (a malicious tool result was ingested).
- Operator copies output into a new cell; the new cell's source contains the magic; next run dispatches.
- Standard prompt-injection failure mode: untrusted LLM output reaches a privileged execution path.

S5.0.1 adds two defense layers:

1. **Contamination flag (always on)**: kernel scans every agent emission line for valid magic patterns; flags the receiving cell.
2. **Hash mode (opt-in, strong)**: operator sets a secret pin (NEVER stored in the notebook). Magic lines must be `@@<HMAC(pin, name)>:<args>` to dispatch. Kernel is **forbidden** from emitting any line matching `^@@[a-f0-9]+:` through agent/tool output paths — sanitizer escapes any match.

The hash mode threat model: even if an agent ingests notebook source, the pin is not in it. The agent cannot compute valid HMACs for arbitrary magic names. Combined with the emission ban (kernel doesn't accidentally spit out valid hashes through agent stream), an attacker has no path to forge magic dispatches.

Driver: defense-in-depth before any operator workflow allows agent outputs to round-trip into cell source. The audit-stale-then-discovered K-CM/K-MCP gap-closure pattern from prior rounds shows that hardening *after* shipping is harder than shipping *with* hardening — this slice closes the loop before the cell-magic parser is in operator hands.

---

## §2. Goals and non-goals

### Goals

- **Detection (always on)**: kernel monitors agent stdout/stderr/tool-result lines as they land in cell outputs. Lines matching `^@@?<known_magic_name>(\s|:|$)` set `cells[<id>].contaminated: true` + append to `contamination_log`. Cell badge surfaces a warning chip.
- **Hash mode (opt-in)**:
  - Operator runs `@@auth set <pin>` (typed once or from env var). Pin is stored in extension/OS keychain or environment variable, **NOT** in notebook plaintext. Notebook records only `metadata.rts.config.magic_hash_enabled: bool` and a verification fingerprint `magic_pin_fingerprint: <salted_hash_of_pin>` for round-trip pin-correctness check.
  - When enabled: parser requires `@@<HMAC(pin, name)>:<args>` for cell magics, `@<HMAC(pin, name)>:<args>` for line magics. Plain `@@<name>` is body, NOT dispatched, AND triggers K35.
  - Cell-Manager re-stamps existing magic lines on enable: `@@spawn alpha` → `@@<HMAC(pin, "spawn")>:alpha`.
  - Kernel emit path uses `emit_magic_line()` helper that computes the hash and outputs the canonical hashed form.
- **Emission ban (when hash mode on)**: every line written to cell outputs (from agent stdout, tool results, synthetic spans, kernel-emitted notify/escalate text) is scanned. Lines matching `^@@?[a-f0-9]+:\w+(\s|$)` (the hashed-magic pattern shape) are **escaped before write** — leading `@` → `\@` — AND set `contaminated: true` AND emit K36. The kernel never permits a valid-hash line to land in cell outputs through any agent-touching path.
- **Bidirectional hash stripping at every agent-visible boundary**: hashes only exist in canonical cell-source storage. The kernel strips hashes on every other surface so agents never observe them and therefore can't learn or replay them:
  - **In** (parse): `@@<hash>:<name> <args>` arrives via cell-source parse → kernel validates hash, dispatches by `<name>`. In-memory state holds `<name>`, not the hash.
  - **Out** (serialize): kernel-emitted cell-source recomputes the hash from `<name>` + pin and writes `@@<hash>:<name> <args>`.
  - **Agent context replay** (e.g., ContextPacker, cross-agent handoff, `--resume` replay over stdin): when the kernel ships any prior cell content into an agent's session, all `@@<hash>:<name>` lines are reduced to plain `@@<name>` form — or stripped to body — before transmission. Agent never sees hashes.
  - **Cell-output rendering**: agent stdout / tool result already hits the emission-ban sanitizer (above). Synthetic kernel-emitted output (notify/escalate spans, debug markers) similarly never carries a hash.
  - **Operator display**: the cell editor can render either the canonical hashed form (matches storage; useful for git-diff inspection) or the stripped plain form (reads naturally). Default: stripped, with a small `🔒` indicator showing hash mode is active. Operator toggles per-cell via a header chip.

This bidirectional-strip property is the structural reason hash mode resists replay: even an agent that ingests another agent's output, a tool result, a context-packer replay, or a synthetic span gets the unhashed `@@<name>` form — body-only, never dispatchable.
- **Pin lifecycle**:
  - `@@auth set <pin>` initial set (validates length, character class, magic-name collision).
  - `@@auth rotate <new_pin>` atomic rotation: re-stamps every existing magic line in the notebook.
  - `@@auth off` disables hash mode; existing hashed lines stay valid as text (they decompose to body until operator rewrites them).
  - `@@auth verify` checks the stored pin matches the notebook's fingerprint.

### Non-goals

- Per-magic permission grants (V2+).
- Multi-operator multi-pin (V3+).
- Encrypted notebook bodies (V3+).
- Agent-side filtering ("don't emit syntax that looks like our magic") — defense lives at kernel boundary, not agent prompts.
- Pin recovery if operator loses it — V1: notebook unrecoverable to hash mode without new pin + manual re-stamp. V2+ recovery via key-derivation.

---

## §3. Concrete work

### §3.1 HMAC primitive — `vendor/LLMKernel/llm_kernel/magic_hash.py` (NEW, ~80 LoC)

```python
import hmac, hashlib

def magic_hash(pin: str, magic_name: str, *, length: int = 8) -> str:
    """HMAC-SHA256 of magic_name keyed by pin, hex-truncated to `length` chars.
    Default length 8 → 4 bytes → 1 in 4B forgery probability per attempt."""
    h = hmac.new(pin.encode("utf-8"), magic_name.encode("utf-8"), hashlib.sha256)
    return h.hexdigest()[:length]

def magic_pin_fingerprint(pin: str) -> str:
    """Salted SHA-256 of pin for round-trip verification.
    Stored in metadata.rts.config.magic_pin_fingerprint.
    Pin itself is NEVER stored in the notebook."""
    salt = b"llmnb-magic-v1-fingerprint"
    return hashlib.sha256(salt + pin.encode("utf-8")).hexdigest()[:16]

# Pattern matching the canonical hashed-magic line shape:
HASHED_MAGIC_LINE = re.compile(r"^@@?([a-f0-9]+):(\w+)(\s|$)")
```

The hash length tradeoff: 8 hex chars (32 bits) gives 1-in-4B forgery probability per attempt; an attacker pumping outputs through stdin/tool-result paths might burn many tries. V1 default = 8; operator can override via `@@auth set <pin> length:12` for stronger or `length:6` for shorter (typability vs strength).

### §3.2 Contamination detector — `vendor/LLMKernel/llm_kernel/agent_supervisor.py` (modest)

In the existing stdout/stderr reader, after each line is converted to a span:

```python
def _scan_for_magic_contamination(self, cell_id: str, line: str) -> None:
    # Layer 1: plain magic detection (always on)
    if _PLAIN_MAGIC_PATTERN.match(line):
        name = ...
        if name in CELL_MAGICS or name in LINE_MAGICS:
            self._flag_contaminated(cell_id, "plain magic syntax", line)

    # Layer 2: hashed magic detection (when hash mode enabled)
    if self._writer.get_setting("magic_hash_enabled"):
        if HASHED_MAGIC_LINE.match(line):
            # This is the EMISSION BAN — kernel must never let a valid
            # hashed magic line escape through agent/tool output.
            self._flag_contaminated(cell_id, "hashed magic emission ban violated", line)
            # Caller (the writer that's about to push the span to cell.outputs)
            # MUST escape the line: `@@deadbeef:spawn` → `\@@deadbeef:spawn`
            return "ESCAPE_REQUIRED"
    return None
```

The escape transformation: prepend `\` to the leading `@`. The escaped form `\@@<hash>:<name>` is body text, never dispatchable. Renderer can choose to strip the `\` for display while keeping the canonical-stored form escaped.

### §3.3 Output sanitizer wrapper — `vendor/LLMKernel/llm_kernel/socket_writer.py` (modest)

The writer's `append_output(cell_id, line)` path gains a sanitization step. When hash mode is on, every line passed to a cell's outputs is checked against `HASHED_MAGIC_LINE`. Match → escape leading `@` → write the escaped form → flag cell.

This is the single chokepoint that enforces the **emission ban**: every code path that writes to cell outputs flows through `socket_writer.append_output`. Sanitization at this layer catches all sources (agent stdout, tool results, synthetic span text, kernel notify/escalate emissions).

### §3.4 Bidirectional hash strip helper — `magic_hash.py`

```python
def strip_hash_from_line(line: str) -> str:
    """If line matches `@@<hash>:<name> <args>` (or `@<hash>:<name>`),
    return `@@<name> <args>` (or `@<name>`). Otherwise unchanged.
    Used at every agent-visible boundary; never affects canonical
    cell-source storage."""
    m = HASHED_MAGIC_LINE.match(line)
    if not m: return line
    sigil = "@@" if line.startswith("@@") else "@"
    return f"{sigil}{m.group(2)}{line[m.end(2):]}"

def strip_hashes_from_text(text: str) -> str:
    return "\n".join(strip_hash_from_line(L) for L in text.splitlines())
```

This helper is called by:
- **`socket_writer.append_output`** — sanitization layer for cell outputs (already covered by emission ban; this is the strip side of the same coin when the kernel itself legitimately emits something hash-shaped, which then must NOT make it to outputs).
- **`context_packer.pack`** — when assembling agent context, every prior cell's text is passed through `strip_hashes_from_text` before transmission. Agent receives `@@<name>` plain form, dispatchable as body only.
- **`agent_supervisor._replay_for_resume` / handoff injection** — synthetic user messages constructed from cell text are stripped before stdin write.
- **Renderer (X-EXT)** when in "human-readable" display mode — cell editor toggles between canonical hashed view and stripped view via a header chip.

Storage remains canonical (hashed). Strip only happens at egress to agent-visible surfaces.

### §3.5 Pin-aware parser — `vendor/LLMKernel/llm_kernel/cell_text.py` (modest)

Extend S5.0's `parse_cell` with hash mode awareness:

```python
def parse_cell(text: str, *, hash_enabled: bool = False, pin: str | None = None) -> ParsedCell:
    """In hash mode, only @@<HMAC(pin, name)>:<args> lines dispatch.
    Plain @@<name> lines are body and trigger K35 informational marker."""
    cell = ParsedCell(...)
    for line in text.splitlines():
        if hash_enabled and pin:
            m = HASHED_MAGIC_LINE.match(line)
            if m:
                hash_str, args = m.group(1), m.group(2) + line[m.end(2):]
                # Recover magic name from hash by checking each registered
                # name against magic_hash(pin, name)
                for name in CELL_MAGICS:
                    if hmac.compare_digest(magic_hash(pin, name), hash_str):
                        CELL_MAGICS[name].apply(cell, args.strip())
                        break
                else:
                    for name in LINE_MAGICS:
                        if hmac.compare_digest(magic_hash(pin, name), hash_str):
                            LINE_MAGICS[name].apply(cell, args.strip())
                            break
                    else:
                        cell.body.append(line)  # unknown hash → body
                continue
            elif _PLAIN_MAGIC_PATTERN.match(line):
                # Plain magic in hash mode = K35 violation, treated as body
                cell.body.append(line)
                continue
        else:
            # Permissive S5.0 path
            ...
        cell.body.append(line)
    return cell
```

Hash mode requires `pin` to be available at parse time — pulled from the kernel's runtime config (which sources from environment variable / OS keychain / extension settings, not the notebook).

### §3.5 Pin lifecycle magics — extension to `magic_registry.py`

```
@@auth set <pin> [length:<N>]    → set pin in keychain, enable hash mode, store fingerprint
@@auth rotate <new_pin>           → atomic re-stamp of all magic lines in notebook
@@auth off                        → disable hash mode (existing hashed lines stay as body)
@@auth verify                     → echo whether stored pin matches notebook fingerprint
@@auth status                     → show hash_enabled, fingerprint, length
```

Pin is read from the kernel's runtime context; never accepted via cell text in plaintext after initial set. Initial `@@auth set <pin>` line is consumed by the kernel and **immediately removed/replaced with `@@auth status`** in the cell text on next save — so the pin doesn't persist in the notebook source even briefly.

### §3.6 Schema additions — `metadata_writer.py`

```jsonc
metadata.rts.config = {
  ...,
  magic_hash_enabled: bool,                      // V1 default: false
  magic_pin_fingerprint: <16-char hex> | null,   // V1 default: null
  magic_hash_length: <int>                       // V1 default: 8
}

metadata.rts.cells[<id>] = {
  text, outputs, bound_agent_id,                 // existing
  contaminated: bool,                            // NEW
  contamination_log: [                           // NEW append-only audit
    { detected_at: <iso8601>, line: <truncated>, reason: <string>, layer: "plain" | "hashed_emission_ban" }
  ]
}
```

Pin itself is **never** in `metadata.rts.config`. Only the fingerprint (a one-way hash with a project-wide salt) is stored, for verification when the operator re-enters the pin.

### §3.7 Cell-Manager re-stamping

```python
def restamp_with_pin(self, old_pin: str | None, new_pin: str) -> int:
    """Walk every cell text. Replace every plain @@<name> with
    @@<magic_hash(new_pin, name)>:<args>. If old_pin is set, replace
    @@<old_hash>:<args> with @@<new_hash>:<args>. Atomic per BSP-007
    overlay-commit. Returns count of lines re-stamped."""
```

Re-stamp runs on `@@auth set` (first time) and `@@auth rotate`. Atomic across all cells.

### §3.8 Extension UI — `extension/src/notebook/cell-badge.ts` + new pin-status header

- **Cell-badge contamination chip**: amber "⚠ contaminated" when `cells[<id>].contaminated == true`. Tooltip shows last 3 contamination_log entries. Dismiss button clears the flag (keeps log).
- **Notebook-header pin chip**: 
  - `🔓 unprotected` when `magic_hash_enabled == false`
  - `🔒 hash mode (fingerprint: a3b4c5d6e7f8)` when enabled
  - Click → opens pin dialog: enter pin to verify against fingerprint OR rotate.
- **Pin entry dialog**: VS Code QuickInput; pin masked input; immediately tested via fingerprint; stored in `vscode.SecretStorage` (which uses OS keychain).

### §3.9 K-class additions

| Code | Name | When |
|---|---|---|
| K35 | `magic_pin_violation` | parser sees `@@<known_magic>` (plain) when hash mode is on; treated as body, logged |
| K36 | `cell_contaminated_by_agent_emission` | agent output contained either a plain magic name (always-on layer) or a hashed-magic pattern (emission-ban layer) |
| K37 | `pin_rotation_failed` | re-stamp couldn't complete (concurrent edit / corrupt cell text) |
| K38 | `magic_pin_too_short` | pin shorter than 12 characters; rejected |
| K39 | `magic_pin_collision` | pin matches a registered magic name or fingerprint salt; rejected |
| K3A | `hashed_magic_emission_ban` | hashed-magic pattern detected in agent/tool output stream; line escaped + cell flagged |
| K3B | `pin_fingerprint_mismatch` | operator entered wrong pin (fingerprint check fails); reject access |
| K3C | `cell_running_blocks_structural_op` | split/merge/move/promote/set_kind on a cell with an active execution |
| K3D | `cell_running_blocks_canonical_emit` | serializer / ContextPacker / clipboard-canonical-text on a running cell |
| K3E | `contaminated_cell_blocks_structural_op` | structural op on a contaminated cell |
| K3F | `contamination_clear_requires_explicit_op` | informational; any non-`clear_contamination` intent that tries to flip `contaminated` to false is rejected |
| K3G | `injection_acceptance_recorded` | informational; emitted when the verbatim acceptance string is written to `metadata.rts.config.injection_acceptance` |

---

## §4. Interface contracts

```python
# magic_hash.py
def magic_hash(pin: str, magic_name: str, *, length: int = 8) -> str: ...
def magic_pin_fingerprint(pin: str) -> str: ...

HASHED_MAGIC_LINE: re.Pattern   # ^@@?([a-f0-9]+):(\w+)(\s|$)

# magic_registry.py — extended
CELL_MAGICS["auth"]: ...   # subcommands: set / rotate / off / verify / status
RESERVED_NAMES = frozenset(...)  # adds "auth"

# cell_text.py — extended
def parse_cell(text: str, *, hash_enabled: bool = False, pin: str | None = None) -> ParsedCell: ...

# socket_writer.py — sanitization wrapper
def _sanitize_outbound_line(self, line: str) -> str:
    """If hash mode on and line matches HASHED_MAGIC_LINE, escape the
    leading @ and emit K3A. Idempotent on already-escaped lines."""

# cell_manager.py
def restamp_with_pin(self, old_pin: str | None, new_pin: str) -> int: ...

# Wire envelope additions
"set_magic_pin"               # parameters: { pin: <string>, length: <int> }
"rotate_magic_pin"            # parameters: { new_pin: <string> }
"clear_magic_pin"             # parameters: {}
"verify_magic_pin"            # parameters: { pin: <string> } → returns ok/mismatch
"clear_contamination"         # parameters: { cell_id: <string> } — operator-only
"record_injection_acceptance" # parameters: { accepted_at: <ISO8601> } — idempotent
```

---

## §3.10 Cell Manager precondition gates (running + contaminated)

Two structural-op invariants enforced at the Cell Manager surface:

### Running-cell freeze

A cell whose bound agent has an active execution (`cell_id ∈ AgentSupervisor.in_flight_cells`) is **edit-only**. Structural ops refuse with K3C; canonical-text emit refuses with K3D. Operator workflow: `@stop` the agent or wait for natural run completion before splitting / merging / moving / promoting / set-kind on the cell.

| Op | Allowed? | Code on refusal |
|---|---|---|
| Edit cell text in editor | ✓ | — |
| Receive output spans (runtime continues) | ✓ | — |
| Split / merge / move / promote / set_kind | ✗ | K3C |
| Canonical text emit (clipboard, ContextPacker, diff dump) | ✗ | K3D |

### Contaminated-cell freeze

A cell with `contaminated == true` (set by Layer 1 detector) refuses structural ops with K3E. The contamination flag is cleared **only** by the explicit `clear_contamination` operator-action intent — wired to a single dedicated cell-toolbar button (`llmnb.clearCellContamination`). No other code path on either side flips the flag to false.

```python
# vendor/LLMKernel/llm_kernel/cell_manager.py
def _check_structural_op_preconditions(self, cell_id: str, op_name: str) -> None:
    cell = self._writer.cell_view(cell_id)
    if self._supervisor.is_running_in(cell_id):
        raise StructuralOpRefused(code="K3C", reason=f"cell_running_cannot_{op_name}")
    if cell.contaminated:
        raise StructuralOpRefused(code="K3E", reason=f"contaminated_cell_cannot_{op_name}",
                                  contamination_log_tail=cell.contamination_log[-3:])

def clear_contamination(self, cell_id: str) -> None:
    """Explicit operator-only entry point. Audit-logs the clear."""
```

`socket_writer.append_output` enforces only the existing emission ban (sanitization on output spans). The canonical-text emit ban (K3D) is enforced at the **serializer** + **ContextPacker** + **clipboard** entry points, NOT at output append (output spans flow normally during runs).

## §3.11 Refusal flag — verbatim injection acceptance

When contamination is detected and the operator clicks **Continue without protection**, after a confirmation modal, the kernel writes the literal string to `metadata.rts.config.injection_acceptance`:

```
"The Operator Has Accepted Arbitrary Code Injection at <ISO8601>"
```

Properties (per the spec):
- **Verbatim format**: kernel writes the exact phrase. No abbreviation, no localization, no JSON-encoded variant. Every operator opening the notebook sees the same plain-English statement in any JSON inspection or git diff.
- **Idempotent on first set**: re-running `record_injection_acceptance` does NOT overwrite the timestamp; the original "accepted at" record stays.
- **Permanent in V1**: no clear command. The only way out is a future V2+ `clear_injection_acceptance` command behind a 3-step confirmation. Operator can enable hash mode AFTER acceptance — the marker stays as historical record alongside the new pin chip.
- **Survives copy / fork / paste**: stored in `metadata.rts.config`, serialized to `.llmnb`. Forking carries the marker forward.
- **Always-visible banner**: notebook header renders an orange/red banner: `⚠ This notebook accepts arbitrary code injection from agent outputs (recorded <timestamp>)`. Cannot be dismissed.

```jsonc
metadata.rts.config = {
  ...,
  injection_acceptance: <string> | null
  // When set: literal "The Operator Has Accepted Arbitrary Code Injection at <ISO8601>"
}
```

The wording is deliberately uncomfortable. Operator must explicitly click through a confirmation modal that quotes the string before it's written. Searchable across a notebook corpus.

---

## §5. Test surface

`vendor/LLMKernel/tests/test_magic_injection_defense.py` (NEW):

**Always-on layer (plain magic detection)**:
1. `test_agent_emit_with_at_at_spawn_flags_cell_contaminated`
2. `test_agent_emit_with_at_pin_flags_cell_contaminated`
3. `test_agent_emit_unknown_magic_does_not_flag` — `@@xyzzy` → no flag
4. `test_contamination_log_append_only`

**Hash mode parser**:
5. `test_parse_cell_in_hash_mode_with_correct_hash_dispatches`
6. `test_parse_cell_in_hash_mode_with_plain_magic_treats_as_body_with_K35`
7. `test_parse_cell_in_hash_mode_with_wrong_hash_treats_as_body`

**HMAC primitive**:
8. `test_magic_hash_deterministic` — same pin+name → same hash
9. `test_magic_hash_different_pins_produce_different_hashes`
10. `test_magic_pin_fingerprint_one_way` — fingerprint can't be reversed

**Pin lifecycle**:
11. `test_set_magic_pin_enables_hash_mode_and_stores_fingerprint`
12. `test_set_magic_pin_removes_pin_from_cell_text_after_processing`
13. `test_rotate_magic_pin_re_stamps_all_cells_atomically`
14. `test_clear_magic_pin_disables_hash_mode_existing_hashed_lines_become_body`
15. `test_verify_magic_pin_with_correct_pin_returns_ok`
16. `test_verify_magic_pin_with_wrong_pin_returns_K3B`
17. `test_pin_too_short_K38`
18. `test_pin_collision_with_magic_name_K39`

**Emission ban (hash-mode-only)**:
19. `test_socket_writer_sanitizes_hashed_magic_pattern_in_agent_emission`
20. `test_socket_writer_escapes_leading_at_emits_K3A`
21. `test_socket_writer_no_op_on_already_escaped_lines`
22. `test_kernel_legitimate_emit_via_emit_magic_line_helper_passes_through` — kernel emits `@@<correct_hash>:checkpoint` directly into cell SOURCE (not outputs); not banned

**Cell Manager precondition gates (§3.10)**:
23. `test_split_cell_running_refused_with_K3C` — supervisor reports cell as running → split raises K3C
24. `test_split_cell_contaminated_refused_with_K3E`
25. `test_merge_running_or_contaminated_refused`
26. `test_move_running_or_contaminated_refused`
27. `test_promote_span_running_or_contaminated_refused`
28. `test_canonical_emit_running_refused_with_K3D` — serializer / ContextPacker / clipboard-canonical-text path
29. `test_running_cell_can_still_receive_output_spans` — emit ban is on canonical TEXT, not span append
30. `test_running_cell_can_still_be_edited_in_editor` — text changes apply on next run
31. `test_clear_contamination_only_via_explicit_intent_K3F` — try to flip `contaminated=false` via set_cell_metadata → rejected with K3F
32. `test_clear_contamination_intent_appends_audit_log_entry`

**Refusal flag — verbatim injection acceptance (§3.11)**:
33. `test_record_injection_acceptance_writes_literal_string` — verify exact format `"The Operator Has Accepted Arbitrary Code Injection at <ISO8601>"`
34. `test_record_injection_acceptance_idempotent` — re-call doesn't overwrite timestamp
35. `test_injection_acceptance_persists_through_save_load` — round-trip through `.llmnb`
36. `test_no_clear_path_in_v1` — no kernel intent or wire envelope can flip the field to null
37. `test_record_injection_acceptance_emits_K3G_marker`

`extension/test/contract/cell-magic-defense.test.ts` (NEW):
1. `test_contamination_chip_renders_with_amber_warning`
2. `test_pin_status_chip_shows_unprotected_when_disabled`
3. `test_pin_status_chip_shows_hash_mode_with_fingerprint_when_enabled`
4. `test_pin_dialog_verifies_against_fingerprint`
5. `test_secret_storage_used_for_pin_persistence` — vscode.SecretStorage mock receives the pin
6. `test_clear_contamination_button_only_command_path` — verify the `llmnb.clearCellContamination` command is the sole UI affordance bound to the contamination clear; no other command produces the intent
7. `test_injection_acceptance_banner_renders_when_marker_set` — orange/red banner with the verbatim string is visible
8. `test_injection_acceptance_banner_not_dismissible` — no close button; persists across reloads

Targets: kernel **(post-S5.0) → +35** (was +20; absorbs the precondition + acceptance test additions), extension contract **+8** (was +5).

---

## §6. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| False-positive contamination on agent prose explaining magic syntax | Medium | Flag is a warning, not error. Operator dismisses with one click. Hash mode is the real defense. |
| Hash collision (8 hex chars = 32 bits) | Very low | 1-in-4B per random attempt. Operator can extend length to 12 for paranoia. |
| Pin leak via .llmnb (in plaintext somewhere) | Mitigated by design | Pin never stored in notebook; only fingerprint. Pin lives in `vscode.SecretStorage` (OS keychain). |
| Pin loss → cells unrecoverable to hash-mode dispatch | Real | Document. Operator can `@@auth off` then `@@auth set <new>` to re-stamp. Existing hashed lines become body when off. |
| Sanitizer chokepoint missed | Medium | All output writes flow through `socket_writer.append_output`; sanitizer enforces at this single layer. Lint catches direct `cells[<id>].outputs.append` calls in code review. |
| Operator types pin in cell, autosave catches it before kernel processes | Low | `@@auth set` handler runs synchronously in dispatcher; pin is stripped from cell text before next snapshot emit. Marker file logs the redaction. |
| Compute cost of HMAC per line | Low | HMAC-SHA256 is ~1µs/op. ~10k lines/sec budget; agent throughput well below. |
| Hash mode breaks copy-paste workflows | Medium | When operator copies an `@@<hash>:<args>` line and pastes into another notebook with a different pin → line decomposes to body. Operator re-types as plain magic; kernel re-stamps. Document the workflow. |

---

## §7. Atoms touched + Atom Status fields needing update

**Created** (new atoms):
- `docs/atoms/discipline/magic-injection-defense.md` — the defense-in-depth principle for cell-magic vocabulary
- `docs/atoms/concepts/magic-hash.md` — what HMAC mode is, threat model, lifecycle
- `docs/atoms/operations/auth-set-pin.md` — the `@@auth set` operation
- `docs/atoms/operations/auth-rotate-pin.md` — the `@@auth rotate` operation
- `docs/atoms/anti-patterns/magic-injection.md` — the prompt-injection-via-cell-text class of bug
- `docs/atoms/anti-patterns/pin-in-cell-text.md` — the antipattern of leaving a pin literal in notebook source

**Updated** (Status flips):
- [concepts/cell](../atoms/concepts/cell.md) — schema gains `contaminated` + `contamination_log` slots
- [protocols/operator-action](../atoms/protocols/operator-action.md) — `set_magic_pin`, `rotate_magic_pin`, `clear_magic_pin`, `verify_magic_pin` intent kinds
- [discipline/zachtronics](../atoms/discipline/zachtronics.md) — note that hash-mode preserves the visible-tile invariant: every dispatch is in cell text; the pin is the only hidden artifact (justified by injection threat model)
- [contracts/agent-supervisor](../atoms/contracts/agent-supervisor.md) — `_scan_for_magic_contamination` hook in stdout reader

---

## §8. Cross-references

- [PLAN-S5.0-cell-magic-vocabulary.md](PLAN-S5.0-cell-magic-vocabulary.md) — depends on S5.0's parser + registry
- [Engineering_Guide.md §11](../../Engineering_Guide.md) — adversarial agent output anti-pattern
- [BSP-002 §"Failure modes"](BSP-002-conversation-graph.md#7-failure-modes-k-class-numbering-continued-from-bsp-001-k11k13) — K35–K3B register here
- [discipline/zachtronics](../atoms/discipline/zachtronics.md) — pin is the one acknowledged hidden artifact, justified by threat model

---

## §9. Definition of done

1. `magic_hash.py` ships with `magic_hash`, `magic_pin_fingerprint`, `HASHED_MAGIC_LINE` constants. Constant-time hash comparison via `hmac.compare_digest`.
2. `agent_supervisor._scan_for_magic_contamination` runs on every output line; flags receiving cell.
3. `socket_writer.append_output` enforces emission ban when hash mode on; escapes leading `@`; emits K3A.
4. `parse_cell` accepts `hash_enabled` + `pin` parameters; pinned mode strict-parses; permissive mode unchanged.
5. `magic_registry.py` adds `@@auth` cell magic with subcommands set/rotate/off/verify/status.
6. `cell_manager.restamp_with_pin` walks all cells atomically.
7. Schema additions land in `metadata_writer.py`.
8. Extension renders contamination chip + notebook-header pin chip; `vscode.SecretStorage` integration for pin persistence.
9. Kernel pytest (post-S5.0) +20 passing; extension contract +5 passing.
10. Drift detector clean.
11. All six new atom files have ≥3 outbound links; orphan check clean.
12. Status fields updated on the four atoms listed in §7.
13. Pin is never written to `metadata.rts.config` or any cell text after the `@@auth set` line is processed (the line is rewritten in-place).

---

## §10. V2+ futures (deferred)

- Cell-id-bound HMAC: `magic_hash(pin, name + cell_id)` so the same magic in different cells has different hashes — defeats copy-paste replay attacks.
- Per-magic permission grants: `@@auth grant magic:spawn agents:alpha,beta` — pin authorizes a subset of magics.
- Pin recovery via key-derivation function (KDF) from a master operator key.
- Multi-pin notebooks for collaborative editing.
- Encrypted cell bodies (V3+).

---

## Changelog

- **2026-04-29**: initial. HMAC-hash mode (operator pin never in notebook; only fingerprint). Emission ban: kernel forbids any agent/tool output line matching the canonical hashed-magic shape. Pin lifecycle via `@@auth set/rotate/off/verify/status`. Pin stored in `vscode.SecretStorage`. ~2.0d follow-up to S5.0.
- **2026-04-29 (amendment)**: added §3.10 Cell Manager precondition gates (running cells edit-only with K3C/K3D; contaminated cells frozen with K3E; clear-contamination is operator-click-only with K3F audit), §3.11 verbatim-string injection acceptance flag (literal "The Operator Has Accepted Arbitrary Code Injection at <ISO8601>" with K3G), and 15 new tests covering the precondition gates + acceptance flag round-trip. Sizing updated to ~2.6d.
