# Discipline: Magic injection defense

**Status**: V1 shipped (PLAN-S5.0.1a/b/c; submodule pins `360b658` foundation, `94d1c39` parser+auth, `dbad5ee` injection-acceptance, `ac25656` precondition gates; outer pin `5aee2dc`; submodule HEAD `264b69c`)
**Source specs**: [PLAN-S5.0.1 §1–§3.4, §3.10, §3.11](../../notebook/PLAN-S5.0.1-cell-magic-injection-defense.md), [PLAN-S5.0 §3](../../notebook/PLAN-S5.0-cell-magic-vocabulary.md) (the vocabulary defended)
**Related atoms**: [discipline/certified-magic-emitter](certified-magic-emitter.md) (the structural dual), [discipline/text-as-canonical](text-as-canonical.md), [discipline/zachtronics](zachtronics.md), [discipline/cell-manager-owns-structure](cell-manager-owns-structure.md), [concepts/magic](../concepts/magic.md), [concepts/magic-code-generator](../concepts/magic-code-generator.md), [operations/parse-cell](../operations/parse-cell.md)

## The discipline

**Agent-stream emissions never produce dispatchable magic syntax. Hashes never reach an agent's eyes.**

The cell-magic vocabulary ([magic](../concepts/magic.md)) is the operator's typing surface. By default the parser dispatches any column-0 `@@<known>` line — making cell text a privileged execution path. Without defense, an agent that emits `@@spawn evil_agent` in its stdout (accidentally tutoring, or adversarially under prompt injection) plus a credulous operator copy-paste produces a forged dispatch. S5.0.1 closes the loop with three layered defenses, each implemented at a single grep-able chokepoint and verified by a constant-time HMAC primitive the attacker cannot forge from the canonical text alone.

## What this discipline forbids (the emission ban)

**No agent-touching output channel may produce a line that LOOKS LIKE dispatchable magic.**

| Channel | Always-on (Layer 1) | Hash mode (Layer 2) |
|---|---|---|
| Agent stdout / stderr | Plain `@@<known>` / `@<known>` flags `cells[<id>].contaminated = True`, appends to `contamination_log` | Lines matching `^@@?[a-f0-9]+:\w+\b` ALSO flag contamination AND signal `ESCAPE_REQUIRED` |
| Tool result text | Same path (flows through the same `_scan_for_magic_contamination` hook) | Same |
| Kernel-emitted synthetic spans (notify / escalate / status) | Sanitizer at the wire boundary catches before transmission | Same |

