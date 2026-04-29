# BSP-005: Cell roadmap — what cells are, what they're missing, and the slice order

**Status**: Issue 2 — 2026-04-28 amendment landed (S0.5, S3.5, S5.5; S6 expanded with RunFrame minimal). Issue 1, 2026-04-28.
**Related**: BSP-002 (conversation graph — turns, agents, refs), BSP-003 (writer registry), FSP-001 (cells → OpenUI), FSP-002 (in-cell search + collapse)
**Atom anchors**: definitional content lives in [`docs/atoms/`](../atoms/README.md) — see `concepts/`, `operations/`, `decisions/`. This BSP stays normative for slice order, sizing, and dependency choreography.
**Driver**: V1 substrate is verified end-to-end (Tier 4 4/4 green). The notebook *layer* is barely scaffolded — what works today is "operator types `/spawn`, gets one OTLP span back." This BSP consolidates everything we've discussed about cell-side improvements into a single roadmap so the slice order is explicit and the dependencies between slices are visible.

This is a planning document, not a new contract. Each item references the existing spec it would land under (BSP-002 §X, FSP-Y, etc.). Items already specified in detail are pointers; items underspecified are flagged.

## 1. Where we are today

What works:
- One operator types `/spawn alpha task:"..."` → kernel resolves directive, spawns Claude, agent emits one notify span, span lands as `application/vnd.rts.run+json` in cell output.
- `agent_spawn` is idempotent within one zone (re-running the same `/spawn` while alive returns the existing handle — BSP-002 Phase 1).
- Each spawn captures a kernel-owned `claude_session_id` (UUID) for future `--resume` plumbing.

What does NOT work yet (operator-visible):
- The cell shows raw OTLP JSON, not a rendered conversation
- Re-running the same cell makes a *new* spawn (Phase 1 idempotency only fires within one process; cross-cell continuation is still missing)
- A second cell against the same agent doesn't continue the conversation — it would spawn fresh
- No way to send a follow-up turn (`@alpha: keep going`)
- No `/branch`, `/revert`, `/stop`
- No visible identity ("which agent ran in this cell?")
- Cells are isolated; can't be selected/searched/collapsed in bulk
- Cells can't be promoted to a UI (FSP-001)

That's a long list. The next slices below take it apart in dependency order so each lands cleanly.

## 2. The slice ladder (dependency-ordered)

Each slice is sized for one mega-round agent (or one operator afternoon). Items earlier in the list have no upstream dependencies; later items depend on earlier slices being in place.

The Issue 2 amendment (2026-04-28) inserts S0.5 ahead of S1, S3.5 between S3 and S4, and S5.5 between S5 and S6. S6 is expanded to also include RunFrame minimal per [decisions/v1-runframe-minimal](../atoms/decisions/v1-runframe-minimal.md). See §6 below for the amendment ratification.

### S0.5 — Cell kinds typed enum (NEW in Issue 2 — KB-target §0.4)

**Operator-visible payoff**: every cell now carries a typed `kind` field (`agent | markdown | scratch | checkpoint`, plus four V2-reserved values). Merge correctness, ContextPacker filtering, and render dispatch can branch structurally instead of guessing from cell content.

**Why first**: blocking precondition for the whole roadmap. The merge invariants in S5/S6 reference `kind`; ContextPacker (S3.5) consults `kind` for `scratch`/`checkpoint` handling; renderers in S1 want the kind label. Landing the enum slot up front is cheaper than back-patching later.

**Concrete work**:
- Add `metadata.rts.cells[<id>].kind` field to the writer per the [cell-kinds atom](../atoms/concepts/cell-kinds.md).
- V1 actives: `agent`, `markdown`, `scratch`, `checkpoint`. Reserve `tool`, `artifact`, `control`, `native` enum values without dispatch (V1 consumers preserve verbatim, render inert with kind label).
- Pre-Issue-2 cells with no `kind` default to `agent` at load; the writer back-fills on next snapshot.
- Per-kind slot rules: `markdown` MUST NOT carry `bound_agent_id`; `scratch`/`checkpoint` SHOULD have `bound_agent_id: null`.

**Driver**: KB-target §0.4. Atom mapping locks the eight-value enum so reserved kinds round-trip from V1 forward.

