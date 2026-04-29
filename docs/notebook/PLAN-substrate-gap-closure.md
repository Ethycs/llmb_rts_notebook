# Plan: Substrate gap closure (V1 Kernel Gap Closure)

**Status**: ready
**Audience**: an LLM (or operator) picking this up cold. Self-contained.
**Goal**: close the 8 outstanding kernel-substrate gaps from the V1 Kernel Gap Closure plan (G2, G4, G5, G8, G9, G10, G11, G12, G13) plus the MCP `validate_tool_input` hardening, dispatched across the four kernel slice owners (K-MCP, K-AS, K-MW, K-CM).
**Time budget**: ~3-4 days total across multiple agents in parallel. Most gaps land alongside specific BSP-005 slices; the table below is the dispatch map.

---

## §1. Why this work exists

The atom corpus (`docs/atoms/`) describes a kernel substrate richer than the implementation today. Multiple `contracts/*.md` carry "Code drift vs spec" sections explicitly listing missing modules and missing intent kinds. BSP-005 slices reference these gaps as preconditions, but the cleanup work itself is small enough that a per-gap PLAN is overkill. This document inventories all 8 gaps in one place so the operator can dispatch them as kernel-only work alongside the UX slices.

**Source of the gap list**: the V1 Kernel Gap Closure planning thread (BSP-003 §5 amendment, BSP-007 §11 implementation slice, BSP-008 §12 implementation slice, RFC-001 hardening notes) and the "Code drift vs spec" sections of `docs/atoms/contracts/*.md`.

The 8 gap codes (G2, G4, G5, G8, G9, G10, G11, G12, G13) are the original numbering from that plan; G1, G3, G6, G7 already closed in earlier commits.

## §2. Goals and non-goals

### Goals

- Every "Code drift vs spec" line in `docs/atoms/contracts/` either disappears (gap closed) or gets a forward-pointing reference to a future slice.
- All 5 missing intent kinds (`apply_overlay_commit`, `revert_overlay_to_commit`, `create_overlay_ref`, `record_context_manifest`, `record_run_frame`) land in `_BSP003_INTENT_KINDS`.
- The 3 missing modules (`OverlayApplier`, `ContextPacker`, `CellManager`) land at the listed paths.
- MCP `validate_tool_input` hardening per [protocols/mcp-tool-call](../atoms/protocols/mcp-tool-call.md) error envelope.

### Non-goals

- This plan does NOT design new behavior; every gap has a target spec and atom — implementation only.
- This plan does NOT close V2 features (capability tokens, multi-kernel coordination, etc.).
- This plan does NOT replace per-slice PLAN docs — it dispatches gaps to the slice that needs them.

## §3. The dispatch table

The 9 gap items, grouped by slice owner:

| Gap | Description | Owner | Status | Lands with |
|---|---|---|---|---|
| **G2** | Add `apply_overlay_commit`, `revert_overlay_to_commit`, `create_overlay_ref` to `_BSP003_INTENT_KINDS`; register handlers (delegate to `OverlayApplier`) | K-MW | **pending** | [PLAN-S5.5-sections.md](PLAN-S5.5-sections.md) (S5.5 section ops are the first consumer) |
| **G4** | Wire `fork_agent` and `move_agent_head` writer handlers (registry already has the kinds; handlers are stubs) | K-MW | **pending** | [PLAN-S5-branch-revert-stop.md](PLAN-S5-branch-revert-stop.md) |
| **G5** | Add `record_context_manifest` and `record_run_frame` to `_BSP003_INTENT_KINDS`; register handlers | K-MW | **pending** | [PLAN-S3.5-context-packer.md](PLAN-S3.5-context-packer.md) (manifest), [PLAN-S6-cell-binding-runframes.md](PLAN-S6-cell-binding-runframes.md) (run frame) |
| **G8** | New module `vendor/LLMKernel/llm_kernel/overlay_applier.py` per [contracts/overlay-applier](../atoms/contracts/overlay-applier.md) | K-CM (cell-manager / overlay) | **pending** | [PLAN-S5.5-sections.md](PLAN-S5.5-sections.md), [PLAN-S5-branch-revert-stop.md](PLAN-S5-branch-revert-stop.md) |
| **G9** | New module `vendor/LLMKernel/llm_kernel/context_packer.py` per [contracts/context-packer](../atoms/contracts/context-packer.md) | K-AS / K-CTXR | **pending** | [PLAN-S3.5-context-packer.md](PLAN-S3.5-context-packer.md) |
| **G10** | New module `vendor/LLMKernel/llm_kernel/cell_manager.py` per [contracts/cell-manager](../atoms/contracts/cell-manager.md) (split / merge / move / promote) | K-CM | **pending** | [PLAN-S5.5-sections.md](PLAN-S5.5-sections.md) (M3 promote-span uses it via M-series) |
| **G11** | Drift-detector RunFrame extension: in-progress RunFrames at hydrate time get truncated similarly to in-progress spans | K-MW | **pending** | [PLAN-S6-cell-binding-runframes.md](PLAN-S6-cell-binding-runframes.md) (crash-recovery smoke depends) |
| **G12** | `DriftDetector` API spec drift: align signature with [contracts/drift-detector §"Code drift vs spec"](../atoms/contracts/drift-detector.md) — either spec amends to match impl, or a thin `DriftReport` wrapper added | K-MW | **pending** | Standalone; ≤2h. Lands first because it touches no other slice. |
| **G13** | MCP `validate_tool_input` hardening — currently the kernel's MCP server validates input schemas at call time, but K-MCP slice plans an additional pre-call `validate_tool_input(tool_name, arguments)` JSON-RPC method for agents to dry-run a call before invoking. Per [protocols/mcp-tool-call](../atoms/protocols/mcp-tool-call.md) error envelope. | K-MCP | **pending** | Standalone; ≤4h. Could land first or with the K-MCP slice. |

**Status legend**: `closed` (already shipped — none in this list), `pending` (not yet shipped). Re-run the audit by grepping `docs/atoms/contracts/*.md` for "Code drift vs spec" sections after each gap lands.

## §4. Per-gap concrete work

### §4.1 G2 — overlay-commit intent kinds + handlers

1. In `vendor/LLMKernel/llm_kernel/metadata_writer.py`, extend `_BSP003_INTENT_KINDS` with the three overlay intent kinds.
2. Register `_intent_handler_for(...)` mappings that delegate to `OverlayApplier.apply_commit / revert_to_commit / branch` — depends on G8 being available (or stubs).
3. Tests: `test_apply_overlay_commit_round_trip` etc. in `test_metadata_writer.py`. Until G8 lands, stub handlers return K42 with `reason: "overlay_applier_not_yet_wired"`.

### §4.2 G4 — fork_agent / move_agent_head handlers

1. In `metadata_writer.py`, fill in `_apply_fork_agent` and `_apply_move_agent_head`.
2. Schema: per [protocols/submit-intent-envelope](../atoms/protocols/submit-intent-envelope.md) §"Intent registry" rows.
3. Tests in `test_metadata_writer.py`: `test_fork_agent_creates_new_agent_record`, `test_move_agent_head_updates_head_turn_id`, `test_move_agent_head_rejects_non_ancestor`.

### §4.3 G5 — context_manifest / run_frame intent kinds + handlers

1. Add `record_context_manifest` and `record_run_frame` to `_BSP003_INTENT_KINDS`.
2. Handlers persist under `metadata.rts.zone.context_manifests.<id>` and `metadata.rts.zone.run_frames.<id>` respectively per [concepts/context-manifest](../atoms/concepts/context-manifest.md) and [concepts/run-frame](../atoms/concepts/run-frame.md).
3. K-class: K42 sub-reasons `unknown_turn_ref`, `unknown_executor`, `unknown_context_manifest`, `runframe_terminal` (per [PLAN-S6-cell-binding-runframes.md](PLAN-S6-cell-binding-runframes.md) §4).

### §4.4 G8 — `OverlayApplier` module