The Layer-2 escape transformation prepends `\` to the leading `@`: `@@deadbeef:spawn` → `\@@deadbeef:spawn`. The escaped form is body, never dispatchable — even with the correct pin, because the parser only matches `@@` at column zero with no backslash. Verified at `vendor/LLMKernel/llm_kernel/magic_hash.py:253-272` (`escape_leading_at`, idempotent on already-escaped lines).

The Layer-1 detector lives at `vendor/LLMKernel/llm_kernel/agent_supervisor.py:2171-2273` (`_scan_for_magic_contamination`); the Layer-2 wire-boundary sanitizer at `vendor/LLMKernel/llm_kernel/socket_writer.py:220-249` (`SocketWriter.write_frame` invokes `sanitize_outbound_record` and emits a K36 callback when it rewrote a frame). Pattern definitions: `magic_hash.py:75-85` (`HASHED_MAGIC_LINE` and `PLAIN_MAGIC_LINE`).

## Bidirectional hash strip (every agent-visible boundary)

Hashes only ever exist in canonical cell-source storage. The kernel strips them at every other surface so agents never observe — and therefore can never replay — them.

| Boundary | Direction | What happens |
|---|---|---|
| `parse_cell` (cell-source → in-memory state) | inbound | `validate_hashed_magic` (`magic_hash.py:165-198`) HMAC-validates with constant-time `hmac.compare_digest`; in-memory `ParsedCell` holds the recovered NAME, never the hash |
| Serializer (in-memory → cell-source) | outbound | `cell_manager.restamp_text` recomputes `magic_hash(pin, name)` and writes the canonical hashed form |
| ContextPacker / handoff stdin / `--resume` replay | agent-visible | `strip_hashes_from_text` (`magic_hash.py:229-250`) reduces every `@@<hash>:<name>` to plain `@@<name>` before the bytes reach the agent |
| Cell-output rendering (agent stdout → cell outputs) | agent-visible | the emission-ban sanitizer escapes any hash-shaped line; synthetic kernel output is constructed without hashes |
| Operator display (cell editor) | operator-visible | configurable per the extension's pin-status header chip; default is stripped form with a 🔒 indicator that hash mode is active |

Storage stays canonical (hashed). Strip happens only at egress to agent-visible surfaces. Operator-visible surfaces are configurable because the operator owns the typing layer and may want to inspect canonical bytes for git-diff review.

## Why this works (threat model)

- The pin is never written to the notebook. Storage holds only `metadata.rts.config.magic_pin_fingerprint` — a salted SHA-256 fingerprint (`magic_hash.py:116-126`) usable for round-trip pin verification but not pin recovery. The pin lives in `os.environ[LLMNB_OPERATOR_PIN]` (kernel) and `vscode.SecretStorage` (extension).
- An agent that ingests notebook source therefore cannot compute valid HMACs for arbitrary magic names — it has the names but not the key.
- The emission ban catches the remaining attack surface: lines that already carry a valid hash (e.g., a malicious upstream tool result that quotes one). Any such line is escaped before it reaches a parser.

The hash length default is 8 hex chars (32 bits → 1-in-4B per random forgery attempt) per `magic_hash.py:88-113`. Operators wanting paranoid mode can set `length:12`.

## The legitimate exception

Magic code generators ([magic-code-generator](../concepts/magic-code-generator.md)) are the SOLE legitimate path that produces hashed-magic syntax. They are operator-designated (the generator-magic cell is operator-typed and visible per [zachtronics](zachtronics.md)) and run in operator privilege — granted access to the pin so their emitted lines auto-include valid HMACs. Their emissions write through Cell Manager structurally (clause 2 of [certified-magic-emitter](certified-magic-emitter.md)) — NOT through the agent-stream output sanitizer that the emission ban inspects. Generator-handler outputs never pass through `socket_writer.write_frame`'s scan; they land via `CellManager.insert_cells_with_provenance` directly.

## Cell Manager precondition gates (the structural defense layer)

Two structural-op invariants enforced at `vendor/LLMKernel/llm_kernel/cell_manager.py:417-449` (`_check_structural_op_preconditions`):

| Op on this cell | Allowed? | Refusal code |
|---|---|---|
| Edit cell text in editor | yes | — (K3F info-marker on running cells) |
| Receive output spans (runtime continues) | yes | — |
| Split / merge / delete / move | no when running | K3C |
| Set kind | no when running | K3D |
| Any structural op | no when contaminated | K3E |

The contamination flag is cleared **only** by the explicit `reset_contamination` operator-action (`cell_manager.py:506-` is the unblock path; refuses K3C if the cell is currently running, but does NOT refuse K3E because clearing K3E is exactly its purpose).

## Verbatim acceptance trapdoor (§3.11)

Operators who decline hash mode opt INTO an embarrassing trapdoor. The kernel writes the literal string

> `"The Operator Has Accepted Arbitrary Code Injection at <ISO8601>"`

to `metadata.rts.config.injection_acceptance` via `MetadataWriter.accept_injection_risk` (verified at `vendor/LLMKernel/tests/test_injection_acceptance.py:29-45`). Properties:

- **Verbatim format**: validator rejects arbitrary text; only the canonical phrase is acceptable.
- **Idempotent**: re-calling preserves the original timestamp (`test_injection_acceptance.py:60-73`).
- **Permanent in V1**: no clear path; the marker survives `.llmnb` round-trip.
- **Always-visible banner**: extension renders an undismissable orange/red banner.
- **K3G fires once**: on first acceptance; subsequent calls are no-ops and do NOT re-emit.

The wording is deliberately uncomfortable. Operators must explicitly click through a confirmation modal that quotes the string; searchable across a notebook corpus.

## K-class errors

All seven registered in `vendor/LLMKernel/llm_kernel/wire/tools.py` `K_CLASS_REGISTRY`:

| Code | Name | Fires |
|---|---|---|
| K35 | `plain_magic_in_hash_mode` | `cell_text.parse_cell` sees `@@<known>` plain when hash mode is on (`tools.py:523-534`) |
| K36 | `hashed_magic_emission_blocked` | sanitizer rewrote a line; cell flagged contaminated (`tools.py:535-552`) |
| K3C | `running_cell_structural_op_blocked` | split/merge/delete/move on a running cell (`tools.py:559-571`) |
| K3D | `running_cell_kind_change_blocked` | `set_cell_kind` on a running cell — distinct from K3C for analytics (`tools.py:572-582`) |
| K3E | `contaminated_cell_structural_op_blocked` | structural op or text edit on `contaminated == true` (`tools.py:583-592`) |
| K3F | `running_cell_edit_text_only_path` | info-only: text edit during run is the explicitly-allowed path (`tools.py:593-603`) |
| K3G | `operator_accepted_injection_persisted` | one-shot on first `accept_injection_risk` call (`tools.py:604-616`) |

## Anti-shapes ruled out

| Anti-shape | Why forbidden |
|---|---|
| Agent emits `@@<hash>:<name>` via stdout | Sanitizer escapes leading `@`; K36; cell flagged contaminated |
| Agent observes `@@<hash>:<name>` in its context | `strip_hashes_from_text` reduces to `@@<name>` at every agent-visible boundary |
| Operator types `@@spawn alpha` plain in hash mode | Parser treats as body; K35 logged so the operator surface can warn |
| Splitting / merging a running cell | K3C |
| Editing kind on a running cell | K3D |
| Resetting contamination via `set_cell_metadata` rather than the explicit operator-click | K3E (text edits on contaminated cells refuse); only `reset_contamination(cell_id)` clears the flag |
| Storing the pin in `metadata.rts.config` | Forbidden by design; only the salted fingerprint is stored |

## See also

- [discipline/certified-magic-emitter](certified-magic-emitter.md) — the structural dual: which paths are allowed to PRODUCE magic syntax (this atom names the paths that aren't)
- [concepts/magic-code-generator](../concepts/magic-code-generator.md) — the legitimate exception to the emission ban (operator-rooted, structural-write-surface)
- [discipline/text-as-canonical](text-as-canonical.md) — the foundation; cell text is the only privileged dispatch source, which is exactly why it must be defended
- [discipline/zachtronics](zachtronics.md) — visible-tile principle; the pin is the single acknowledged hidden artifact, justified by the threat model here
- [concepts/magic](../concepts/magic.md) — the vocabulary defended
- [discipline/cell-manager-owns-structure](cell-manager-owns-structure.md) — clause 2 of certified emission; the structural-write surface generators use
- [operations/parse-cell](../operations/parse-cell.md) — the privileged dispatch path that motivates the entire defense
- [PLAN-S5.0.1](../../notebook/PLAN-S5.0.1-cell-magic-injection-defense.md) — full specification (§3.1 HMAC primitive, §3.2 contamination detector, §3.3 sanitizer, §3.4 strip, §3.10 precondition gates, §3.11 verbatim acceptance)