**Estimate**: 0.5 days. **Slice owner**: K-MW-S0.5.

**Atoms touched**: [cell-kinds](../atoms/concepts/cell-kinds.md), [cell](../atoms/concepts/cell.md), [decisions/v1-flat-sections](../atoms/decisions/v1-flat-sections.md).

### S1 — Cell-as-agent identity (BSP-002 §6) — extension only

**Operator-visible payoff**: every cell renders a small badge showing `agent_id` + `provider` + `runtime_status`. Now you can look at a notebook and see *who ran what* without reading the cell text.

**Why first among shipping slices**: pure extension work; depends only on data already on the wire (the OTLP span's `llmnb.agent_id` attribute) plus the kind label from S0.5. No kernel changes. Lowest risk, highest visibility.

**Concrete work**:
- Add a `vscode.NotebookCellStatusBarItemProvider` that reads the cell's last-emitted span attributes and renders a badge.
- Use `vscode.NotebookCellDecorationProvider` for a gutter color per agent (same agent → same color, stable across reload).
- Surface the agent's `runtime_status` (`spawning | active | idle | exited`) so the operator can tell at a glance which cell's agent is still alive.
- Render the cell `kind` label from S0.5 alongside the agent badge.

**Estimate**: half day. **Slice owner**: X-EXT.

**Atoms touched**: [cell](../atoms/concepts/cell.md), [agent](../atoms/concepts/agent.md), [cell-kinds](../atoms/concepts/cell-kinds.md).

### S2 — Persistent Claude Phase 2 (BSP-002 §4.3) — kernel side

**Operator-visible payoff**: re-running `/spawn alpha task:"..."` after the prior process exited threads the conversation through `--resume <claude_session_id>`. Same agent, same memory, new turn.

**Why second**: requires Phase 1 (already shipped). Doesn't require any extension work — kernel-internal change.

**Concrete work**:
- New `AgentSupervisor.resume(agent_id, task)` method that re-spawns claude with `--resume=<existing_session_id>` instead of fresh. Existing handle's `claude_session_id` is reused.
- Update the spawn idempotency check in `AgentSupervisor.spawn` (currently: alive → return existing; dead → fresh spawn): change "dead → fresh spawn" to "dead → resume(agent_id, task)".
- Test: spawn → terminate → spawn again. Verify the second invocation passes `--resume` with the original UUID.

**Spec ambiguity flagged**: BSP-002 §4.3 says "after exit the agent is not lost — `runtime_status: idle` and `claude_session_id` is preserved." But Phase 1 doesn't track `runtime_status` on `AgentHandle` — the dataclass has `state: AgentState` (`starting | active | terminated`). Phase 2 needs a new state `idle` distinct from `terminated`, and the supervisor should keep dead-but-resumable handles in `self._agents` (today: terminated handles are removed). Update the state machine accordingly.

**Estimate**: ~3 hours. **Slice owner**: K-AS Phase 2.

**Atoms touched**: [agent](../atoms/concepts/agent.md), [decisions/no-rebind-popen](../atoms/decisions/no-rebind-popen.md).

### S3 — Multi-turn cells via `@<agent>` directive (BSP-002 §3 / §4.2)

**Operator-visible payoff**: `@alpha: incorporate beta's feedback` writes a JSON line to alpha's stdin, alpha processes it as a new turn, response lands in the cell. No re-spawn needed.

**Why third**: depends on S2 (the agent must be persistent). Requires both kernel and extension work.

**Concrete work**:
- **Kernel**: switch to `claude --input-format=stream-json` so stdin is a JSON-line channel. The agent process stays alive between turns. New `AgentSupervisor.send_user_turn(agent_id, text)` writes one `{"type":"user","message":...}` line to the agent's stdin. The existing reader threads pick up the response spans.
- **Extension**: parser extension at [extension/src/notebook/cell-directive.ts] adds the `@<id>: <text>` grammar alongside `/spawn`. Sends a different operator.action shape (`{"action_type":"agent_continue","agent_id":...,"text":...}`) which the kernel routes to `send_user_turn`.
- **Cell rendering**: the cell now contains *multiple* turns. Each turn is one OTLP span. Renderer needs a list-of-spans display, not just one.

**Spec ambiguity flagged**: today the controller maps one `executeCell` call to one terminal span. With multiple turns, we either (a) re-execute the cell on every continuation (operator-visible "running") or (b) keep the cell idle and let new turns flow into its outputs without an execution cycle. (b) is cleaner but doesn't match VS Code's `NotebookCellExecution` model. Worth a §3.x amendment to BSP-002.

**Estimate**: 1 day. **Slice owner**: K-AS-S3 + X-EXT-S3 in parallel.

**Atoms touched**: [operations/continue-turn](../atoms/operations/continue-turn.md), [turn](../atoms/concepts/turn.md), [agent](../atoms/concepts/agent.md).

### S3.5 — ContextPacker simple-walker (NEW in Issue 2 — KB-target §0.6)

**Operator-visible payoff**: agent context is now derived from a deterministic, structural walk of the overlay rather than whole-notebook concatenation. Turns flagged `scratch`/`excluded`/`obsolete` drop out; pinned cells appear at head; section predecessors precede the current cell.

**Why here**: depends on S3's multi-turn machinery (the walker has something meaningful to assemble). Lands before S4's cross-agent handoff because handoff replays the walker's output across agents.

**Concrete work**:
- Implement the walker per [decisions/v1-contextpacker-walk](../atoms/decisions/v1-contextpacker-walk.md): pinned anywhere → previous cells in current section in chronological order → current cell's prior sub-turns → exclude `scratch | excluded | obsolete` → dedupe preserving first-occurrence order.
- Persist outputs as [context-manifest](../atoms/concepts/context-manifest.md) entries via the new `record_context_manifest` intent (BSP-003 §5 amendment).
- Pure function: no I/O, no agent calls. Same input → byte-identical manifest.

**Driver**: KB-target §0.6, §0.10 (S3.5 row).

**Estimate**: 1 day. **Slice owner**: K-AS-S3.5.

**Atoms touched**: [context-manifest](../atoms/concepts/context-manifest.md), [decisions/v1-contextpacker-walk](../atoms/decisions/v1-contextpacker-walk.md), [section](../atoms/concepts/section.md).

### S4 — Persistent Claude Phase 3: cross-agent context handoff (BSP-002 §4.6)

**Operator-visible payoff**: in a notebook with cells against alpha, beta, gamma, sending `@alpha` after beta has run injects beta's reply as context into alpha's session before alpha sees the operator's message. Operator never has to manually paste turns between agents.

**Why fourth**: requires S2 (resume) AND S3 (multi-turn) AND a `metadata.rts.zone` notion of `last_seen_turn_id` per agent. Builds on S3.5's manifest output.

**Concrete work**:
- Each agent's `AgentHandle` gains `last_seen_turn_id: str`.
- `send_user_turn(agent_id, text)` walks the turn DAG between `agent.last_seen_turn_id` and the notebook's current head; writes a synthesis message ("Beta replied: ...") for each missed turn before sending the operator's message.
- Updates `last_seen_turn_id` to the new turn after the agent responds.

**Estimate**: 1.5 days (turn DAG traversal isn't trivial). **Slice owner**: K-AS-S4.

**Atoms touched**: [agent](../atoms/concepts/agent.md), [context-manifest](../atoms/concepts/context-manifest.md), [turn](../atoms/concepts/turn.md).

### S5 — Cell directive grammar expansion (`/branch`, `/revert`, `/stop`)

**Operator-visible payoff**: git-style operations on agent histories — branch alpha into beta at turn t_3; revert alpha to t_2 (HEAD moves backward, future turns build from there); stop alpha cleanly.

**Why fifth**: depends on persistent agents (S2/S3) and the turn DAG existing as a real data structure (currently only `claude_session_id` is tracked; the per-turn DAG isn't materialized in `metadata.rts.zone`).

**Concrete work**:
- Materialize the turn DAG in `metadata.rts.zone.agents.<id>.turns[]` per BSP-002 §3.
- `/branch alpha at t_3 as beta`: spawn beta with `--resume=<alpha_session> --fork-session` (Case A) or replay-via-stream-json (Case B); record the new agent in `metadata.rts.zone.agents.<beta>`.
- `/revert alpha to t_2`: SIGTERM alpha (if alive); set `agent.head_turn_id = t_2`; record a `ref-move` event in `metadata.rts.event_log`. Next `@alpha` resumes via Case B replay.
- `/stop alpha`: clean SIGTERM; record `runtime_status: idle`.

**Estimate**: 2 days. **Slice owner**: K-AS-S5 + X-EXT-S5 (parser).

**Atoms touched**: [operations/branch-agent](../atoms/operations/branch-agent.md), [operations/revert-agent](../atoms/operations/revert-agent.md), [operations/stop-agent](../atoms/operations/stop-agent.md).

### S5.5 — Sections (overlay-graph narrative range) (NEW in Issue 2 — KB-target §0.1, §6)

**Operator-visible payoff**: an operator can group cells into named narrative ranges (`Architecture`, `Runtime`, `Tests`) and collapse them. Sections are operator-side overlay objects — creating one does not touch the immutable turn DAG.

**Why here**: depends on S5's overlay-commit machinery being live (sections are created/renamed/deleted as overlay commits). Precedes S6 because cell→section membership is part of the cell-to-turn binding the writer needs to record.

**Concrete work**:
- Implement `metadata.rts.zone.sections[]` per the [section atom](../atoms/concepts/section.md) and BSP-002 §13.1.1.
- Flat sections only in V1 per [decisions/v1-flat-sections](../atoms/decisions/v1-flat-sections.md): `parent_section_id` slot exists but MUST be `null`; non-null is rejected.
- Mirror cell membership at `metadata.rts.cells[<id>].section_id`. The dual representation (`sections[].cell_range[]` ↔ `cells[].section_id`) is enforced write-time consistent by `MetadataWriter.submit_intent` (decision D8).
- Operations: [create-section](../atoms/operations/create-section.md), [rename-section](../atoms/operations/rename-section.md), [delete-section](../atoms/operations/delete-section.md). Deletion of a non-empty section is forbidden (decision SD1).
- V1 ships `collapsed: bool` + optional `summary?: string`; the full status enum lands in V2 (decision D1).

**Driver**: KB-target §0.1, §6, §0.10 (S5.5 row).

**Estimate**: 1.5 days. **Slice owner**: K-MW-S5.5 + X-EXT-S5.5.

**Atoms touched**: [section](../atoms/concepts/section.md), [decisions/v1-flat-sections](../atoms/decisions/v1-flat-sections.md), [operations/create-section](../atoms/operations/create-section.md).

### S6 — Cell-to-turn binding write-back + RunFrame minimal (BSP-002 §3 / §6 / writer registry; KB-target §0.5)

**Operator-visible payoff**: the cell *is* the turn. Closing and reopening the notebook restores the conversation, including who ran what, when, and which spans were emitted. Inspect mode answers per cell run: "what context did the agent see?" and "what changed in the turn DAG?"

**Why sixth**: requires S2-S5 to have produced real turn data and S5.5's section membership. Until then there's nothing meaningful to persist.

**Concrete work**:
- Per BSP-003, the kernel's `MetadataWriter.submit_intent("append_turn", ...)` is the canonical write path. Wire `AgentSupervisor.spawn` and `send_user_turn` to call `submit_intent` per turn.
- Extension-side: when the operator manually edits a cell's directive (e.g. fixing a typo before re-running), submit a `set_cell_metadata` intent so the writer records the cell→turn binding.
- The metadata-loader at file-open re-renders cells from `metadata.rts.zone.agents[*].turns[]` per the V1 hydrate path.
- **RunFrame minimal**: write `metadata.rts.zone.run_frames.<run_id>` per [decisions/v1-runframe-minimal](../atoms/decisions/v1-runframe-minimal.md) — `{run_id, cell_id, executor_id, turn_head_before, turn_head_after, context_manifest_id, status, started_at, ended_at}`. Deferred V2 fields (`parent_run_id`, `source_snapshot_id`, `overlay_commit_id`, `artifact_windows[]`, full `tool_permissions`) NOT emitted in V1; consumers tolerate absence.
- Inspect mode reads the RunFrame + manifest pair to render the per-run "what the agent saw" view.

**S6 expanded** to include RunFrame minimal per [decisions/v1-runframe-minimal](../atoms/decisions/v1-runframe-minimal.md). The two write-backs land together because both flow through the same `MetadataWriter` intent path; splitting them would double the test fixtures without reducing risk.

**Estimate**: 2 days (cell-binding ~1 day, RunFrame minimal ~1 day; mostly extension-side for binding, kernel-side for RunFrames). **Slice owner**: K-MW-S6 + X-EXT-S6.

**Atoms touched**: [cell](../atoms/concepts/cell.md), [turn](../atoms/concepts/turn.md), [run-frame](../atoms/concepts/run-frame.md), [decisions/v1-runframe-minimal](../atoms/decisions/v1-runframe-minimal.md).

### S7 — Sidebar Activity Bar (chapter 07 §"V1 feasibility assessment" item 5)

**Operator-visible payoff**: tree views for zones, agents, recent activity in the VS Code sidebar. Clicking an agent jumps to its first cell; clicking an event log entry shows the turn.

**Why seventh**: depends on materialized turn DAG (S6) so there's data to render. Section membership from S5.5 lets the tree show sections as collapsible nodes.

**Concrete work**:
- Three `vscode.TreeDataProvider` implementations consuming `metadata.rts.{agents,layout,event_log}` plus the new `sections[]`.
- `package.json contributes.viewsContainers` registers an activity bar entry.
- Live updates via the metadata-applier's `onLastAcceptedVersion` hook (each snapshot push refreshes the trees).

**Estimate**: 1 day. **Slice owner**: X-EXT-S7.

**Atoms touched**: [section](../atoms/concepts/section.md), [agent](../atoms/concepts/agent.md), [zone](../atoms/concepts/zone.md).

### S8 — Inline approval `vscode.diff` (chapter 07 item 7)

**Operator-visible payoff**: when an agent calls `propose_edit` (RFC-001), the operator sees a real diff view inline in the cell, not a JSON blob.

**Why now**: depends on multi-turn rendering (S3). The renderer surface needs to know how to embed a `vscode.diff` URI.

**Concrete work**:
- Renderer: detect spans with `name=propose_edit` and create a clickable affordance that opens a temporary `vscode.diff` editor against the proposed file.
- `Approve` / `Reject` buttons in the diff view post an `operator.action approval_response` envelope to the kernel.

**Estimate**: half day. **Slice owner**: X-EXT-S8.

**Atoms touched**: [span](../atoms/concepts/span.md), [output-kind](../atoms/concepts/output-kind.md), [tool-call](../atoms/concepts/tool-call.md).

### S9 — Streaming with auto-scroll + interrupt button (chapter 07 item 8)

**Operator-visible payoff**: long agent responses stream into the cell as they arrive (already shipped at the wire level). The new piece is a cell-toolbar interrupt button that maps to SIGINT on the agent's process.

**Why now**: depends on persistent agents (S2). Interrupt only makes sense if the agent is alive.

**Concrete work**:
- `vscode.NotebookCellStatusBarItem` with an interrupt action.
- Maps to an `operator.action` envelope `{"action_type":"agent_interrupt","agent_id":...}`.
- Kernel routes to `AgentSupervisor.interrupt(agent_id)` which sends SIGINT to the agent's PID.

**Estimate**: half day. **Slice owner**: K-AS-S9 + X-EXT-S9.

**Atoms touched**: [agent](../atoms/concepts/agent.md), [operations/stop-agent](../atoms/operations/stop-agent.md).

### S10 — Three-pane mental model (chapter 07 item 10) + FSP-002 search/collapse

**Operator-visible payoff**: the notebook visually distinguishes *streaming* (current cell's in-flight output) / *current* (the cell the operator is editing) / *artifacts* (overlay cells, attachments). Plus FSP-002 search across cell content + bulk collapse.

**Why last**: pure UX polish. Depends on everything else being stable.

**Concrete work**:
- CSS tweaks + cell-status decoration to distinguish the three states.
- FSP-002 implementation per spec.

**Estimate**: 1 day. **Slice owner**: X-EXT-S10.

**Atoms touched**: [cell-kinds](../atoms/concepts/cell-kinds.md), [section](../atoms/concepts/section.md), [output-kind](../atoms/concepts/output-kind.md).

### S11 (deferred to V2) — FSP-001 cells → OpenUI button

Per the FSP, this is V2 work. Not blocking V1 ship. Slice spec already exists.

## 3. What this means in practice

V1 ship-readiness today means **substrate works**. After S0.5+S1+S2 (~2 days), the operator gets a real "this is a notebook" feeling — typed cells, agent identity visible per cell, conversations actually persist across cell re-runs.

After S3+S3.5+S4 (~3.5 days more), the operator can have a multi-agent conversation that threads correctly without manual context paste, with deterministic per-cell context manifests.

After S5+S5.5 (~3.5 days), git-style ops on agents are real and the operator can group cells into named sections.

After S6+S7+S8+S9+S10 (~5 days), V1 is operator-feature-complete and Inspect mode answers per-cell-run questions.

**Total V1 UX runway from green Tier 4 to ship-ready**: ~17-18 working days (was ~10-13 in Issue 1; the Issue 2 amendment adds ~5-6 days from S0.5, S3.5, S5.5, and S6's RunFrame minimal expansion). Sliceable in either dependency order or 2-3-agent parallel.

## 4. Cross-cutting concerns flagged

### 4.1 Render-time heaviness as cells accumulate turns

Once S3 lands, a single cell may carry tens of OTLP spans. The current renderer parses every span on every render. For a 50-turn cell that's a perceptible delay.

Mitigation queued for S6: cell metadata cache (`metadata.rts.cells[<cell_id>].metadata.rts.cell.cached_render`) that holds the rendered HTML. Re-renders only when a new turn lands.

### 4.2 Operator vs agent ownership of cell text

Today, the cell's first line is the directive (`/spawn ...`) the operator typed. Once an agent is persistent and answering follow-up turns, who owns the cell's *body*? Two options:
- **Append model** (current): operator edits the directive line; agent appends responses below as outputs. Cell text stays operator-owned.
- **Conversation model**: cell renders as a chat transcript with operator + agent turns interleaved. Cell text becomes a structured stream.

V1 picks the append model (less invasive). V2 may reconsider (FSP-001 OpenUI mode is a third-flavor answer).

### 4.3 Multi-cell zones running the same agent

If alpha is bound to cell 1 (its `/spawn`) and the operator sends `@alpha` from cell 5, where does the response land — cell 1 or cell 5?

V1 answer (BSP-002 §6 implicit): the response lands in the cell that *issued* the turn. Cell 1 carries spawn + first response. Cell 5 carries continuation + response. The agent identity is the link, not the cell.

V2 may add an "agent canvas" mode where all turns for an agent stream into one cell regardless of where the directive was typed. Future-FSP territory.

## 5. Implementation recommendation

For the next session: pick **S0.5 + S1 + S2 in parallel where possible**.
- S0.5 is pure kernel-writer work; depends on nothing.
- S1 is pure extension; runs against existing wire data + S0.5's kind label.
- S2 is pure kernel; runs against existing data model.
- They land mostly independently, can be reviewed independently, and together close the visible gap between "spawn-and-die" and "real conversation."

After S0.5+S1+S2 land and you've tested them by hand, S3 is the clear next pick, followed by S3.5 (ContextPacker walker) before moving into S4's cross-agent handoff.

## 6. Issue 2 — 2026-04-28 amendment

Amendment driver: [KB-notebook-target.md §0.10](KB-notebook-target.md#010-bsp-005-issue-2-amendment) requires the slice ladder to incorporate four V1 follow-ups surfaced during the deconfliction pass. Each is ratified below.

### 6.1 S0.5 — Cell kinds typed enum (NEW)

**Position**: before S1.
**Driver**: KB-target §0.4.
**Status**: amendment ratified into the slice ladder above.

Adds `metadata.rts.cells[<id>].kind` field per the [cell-kinds atom](../atoms/concepts/cell-kinds.md). V1 ships four kinds (`agent | markdown | scratch | checkpoint`); reserves four V2+ kinds (`tool | artifact | control | native`) as forward-compat slots.

**Estimated**: 0.5 days. **Atoms touched**: [cell-kinds](../atoms/concepts/cell-kinds.md), [cell](../atoms/concepts/cell.md), [decisions/v1-flat-sections](../atoms/decisions/v1-flat-sections.md).

### 6.2 S3.5 — ContextPacker simple-walker (NEW)

**Position**: between S3 and S4.
**Driver**: KB-target §0.6, §0.10.
**Status**: amendment ratified into the slice ladder above.

Implements the V1 ContextPacker as a pure, deterministic structural walker per [decisions/v1-contextpacker-walk](../atoms/decisions/v1-contextpacker-walk.md). Manifest persisted as [context-manifest](../atoms/concepts/context-manifest.md) entries via the new `record_context_manifest` BSP-003 intent.

**Estimated**: 1 day. **Atoms touched**: [context-manifest](../atoms/concepts/context-manifest.md), [decisions/v1-contextpacker-walk](../atoms/decisions/v1-contextpacker-walk.md), [section](../atoms/concepts/section.md).

### 6.3 S5.5 — Sections (overlay-graph narrative range) (NEW)

**Position**: between S5 and S6.
**Driver**: KB-target §0.1, §6.
**Status**: amendment ratified into the slice ladder above.

Implements `metadata.rts.zone.sections[]` per the [section atom](../atoms/concepts/section.md). Flat sections only in V1 per [decisions/v1-flat-sections](../atoms/decisions/v1-flat-sections.md) — `parent_section_id` slot exists but MUST be `null`. Operations land via overlay commits ([create-section](../atoms/operations/create-section.md), [rename-section](../atoms/operations/rename-section.md), [delete-section](../atoms/operations/delete-section.md)).

**Estimated**: 1.5 days. **Atoms touched**: [section](../atoms/concepts/section.md), [decisions/v1-flat-sections](../atoms/decisions/v1-flat-sections.md), [operations/create-section](../atoms/operations/create-section.md).

### 6.4 S6 expanded — RunFrame minimal + Inspect mode

**Position**: folded into S6 (no new slice number).
**Driver**: KB-target §0.5, §0.10.
**Status**: S6's "Concrete work" list above expanded with the RunFrame minimal write path.

S6 now also writes `metadata.rts.zone.run_frames.<run_id>` per [decisions/v1-runframe-minimal](../atoms/decisions/v1-runframe-minimal.md). RunFrames pair with the S3.5 manifests so Inspect mode answers per-cell-run "what did the agent see and what changed in the turn DAG?"

**Estimated**: +1 day folded into S6 (S6 sized at 2 days total for cell-binding + RunFrame minimal). **Atoms touched**: [run-frame](../atoms/concepts/run-frame.md), [decisions/v1-runframe-minimal](../atoms/decisions/v1-runframe-minimal.md).

### 6.5 Slice-ladder totals after Issue 2

| Phase | Slices | Days |
|---|---|---|
| Foundation | S0.5 + S1 + S2 | ~2.0 |
| Multi-turn + context | S3 + S3.5 + S4 | ~3.5 |
| Git-style + sections | S5 + S5.5 | ~3.5 |
| Persistence + UX | S6 + S7 + S8 + S9 + S10 | ~5.0 |
| **Total V1 UX runway** | **S0.5 → S10** | **~14-18 days** (sequential; less in parallel) |

Issue 1's ~10-day estimate was optimistic and predated the Issue 2 amendment. The ~17-18 day figure above is the realistic V1 UX shipping target after KB-target §0.10's additions.

## Changelog

- **2026-04-28 (atom-refactor Phase 4)**: per-slice "Atoms touched" lines added; definitions now live in `docs/atoms/`. Issue 2 amendment §6 ratifies S0.5 (cell kinds), S3.5 (ContextPacker walker), S5.5 (sections), and S6's RunFrame minimal expansion per [KB-notebook-target.md §0.10](KB-notebook-target.md#010-bsp-005-issue-2-amendment). Slice-ladder totals updated to ~17-18 days V1 UX runway. No behavioral or wire-format changes; the slice ordering, ownership, and dependency graph are normative in this BSP.
- **Issue 1, 2026-04-28**: initial. 10 slices in dependency order from cell badges (S1) through three-pane mental model + search (S10), plus S11 deferred to V2. Cross-cutting concerns flagged in §4. ~10 working days to V1 UX ship-ready (superseded by Issue 2 totals above).
