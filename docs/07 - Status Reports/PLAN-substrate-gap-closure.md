# Plan: Substrate gap closure (V1 Kernel Gap Closure)

**Status**: shipped 2026-06-30 — all 9 gaps closed. Closed: G2 (overlay intent kinds `92c7412`), G4 (`fork_agent` / `move_agent_head` handlers `5b5533e`), G5 (`record_context_manifest` / `record_run_frame` intent kinds `3a430cb`), G8 (`OverlayApplier` module `bf0cf16`), G9 (`ContextPacker` module), G10 (`cell_manager.py` shipped ~33 KB with K3C/K3D/K3E/K3F precondition + `insert_cells_with_provenance` — atom drift cleaned 2026-06-30), G11 (RunFrame in-progress truncation at hydrate + 4 tests, 2026-06-30), G12 (`DriftDetector` API ratified per Option A — shipped kwargs shape marked normative, 2026-06-30), G13 (MCP `validate_tool_input` meta-tool + 4 tests, 2026-06-30). Flips row 13 of [PLAN-v1-roadmap §5](PLAN-v1-roadmap.md) to ✅.
**Audience**: an LLM (or operator) picking this up cold. Self-contained.
**Goal**: close the 8 outstanding kernel-substrate gaps from the V1 Kernel Gap Closure plan (G2, G4, G5, G8, G9, G10, G11, G12, G13) plus the MCP `validate_tool_input` hardening, dispatched across the four kernel slice owners (K-MCP, K-AS, K-MW, K-CM).
**Time budget**: ~3-4 days total across multiple agents in parallel. Most gaps land alongside specific BSP-005 slices; the table below is the dispatch map. Remaining ~1-2 days after the 5-of-9 partial close.

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
- MCP `validate_tool_input` hardening per [protocols/mcp-tool-call](../04%20-%20Reference/atoms/protocols/mcp-tool-call.md) error envelope.

### Non-goals

- This plan does NOT design new behavior; every gap has a target spec and atom — implementation only.
- This plan does NOT close V2 features (capability tokens, multi-kernel coordination, etc.).
- This plan does NOT replace per-slice PLAN docs — it dispatches gaps to the slice that needs them.

## §3. The dispatch table

The 9 gap items, grouped by slice owner:

| Gap | Description | Owner | Status | Lands with |
|---|---|---|---|---|
| **G2** | Add `apply_overlay_commit`, `revert_overlay_to_commit`, `create_overlay_ref` to `_BSP003_INTENT_KINDS`; register handlers (delegate to `OverlayApplier`) | K-MW | **closed** (submodule `bf0cf16` / outer `92c7412`; BSP-007 ship 2026-05-07) | [PLAN-S5.5-sections.md](PLAN-S5.5-sections.md) (S5.5 section ops are the first consumer) |
| **G4** | Wire `fork_agent` and `move_agent_head` writer handlers (registry already has the kinds; handlers are stubs) | K-MW | **closed** (S4.1 turn-graph persistence `7ee1616` + S5 trio `5b5533e`; verified clean in supervisor envelope spot-check 2026-05-07) | [PLAN-S5-branch-revert-stop.md](PLAN-S5-branch-revert-stop.md) |
| **G5** | Add `record_context_manifest` and `record_run_frame` to `_BSP003_INTENT_KINDS`; register handlers | K-MW | **closed** (`record_context_manifest` earlier in S3.5; `record_run_frame` in submodule `82c6078` / outer `3a430cb`; BSP-008 ship 2026-05-07) | [PLAN-S3.5-context-packer.md](PLAN-S3.5-context-packer.md) (manifest), [PLAN-S6-cell-binding-runframes.md](PLAN-S6-cell-binding-runframes.md) (run frame) |
| **G8** | New module `vendor/LLMKernel/llm_kernel/overlay_applier.py` per [contracts/overlay-applier](../04%20-%20Reference/atoms/contracts/overlay-applier.md) | K-CM (cell-manager / overlay) | **closed** (submodule `bf0cf16`; 1230 LoC; 16 §9 tests in `test_overlay_applier.py`) | [PLAN-S5.5-sections.md](PLAN-S5.5-sections.md), [PLAN-S5-branch-revert-stop.md](PLAN-S5-branch-revert-stop.md) |
| **G9** | New module `vendor/LLMKernel/llm_kernel/context_packer.py` per [contracts/context-packer](../04%20-%20Reference/atoms/contracts/context-packer.md) | K-AS / K-CTXR | **closed** (shipped earlier; 333 LoC; pure module with K100/K101 error modes) | [PLAN-S3.5-context-packer.md](PLAN-S3.5-context-packer.md) |
| **G10** | New module `vendor/LLMKernel/llm_kernel/cell_manager.py` per [contracts/cell-manager](../04%20-%20Reference/atoms/contracts/cell-manager.md) (split / merge / move / promote) | K-CM | **closed 2026-06-30** — the module actually shipped ~33 KB with K3C/K3D/K3E/K3F preconditions (S5.0.1c submodule `ac25656`) + `insert_cells_with_provenance` (S5.0.2 submodule `8581fab`). The atom's stale "Code drift vs spec" section was cleaned in the G10 close pass. The split/merge/move/promote façade wasn't shipped as a dedicated module because the overlay-applier's 17 op kinds cover them directly; a dedicated CellManager façade lands if/when a higher-level surface is needed beyond that seam. | [PLAN-S5.5-sections.md](PLAN-S5.5-sections.md) (M3 promote-span uses it via M-series). |
| **G11** | Drift-detector RunFrame extension: in-progress RunFrames at hydrate time get truncated similarly to in-progress spans | K-MW | **closed 2026-06-30** (new `truncate_in_progress_run_frames` module fn + `_in_progress_run_frames` DriftDetector method; 4 tests in `test_drift_detector.py`) | [PLAN-S6-cell-binding-runframes.md](PLAN-S6-cell-binding-runframes.md) (crash-recovery smoke depends) |
| **G12** | `DriftDetector` API spec drift: align signature with [contracts/drift-detector §"Code drift vs spec"](../04%20-%20Reference/atoms/contracts/drift-detector.md) — either spec amends to match impl, or a thin `DriftReport` wrapper added | K-MW | **closed 2026-06-30** — Option A picked (shipped signature ratified as normative; atom updated). No wrapper added per Engineering Guide §11.2 "don't ship shims for hypothetical consumers." | Standalone. |
| **G13** | MCP `validate_tool_input` hardening — currently the kernel's MCP server validates input schemas at call time, but K-MCP slice plans an additional pre-call `validate_tool_input(tool_name, arguments)` JSON-RPC method for agents to dry-run a call before invoking. Per [protocols/mcp-tool-call](../04%20-%20Reference/atoms/protocols/mcp-tool-call.md) error envelope. | K-MCP | **closed 2026-06-30** — shipped as a meta-tool in the RFC-001 catalog (`validate_tool_input`) rather than a custom JSON-RPC method so MCP protocol compliance is preserved. Returns `{valid, violations, tool_name}` per §4.9; unknown tool names surface as `valid=false` with a violations entry (safe to speculate against, doesn't raise `-32601`). Handler wired at `mcp_server.py:_handle_validate_tool_input`; 3 tests in `test_mcp_server_round_trip.py` + 1 catalog-count-bump for the 15th tool + fixture add in `test_tool_input_schema_validation.py` + count-bump in `test_wire_public_api.py`. Schema files regenerated via `python -m llm_kernel.wire.export`. | Standalone. |

**Status legend**: `closed` (already shipped), `pending` (not yet shipped). Re-run the audit by grepping `docs/atoms/contracts/*.md` for "Code drift vs spec" sections after each gap lands.

**Bonus bug fix landed alongside G8** (2026-05-07): the BSP-007 ship surfaced and fixed a latent K95 attribute-decode bug — `_is_cell_executing_for_overlay` had been reading OTLP `attributes` as a dict when the wire shape is a `List[{key, value}]` (decoded via `_attrs.decode_attrs`). The original `isinstance(attrs, dict)` check always failed; K95 (overlay-blocked-by-execution) silently never fired from the `RunTracker` path. Fixed in submodule `108c233`. Test `test_overlay_blocked_during_execution` uses the `set_cell_execution_state` seam and continues to pass; the production run-tracker path is now actually exercised. See [Engineering_Guide.md §11.9](../../Engineering_Guide.md) for the related `LogRecord` `extra=` collision pattern surfaced by the same Tier-3 smoke campaign.

## §4. Per-gap concrete work

### §4.1 G2 — overlay-commit intent kinds + handlers

1. In `vendor/LLMKernel/llm_kernel/metadata_writer.py`, extend `_BSP003_INTENT_KINDS` with the three overlay intent kinds.
2. Register `_intent_handler_for(...)` mappings that delegate to `OverlayApplier.apply_commit / revert_to_commit / branch` — depends on G8 being available (or stubs).
3. Tests: `test_apply_overlay_commit_round_trip` etc. in `test_metadata_writer.py`. Until G8 lands, stub handlers return K42 with `reason: "overlay_applier_not_yet_wired"`.