1. New `vendor/LLMKernel/llm_kernel/overlay_applier.py` per [contracts/overlay-applier](../atoms/contracts/overlay-applier.md) public API.
2. Implements `apply_commit`, `revert_to_commit`, `diff`, `branch`.
3. Validates the 17 operation sub-kinds at apply time. K90/K91/K92/K93/K94/K95.
4. Plug into `MetadataWriter._intent_handler_for`.
5. Tests in `test_overlay_applier.py` (new file): atomic-apply, K90 rollback, K91 unreachable, K92 ref conflict, K93 merge precondition, K94 split precondition, K95 in-flight execution.

### §4.5 G9 — `ContextPacker` module

Per [PLAN-S3.5-context-packer.md](PLAN-S3.5-context-packer.md). The plan there is the authoritative source.

### §4.6 G10 — `CellManager` module

1. New `vendor/LLMKernel/llm_kernel/cell_manager.py` per [contracts/cell-manager](../atoms/contracts/cell-manager.md).
2. Implements `split / merge / move / promote / edit_with_overlay_commit` — each produces an overlay commit and routes through `OverlayApplier`.
3. Tests in `test_cell_manager.py` (new file): split/merge invariants, M1/M2/M3 cross-section/cross-checkpoint rules, S1-S6 split decisions.

### §4.7 G11 — RunFrame in-progress truncation

1. Extend `vendor/LLMKernel/llm_kernel/drift_detector.py`'s `truncate_in_progress_spans` pattern to RunFrames: at hydrate time, walk `metadata.rts.zone.run_frames.*`; any with `status: "running"` AND no matching live `run_id` in the live `RunTracker` get truncated to `status: "interrupted"` with `ended_at` stamped to wall-clock now and a drift event emitted.
2. Tests in `test_drift_detector.py`: `test_orphan_running_runframe_truncated`, `test_live_running_runframe_preserved`.

### §4.8 G12 — DriftDetector API alignment

1. Either:
   - **Option A (preferred)**: amend [contracts/drift-detector](../atoms/contracts/drift-detector.md) "Code drift vs spec" section to mark the kwargs-and-list-of-dicts shape as the spec.
   - **Option B**: add a thin `DriftReport` wrapper class in `drift_detector.py` matching the original spec.
2. Pick A unless an external consumer (e.g., extension code reading `DriftReport.severities`) needs the wrapper. Per [Engineering_Guide.md §11.2](../../Engineering_Guide.md), don't ship shims for hypothetical consumers.

### §4.9 G13 — MCP `validate_tool_input`

1. Add a JSON-RPC method `validate_tool_input(tool_name, arguments)` to the kernel's MCP server. Returns `{ valid: bool, violations: [...] }` without invoking the tool.
2. Schema validation reuses the existing per-tool schema from RFC-001.
3. Tests in `test_mcp_server_round_trip.py`: `test_validate_tool_input_returns_valid`, `test_validate_tool_input_returns_violations_for_bad_payload`, `test_validate_tool_input_unknown_tool_returns_method_not_found`.

## §5. Test surface

Total expected new tests across the gap closures: ~28-32. Most ride alongside the BSP-005 slice that consumes the gap; a handful (G12, G13) are standalone:

- G2: 3 tests in `test_metadata_writer.py`.
- G4: 3 tests in `test_metadata_writer.py`.
- G5: 4 tests in `test_metadata_writer.py`.
- G8: 7 tests in `test_overlay_applier.py` (new file).
- G9: see [PLAN-S3.5-context-packer.md §5](PLAN-S3.5-context-packer.md).
- G10: 6 tests in `test_cell_manager.py` (new file).
- G11: 2 tests in `test_drift_detector.py`.
- G12: 0 tests (Option A) or 2 tests (Option B).
- G13: 3 tests in `test_mcp_server_round_trip.py`.

