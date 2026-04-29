# Plan: S6 — Cell-to-turn binding write-back + RunFrame minimal

**Status**: ready
**Audience**: an LLM (or operator) picking this up cold. Self-contained.
**Goal**: persist the cell→turn binding through `MetadataWriter.submit_intent("append_turn", ...)` and `set_cell_metadata`, write `metadata.rts.zone.run_frames.<run_id>` per [decisions/v1-runframe-minimal](../atoms/decisions/v1-runframe-minimal.md), and re-render cells from persisted state at file-open. After this slice, closing and reopening a notebook restores the conversation including who ran what, when, and which spans were emitted.
**Time budget**: 2 days. Cross-layer (kernel + extension). Two-agent parallelizable (K-MW-S6 + X-EXT-S6).

---

## §1. Why this work exists

After S2-S5.5, the notebook's runtime state is rich but transient. Without S6:
- Closing and reopening a notebook loses the cell→turn binding; the operator sees raw OTLP JSON re-emitted instead of "the cell ran, here is the agent's response."
- Inspect mode has no per-cell-run records; the question "what context did the agent see?" has no answer.
- Inspect mode cannot show "what changed in the turn DAG?" because no run boundaries are recorded.

Driver: BSP-002 §3 / §6 / writer registry; KB-target §0.5. Slice spec: [BSP-005 §"S6"](BSP-005-cell-roadmap.md), expanded per [BSP-005 §6.4](BSP-005-cell-roadmap.md#64-s6-expanded--runframe-minimal--inspect-mode).

Hard dependencies:
- S2-S5.5 shipped (real turn data and section membership exist).
- [PLAN-S3.5-context-packer.md](PLAN-S3.5-context-packer.md) shipped (RunFrames carry `context_manifest_id`).
- Substrate gap G5 (`record_run_frame` intent kind) closes here or before; see [PLAN-substrate-gap-closure.md](PLAN-substrate-gap-closure.md).

## §2. Goals and non-goals

### Goals

- Every emitted turn produces an `append_turn` intent — already wired in [PLAN-S5-branch-revert-stop.md](PLAN-S5-branch-revert-stop.md) §3 step 1; verify it's complete here.
- Operator-side cell edits (typo fixes before re-running) submit `set_cell_metadata` so the writer records the cell→turn binding.
- The metadata-loader at file-open re-renders cells from `metadata.rts.zone.agents[*].turns[]` rather than waiting for re-execution.
- RunFrames are written to `metadata.rts.zone.run_frames.<run_id>` per [concepts/run-frame §"Schema (V1 minimal)"](../atoms/concepts/run-frame.md):
  - `run_id`, `cell_id`, `executor_id`, `turn_head_before`, `turn_head_after`, `context_manifest_id`, `status`, `started_at`, `ended_at`.
  - The deferred V2 fields (`parent_run_id`, `source_snapshot_id`, `overlay_commit_id`, `artifact_windows[]`, full `tool_permissions`) are NOT emitted.
- Inspect mode reads the RunFrame + manifest pair to render the per-run "what the agent saw" view (read path; no write).

### Non-goals

- The deferred V2 RunFrame fields stay deferred (per [decisions/v1-runframe-minimal](../atoms/decisions/v1-runframe-minimal.md)).
- Render-time HTML cache for cells (`metadata.rts.cells[<id>].metadata.rts.cell.cached_render`) per [BSP-005 §4.1](BSP-005-cell-roadmap.md#41-render-time-heaviness-as-cells-accumulate-turns) — that's a follow-up if performance bites.
- This slice does NOT modify ContextPacker (S3.5 already shipped).
- This slice does NOT change the rendering of streamed agent responses; only the persisted-state path.

## §3. Concrete work

1. **Verify `append_turn` discipline.** Walk the kernel response handler for agent turns and confirm every terminal turn submits `append_turn`. Add a regression test if any path bypasses the writer.

2. **Cell edit binding.** When the operator manually edits a cell's directive text (parses to a `cell_edit` action_type per [protocols/operator-action](../atoms/protocols/operator-action.md)), the extension submits `set_cell_metadata` with the new directive (`metadata.rts.cells[<id>].directive_text`). Currently the extension only updates the cell's body; the binding must also persist.

3. **RunFrame write path.** In `vendor/LLMKernel/llm_kernel/agent_supervisor.py`:
   - At run start (immediately after the supervisor commits the manifest from S3.5), submit `record_run_frame` with `started_at`, `cell_id`, `executor_id`, `turn_head_before`, `context_manifest_id`, and `status: "running"` placeholder. Mint `run_id` as a fresh ULID.
   - At run terminal (success / failure / interrupt), submit a second `record_run_frame` with the SAME `run_id`, plus `turn_head_after`, terminal `status`, and `ended_at`. The intent handler is idempotent on `run_id` (per [decisions/v1-runframe-minimal](../atoms/decisions/v1-runframe-minimal.md) "Operational consequences"): the second call overwrites the in-flight placeholder.
   - Status enum: `complete | failed | interrupted` only. Reject other values per [contracts/intent-dispatcher §"K-class error modes"](../atoms/contracts/intent-dispatcher.md).

4. **`record_run_frame` intent kind.** Add to `_BSP003_INTENT_KINDS`. Handler validates schema, persists under `metadata.rts.zone.run_frames.<run_id>`, K42 sub-reason `unknown_executor` if `executor_id` is not a registered agent, K42 sub-reason `unknown_context_manifest` if `context_manifest_id` is missing.

5. **Hydrate path re-render.** In `MetadataWriter.hydrate(snapshot)`, after loading `agents[*].turns[]`, the extension's metadata-applier walks each cell's `bound_agent_id` and re-renders the turn body per [agent atom §"Cell-as-agent-identity"](../atoms/concepts/agent.md). Implementation: extension subscribes to the post-hydrate Family F snapshot and rebuilds cell outputs from `turns[].body` and `turns[].spans[]`. No re-execution.

6. **Inspect-mode read path.** Add a new VS Code command `llmnb.inspect.run` that takes a `run_id`, resolves the RunFrame, fetches the linked manifest, and opens a virtual document showing:
   - The cell, the agent, `started_at`/`ended_at`.
   - The manifest's `inclusion_rules_applied[]` and `exclusions_applied[]`.
   - The diff between `turn_head_before` and `turn_head_after` (one or more turn rows).

7. **Section auto-transition tie-in.** Per [PLAN-S5.5-sections.md §3 step 3](PLAN-S5.5-sections.md), when a RunFrame's `started_at` fires, increment the in-progress run count for the cell's section; on terminal status, decrement. The supervisor owns this counter.

## §4. Interface contracts

`record_run_frame` parameter shape:

```jsonc
{
  "intent_kind": "record_run_frame",
  "parameters": {
    "run_frame": {
      "run_id":              "01HZX7K3...",
      "cell_id":             "vscode-notebook-cell:.../#abc",
      "executor_id":         "alpha",
      "turn_head_before":    "t_..." | null,
      "turn_head_after":     "t_..." | null,
      "context_manifest_id": "01HZX7K2...",
      "status":              "running" | "complete" | "failed" | "interrupted",
      "started_at":          "2026-04-29T14:00:00Z",
      "ended_at":            "..." | null
    }
  },
  "intent_id": "01HZX..."
}
```

The handler is idempotent on `run_id`: the second submission updates the same record (BSP-008 §"writer-internal" semantics); subsequent submissions for the same `run_id` are rejected with K42 `runframe_terminal` once a non-`running` status is recorded — RunFrames are immutable after terminal status per [concepts/run-frame §"Invariants"](../atoms/concepts/run-frame.md).

K-class additions: K102 (`runframe_validator_failed` — duplicate `run_id` from a different cell) per [concepts/run-frame](../atoms/concepts/run-frame.md). Surfaced as K42/`reason: "K102: ..."`.

## §5. Test surface

In `vendor/LLMKernel/tests/test_agent_supervisor.py`:

- `test_run_start_writes_runframe_with_running_status`.
- `test_run_terminal_updates_runframe_status_to_complete`.
- `test_run_failure_writes_failed_status_and_ended_at`.
- `test_run_interrupted_writes_interrupted_status` — operator `/stop` mid-run.
- `test_runframe_pinned_to_original_cell_id_after_split` — split during run not allowed (covered in S5.5), but post-run split must NOT rewrite the RunFrame.
- `test_runframe_section_auto_transition_in_progress`.

In `vendor/LLMKernel/tests/test_metadata_writer.py`:

- `test_record_run_frame_first_call_running`.
- `test_record_run_frame_terminal_idempotent` — second submission with same `run_id` overwrites.
- `test_record_run_frame_post_terminal_rejected_k102` — third submission rejected.
- `test_record_run_frame_unknown_executor_k42`.
- `test_record_run_frame_unknown_manifest_k42`.

In `vendor/LLMKernel/tests/test_hydrate.py`:

- `test_hydrate_restores_run_frames`.
- `test_hydrate_re_renders_cells_from_turns` — reopen produces equivalent cell outputs to the pre-close render.

In `extension/test/notebook/`:

- `inspect-mode.test.ts` — virtual document opens with manifest + RunFrame fields.
- `cell-edit-binding.test.ts` — `cell_edit` produces `set_cell_metadata`.

Expected count: 6 supervisor + 5 writer + 2 hydrate + 2 extension = 15 new tests.

## §6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Re-render at file-open emits new spans the user already saw | Hydrate-time re-render reads from `turns[].body` directly, NOT from re-execution; it produces no new wire traffic (covered by `test_hydrate_re_renders_cells_from_turns`). |
| `record_run_frame` two-phase write creates a window where status is `running` after a crash | A crashed kernel leaves an orphan `running` RunFrame; the [contracts/drift-detector](../atoms/contracts/drift-detector.md)'s in-progress span truncation pattern applies — extend it to RunFrames in [PLAN-substrate-gap-closure.md](PLAN-substrate-gap-closure.md) (gap G11 / G12 area). |
| Idempotency edge: two terminal submissions race | Writer FIFO serialization (`_intent_queue_lock`) makes one win, the other returns `already_applied`. |
| RunFrame storage growth (every run is permanent) | Append-only is correct per [concepts/run-frame §"Invariants"](../atoms/concepts/run-frame.md). V2 may add archival; V1 keeps everything. |
| Extension's hydrate re-render diverges from the kernel-rendered version | Both paths render from the same `turns[].body` + `turns[].spans[]` source-of-truth. Snapshot tests pin the render. |

## §7. Atoms touched + Atom Status fields needing update

- [concepts/run-frame.md](../atoms/concepts/run-frame.md) — Status `V1 shipped (minimal schema only)` confirmed; verify all listed invariants are tested.
- [concepts/context-manifest.md](../atoms/concepts/context-manifest.md) — `context_manifest_id` referenced from RunFrame is now an end-to-end live link.
- [decisions/v1-runframe-minimal.md](../atoms/decisions/v1-runframe-minimal.md) — referenced; no shape change.
- [contracts/agent-supervisor.md](../atoms/contracts/agent-supervisor.md) — confirm RunFrame submission added to its responsibilities; update Code drift section.
- [contracts/metadata-writer.md](../atoms/contracts/metadata-writer.md) — Code drift section: clear the line about `record_run_frame` missing.
- [contracts/intent-dispatcher.md](../atoms/contracts/intent-dispatcher.md) — same.
- [protocols/submit-intent-envelope.md](../atoms/protocols/submit-intent-envelope.md) — `record_run_frame` row's atom link wires to a live implementation.
- [concepts/cell.md](../atoms/concepts/cell.md) — verify "Re-running a cell creates a NEW turn" invariant is regression-tested.

## §8. Cross-references (sibling PLANs)

- [PLAN-v1-roadmap.md §5 rows 8 + 9](PLAN-v1-roadmap.md) — ship-ready bullets flipped here.
- [PLAN-S0.5-cell-kinds.md](PLAN-S0.5-cell-kinds.md) — `kind` field rendered at hydrate.
- [PLAN-S3.5-context-packer.md](PLAN-S3.5-context-packer.md) — manifest output is what the RunFrame points at.
- [PLAN-S5-branch-revert-stop.md](PLAN-S5-branch-revert-stop.md) — `append_turn` discipline locked there; this slice verifies.
- [PLAN-S5.5-sections.md](PLAN-S5.5-sections.md) — section auto-transition triggered from this slice.
- [PLAN-S7-sidebar-trees.md](PLAN-S7-sidebar-trees.md) — sidebar reads `run_frames.*` for the recent activity tree.
- [PLAN-substrate-gap-closure.md](PLAN-substrate-gap-closure.md) — gap G5 (`record_run_frame` intent) and the in-progress RunFrame truncation extension live there.

## §9. Definition of done

- [ ] All 15 new tests pass.
- [ ] Round-trip smoke: spawn alpha → 3 turns → close → reopen → all 3 turns visible without re-execution; RunFrames present for each; clicking Inspect on a cell opens the virtual document with manifest + RunFrame fields.
- [ ] Crash-recovery smoke: kill the kernel mid-run; reopen; the orphan `running` RunFrame is detected and either auto-truncated (drift event) or surfaced to the operator.
- [ ] Cell-edit smoke: edit a cell's directive text, save, reopen — the edit is preserved and the cell's `bound_agent_id` is correctly tied to the new turn.
- [ ] [concepts/run-frame.md](../atoms/concepts/run-frame.md) and [contracts/metadata-writer.md](../atoms/contracts/metadata-writer.md) Code drift sections updated.
- [ ] BSP-005 §6.4 changelog updated with the slice's commit SHA.
- [ ] This plan flips to `**Status**: shipped (commit <SHA>)`.