### §4.2 G4 — fork_agent / move_agent_head handlers

1. In `metadata_writer.py`, fill in `_apply_fork_agent` and `_apply_move_agent_head`.
2. Schema: per [protocols/submit-intent-envelope](../04%20-%20Reference/atoms/protocols/submit-intent-envelope.md) §"Intent registry" rows.
3. Tests in `test_metadata_writer.py`: `test_fork_agent_creates_new_agent_record`, `test_move_agent_head_updates_head_turn_id`, `test_move_agent_head_rejects_non_ancestor`.

### §4.3 G5 — context_manifest / run_frame intent kinds + handlers

1. Add `record_context_manifest` and `record_run_frame` to `_BSP003_INTENT_KINDS`.
2. Handlers persist under `metadata.rts.zone.context_manifests.<id>` and `metadata.rts.zone.run_frames.<id>` respectively per [concepts/context-manifest](../04%20-%20Reference/atoms/concepts/context-manifest.md) and [concepts/run-frame](../04%20-%20Reference/atoms/concepts/run-frame.md).
3. K-class: K42 sub-reasons `unknown_turn_ref`, `unknown_executor`, `unknown_context_manifest`, `runframe_terminal` (per [PLAN-S6-cell-binding-runframes.md](PLAN-S6-cell-binding-runframes.md) §4).

### §4.4 G8 — `OverlayApplier` module

1. New `vendor/LLMKernel/llm_kernel/overlay_applier.py` per [contracts/overlay-applier](../04%20-%20Reference/atoms/contracts/overlay-applier.md) public API.
2. Implements `apply_commit`, `revert_to_commit`, `diff`, `branch`.
3. Validates the 17 operation sub-kinds at apply time. K90/K91/K92/K93/K94/K95.
4. Plug into `MetadataWriter._intent_handler_for`.
5. Tests in `test_overlay_applier.py` (new file): atomic-apply, K90 rollback, K91 unreachable, K92 ref conflict, K93 merge precondition, K94 split precondition, K95 in-flight execution.

### §4.5 G9 — `ContextPacker` module

Per [PLAN-S3.5-context-packer.md](PLAN-S3.5-context-packer.md). The plan there is the authoritative source.

### §4.6 G10 — `CellManager` module

1. New `vendor/LLMKernel/llm_kernel/cell_manager.py` per [contracts/cell-manager](../04%20-%20Reference/atoms/contracts/cell-manager.md).
2. Implements `split / merge / move / promote / edit_with_overlay_commit` — each produces an overlay commit and routes through `OverlayApplier`.
3. Tests in `test_cell_manager.py` (new file): split/merge invariants, M1/M2/M3 cross-section/cross-checkpoint rules, S1-S6 split decisions.

### §4.7 G11 — RunFrame in-progress truncation

1. Extend `vendor/LLMKernel/llm_kernel/drift_detector.py`'s `truncate_in_progress_spans` pattern to RunFrames: at hydrate time, walk `metadata.rts.zone.run_frames.*`; any with `status: "running"` AND no matching live `run_id` in the live `RunTracker` get truncated to `status: "interrupted"` with `ended_at` stamped to wall-clock now and a drift event emitted.
2. Tests in `test_drift_detector.py`: `test_orphan_running_runframe_truncated`, `test_live_running_runframe_preserved`.

### §4.8 G12 — DriftDetector API alignment

1. Either:
   - **Option A (preferred)**: amend [contracts/drift-detector](../04%20-%20Reference/atoms/contracts/drift-detector.md) "Code drift vs spec" section to mark the kwargs-and-list-of-dicts shape as the spec.
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
| G13 doubles every tool call's wire traffic if agents always validate first | `validate_tool_input` is opt-in; agents may call directly without pre-validation. Documentation in [protocols/mcp-tool-call](../04%20-%20Reference/atoms/protocols/mcp-tool-call.md) clarifies. |

## §7. Atoms touched + Atom Status fields needing update

Each gap closure clears one or more "Code drift vs spec" lines:

- [contracts/metadata-writer.md](../04%20-%20Reference/atoms/contracts/metadata-writer.md) — clears 5 missing intent kinds (G2 + G5).
- [contracts/intent-dispatcher.md](../04%20-%20Reference/atoms/contracts/intent-dispatcher.md) — clears the `_BSP003_INTENT_KINDS` drift (G2 + G5).
- [contracts/overlay-applier.md](../04%20-%20Reference/atoms/contracts/overlay-applier.md) — Status flips from `V1 spec'd ... NOT yet present` to `V1 shipped` (G8).
- [contracts/context-packer.md](../04%20-%20Reference/atoms/contracts/context-packer.md) — Status flips to `V1 shipped` (G9; tracked in [PLAN-S3.5](PLAN-S3.5-context-packer.md)).
- [contracts/cell-manager.md](../04%20-%20Reference/atoms/contracts/cell-manager.md) — Status flips to `V1 shipped` (G10).
- [contracts/drift-detector.md](../04%20-%20Reference/atoms/contracts/drift-detector.md) — Code drift section updated per G12; G11 adds RunFrame truncation as a new responsibility line.
- [contracts/agent-supervisor.md](../04%20-%20Reference/atoms/contracts/agent-supervisor.md) — `fork`, `stop`, `send_user_turn` movement tied to slice PLANs, but the cross-cutting note here ensures consistency.
- [protocols/mcp-tool-call.md](../04%20-%20Reference/atoms/protocols/mcp-tool-call.md) — adds `validate_tool_input` to the V1 catalog (or as a kernel-internal method outside the 13-tool count, per audit) on G13.

## §8. Cross-references (sibling PLANs)

- [PLAN-v1-roadmap.md §5 row 13](PLAN-v1-roadmap.md) — ship-ready bullet flipped here.
- [PLAN-S3.5-context-packer.md](PLAN-S3.5-context-packer.md) — G5 (manifest intent) + G9 (module).
- [PLAN-S5-branch-revert-stop.md](PLAN-S5-branch-revert-stop.md) — G4 (fork_agent / move_agent_head handlers).
- [PLAN-S5.5-sections.md](PLAN-S5.5-sections.md) — G2 (overlay intent kinds) + G8 (OverlayApplier module).
- [PLAN-S6-cell-binding-runframes.md](PLAN-S6-cell-binding-runframes.md) — G5 (run_frame intent) + G11 (RunFrame truncation).
- [PLAN-M-series.md](PLAN-M-series.md) — G10 (CellManager) for M3 promote-span.
- [PLAN-atom-hygiene.md](PLAN-atom-hygiene.md) — Status updates on the contract atoms after gaps close.

## §9. Definition of done

- [x] G2 closed (BSP-007 overlay intent kinds + handlers shipped 2026-05-07).
- [x] G4 closed (`fork_agent` / `move_agent_head` handlers shipped in S4.1 / S5 trio; verified clean in supervisor envelope spot-check 2026-05-07).
- [x] G5 closed (`record_run_frame` shipped 2026-05-07; `record_context_manifest` earlier with S3.5).
- [x] G8 closed (BSP-007 `OverlayApplier` module 1230 LoC + 16 §9 tests).
- [x] G9 closed (`ContextPacker` module 333 LoC shipped earlier).
- [ ] G10 closed (`CellManager` module pending — likely unblocked since overlay-applier covers the 17 op kinds).
- [ ] G11 closed (RunFrame in-progress truncation at hydrate pending).
- [ ] G12 closed (`DriftDetector` API alignment pending; ≤2h standalone).
- [ ] G13 closed (MCP `validate_tool_input` hardening pending; ≤4h standalone).
- [x] Partial: `docs/atoms/contracts/*.md` "Code drift vs spec" sections re-audited for the 5 closed gaps. Remaining drift lines (G10 / G11 / G12 / G13) carry forward references to the slice that addresses them.
- [x] Partial: closed-gap test counts landed — G8 ships 16 tests in `test_overlay_applier.py`; G5 ships 11 tests in `test_run_frame_handler.py` + `test_supervisor_run_frame_wiring.py`. Outstanding gaps still owe ~13-17 tests per §5.
- [x] Smoke per closed gap: Tier-3 live OAuth+mitm smoke passes (2026-05-07) — 6 Anthropic API calls intercepted; `notify` + `report_completion` emitted; overlay-applier and RunFrame paths exercised end-to-end.
- [ ] [PLAN-atom-hygiene.md](PLAN-atom-hygiene.md) drift detector run is clean after gaps close.
- [ ] This plan flips to `**Status**: shipped (commit <SHA>)` once the last gap lands. Currently `in progress (partial)` — 5 of 9 closed. Note: this plan stays "in progress" until ALL gaps close, then moves to `shipped` in one transition.