## §6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| G8 / G10 land before their consumer slices, leaving dead code | Keep them gated by the registry-extension order; the G2 / G4 / G5 intent registrations are what lights up the modules. Tests in the new modules use mock writers. |
| G2 stub handlers (returning K42) leak into a snapshot before G8 lands | The stubs explicitly return failure with no state mutation; safe by design. |
| G11 in-progress RunFrame heuristic misclassifies a slow-running real run as orphan | The classifier uses presence in the live `RunTracker` as the "live" signal, not a timeout. Crashes leave a process+RunTracker without the matching in-memory entry; live runs are still tracked. |
| G12 spec amendment surprises a downstream consumer | Audit consumer code before flipping; the only consumer today is `custom_messages.py`'s hydrate handler, which already uses the kwargs shape. |
| G13 doubles every tool call's wire traffic if agents always validate first | `validate_tool_input` is opt-in; agents may call directly without pre-validation. Documentation in [protocols/mcp-tool-call](../atoms/protocols/mcp-tool-call.md) clarifies. |

## §7. Atoms touched + Atom Status fields needing update

Each gap closure clears one or more "Code drift vs spec" lines:

- [contracts/metadata-writer.md](../atoms/contracts/metadata-writer.md) — clears 5 missing intent kinds (G2 + G5).
- [contracts/intent-dispatcher.md](../atoms/contracts/intent-dispatcher.md) — clears the `_BSP003_INTENT_KINDS` drift (G2 + G5).
- [contracts/overlay-applier.md](../atoms/contracts/overlay-applier.md) — Status flips from `V1 spec'd ... NOT yet present` to `V1 shipped` (G8).
- [contracts/context-packer.md](../atoms/contracts/context-packer.md) — Status flips to `V1 shipped` (G9; tracked in [PLAN-S3.5](PLAN-S3.5-context-packer.md)).
- [contracts/cell-manager.md](../atoms/contracts/cell-manager.md) — Status flips to `V1 shipped` (G10).
- [contracts/drift-detector.md](../atoms/contracts/drift-detector.md) — Code drift section updated per G12; G11 adds RunFrame truncation as a new responsibility line.
- [contracts/agent-supervisor.md](../atoms/contracts/agent-supervisor.md) — `fork`, `stop`, `send_user_turn` movement tied to slice PLANs, but the cross-cutting note here ensures consistency.
- [protocols/mcp-tool-call.md](../atoms/protocols/mcp-tool-call.md) — adds `validate_tool_input` to the V1 catalog (or as a kernel-internal method outside the 13-tool count, per audit) on G13.

## §8. Cross-references (sibling PLANs)

- [PLAN-v1-roadmap.md §5 row 13](PLAN-v1-roadmap.md) — ship-ready bullet flipped here.
- [PLAN-S3.5-context-packer.md](PLAN-S3.5-context-packer.md) — G5 (manifest intent) + G9 (module).
- [PLAN-S5-branch-revert-stop.md](PLAN-S5-branch-revert-stop.md) — G4 (fork_agent / move_agent_head handlers).
- [PLAN-S5.5-sections.md](PLAN-S5.5-sections.md) — G2 (overlay intent kinds) + G8 (OverlayApplier module).
- [PLAN-S6-cell-binding-runframes.md](PLAN-S6-cell-binding-runframes.md) — G5 (run_frame intent) + G11 (RunFrame truncation).
- [PLAN-M-series.md](PLAN-M-series.md) — G10 (CellManager) for M3 promote-span.
- [PLAN-atom-hygiene.md](PLAN-atom-hygiene.md) — Status updates on the contract atoms after gaps close.

## §9. Definition of done

- [ ] All 9 gap rows in §3 flipped to `closed`.
- [ ] `docs/atoms/contracts/*.md` "Code drift vs spec" sections re-audited; each remaining drift line carries a forward reference to the slice that addresses it.
- [ ] Total new test count across all gaps lands as listed in §5.
- [ ] Smoke per gap (the slice-level round-trips in the consuming PLAN docs serve as integration coverage).
- [ ] [PLAN-atom-hygiene.md](PLAN-atom-hygiene.md) drift detector run is clean after gaps close.
- [ ] This plan flips to `**Status**: shipped (commit <SHA>)` once the last gap lands. Note: this plan stays "ready" until ALL gaps close, then moves in one transition.
