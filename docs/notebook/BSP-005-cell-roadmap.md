# BSP-005: Cell roadmap — what cells are, what they're missing, and the slice order

**Status**: Issue 1, 2026-04-28
**Related**: BSP-002 (conversation graph — turns, agents, refs), BSP-003 (writer registry), FSP-001 (cells → OpenUI), FSP-002 (in-cell search + collapse)
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

That's a long list. The next ten slices below take it apart in dependency order so each lands cleanly.

## 2. The slice ladder (dependency-ordered)

Each slice is sized for one mega-round agent (or one operator afternoon). Items earlier in the list have no upstream dependencies; later items depend on earlier slices being in place.

### S1 — Cell-as-agent identity (BSP-002 §6) — extension only

**Operator-visible payoff**: every cell renders a small badge showing `agent_id` + `provider` + `runtime_status`. Now you can look at a notebook and see *who ran what* without reading the cell text.

**Why first**: pure extension work; depends only on data already on the wire (the OTLP span's `llmnb.agent_id` attribute). No kernel changes. Lowest risk, highest visibility.

**Concrete work**:
- Add a `vscode.NotebookCellStatusBarItemProvider` that reads the cell's last-emitted span attributes and renders a badge.
- Use `vscode.NotebookCellDecorationProvider` for a gutter color per agent (same agent → same color, stable across reload).
- Surface the agent's `runtime_status` (`spawning | active | idle | exited`) so the operator can tell at a glance which cell's agent is still alive.

**Estimate**: half day. **Slice owner**: X-EXT.

### S2 — Persistent Claude Phase 2 (BSP-002 §4.3) — kernel side

**Operator-visible payoff**: re-running `/spawn alpha task:"..."` after the prior process exited threads the conversation through `--resume <claude_session_id>`. Same agent, same memory, new turn.

**Why second**: requires Phase 1 (already shipped). Doesn't require any extension work — kernel-internal change.

**Concrete work**:
- New `AgentSupervisor.resume(agent_id, task)` method that re-spawns claude with `--resume=<existing_session_id>` instead of fresh. Existing handle's `claude_session_id` is reused.
- Update the spawn idempotency check in `AgentSupervisor.spawn` (currently: alive → return existing; dead → fresh spawn): change "dead → fresh spawn" to "dead → resume(agent_id, task)".
- Test: spawn → terminate → spawn again. Verify the second invocation passes `--resume` with the original UUID.

**Spec ambiguity flagged**: BSP-002 §4.3 says "after exit the agent is not lost — `runtime_status: idle` and `claude_session_id` is preserved." But Phase 1 doesn't track `runtime_status` on `AgentHandle` — the dataclass has `state: AgentState` (`starting | active | terminated`). Phase 2 needs a new state `idle` distinct from `terminated`, and the supervisor should keep dead-but-resumable handles in `self._agents` (today: terminated handles are removed). Update the state machine accordingly.

**Estimate**: ~3 hours. **Slice owner**: K-AS Phase 2.

### S3 — Multi-turn cells via `@<agent>` directive (BSP-002 §3 / §4.2)

**Operator-visible payoff**: `@alpha: incorporate beta's feedback` writes a JSON line to alpha's stdin, alpha processes it as a new turn, response lands in the cell. No re-spawn needed.

**Why third**: depends on S2 (the agent must be persistent). Requires both kernel and extension work.

**Concrete work**:
- **Kernel**: switch to `claude --input-format=stream-json` so stdin is a JSON-line channel. The agent process stays alive between turns. New `AgentSupervisor.send_user_turn(agent_id, text)` writes one `{"type":"user","message":...}` line to the agent's stdin. The existing reader threads pick up the response spans.
- **Extension**: parser extension at [extension/src/notebook/cell-directive.ts] adds the `@<id>: <text>` grammar alongside `/spawn`. Sends a different operator.action shape (`{"action_type":"agent_continue","agent_id":...,"text":...}`) which the kernel routes to `send_user_turn`.
- **Cell rendering**: the cell now contains *multiple* turns. Each turn is one OTLP span. Renderer needs a list-of-spans display, not just one.

**Spec ambiguity flagged**: today the controller maps one `executeCell` call to one terminal span. With multiple turns, we either (a) re-execute the cell on every continuation (operator-visible "running") or (b) keep the cell idle and let new turns flow into its outputs without an execution cycle. (b) is cleaner but doesn't match VS Code's `NotebookCellExecution` model. Worth a §3.x amendment to BSP-002.

**Estimate**: 1 day. **Slice owner**: K-AS-S3 + X-EXT-S3 in parallel.

### S4 — Persistent Claude Phase 3: cross-agent context handoff (BSP-002 §4.6)

**Operator-visible payoff**: in a notebook with cells against alpha, beta, gamma, sending `@alpha` after beta has run injects beta's reply as context into alpha's session before alpha sees the operator's message. Operator never has to manually paste turns between agents.

**Why fourth**: requires S2 (resume) AND S3 (multi-turn) AND a `metadata.rts.zone` notion of `last_seen_turn_id` per agent.

**Concrete work**:
- Each agent's `AgentHandle` gains `last_seen_turn_id: str`.
- `send_user_turn(agent_id, text)` walks the turn DAG between `agent.last_seen_turn_id` and the notebook's current head; writes a synthesis message ("Beta replied: ...") for each missed turn before sending the operator's message.
- Updates `last_seen_turn_id` to the new turn after the agent responds.

**Estimate**: 1.5 days (turn DAG traversal isn't trivial). **Slice owner**: K-AS-S4.

### S5 — Cell directive grammar expansion (`/branch`, `/revert`, `/stop`)

**Operator-visible payoff**: git-style operations on agent histories — branch alpha into beta at turn t_3; revert alpha to t_2 (HEAD moves backward, future turns build from there); stop alpha cleanly.

**Why fifth**: depends on persistent agents (S2/S3) and the turn DAG existing as a real data structure (currently only `claude_session_id` is tracked; the per-turn DAG isn't materialized in `metadata.rts.zone`).

**Concrete work**:
- Materialize the turn DAG in `metadata.rts.zone.agents.<id>.turns[]` per BSP-002 §3.
- `/branch alpha at t_3 as beta`: spawn beta with `--resume=<alpha_session> --fork-session` (Case A) or replay-via-stream-json (Case B); record the new agent in `metadata.rts.zone.agents.<beta>`.
- `/revert alpha to t_2`: SIGTERM alpha (if alive); set `agent.head_turn_id = t_2`; record a `ref-move` event in `metadata.rts.event_log`. Next `@alpha` resumes via Case B replay.
- `/stop alpha`: clean SIGTERM; record `runtime_status: idle`.

**Estimate**: 2 days. **Slice owner**: K-AS-S5 + X-EXT-S5 (parser).

### S6 — Cell-to-turn binding write-back (BSP-002 §3 / §6 / writer registry)

**Operator-visible payoff**: the cell *is* the turn. Closing and reopening the notebook restores the conversation, including who ran what, when, and which spans were emitted.

**Why sixth**: requires S2-S5 to have produced real turn data. Until then there's nothing meaningful to persist.

**Concrete work**:
- Per BSP-003, the kernel's `MetadataWriter.submit_intent("append_turn", ...)` is the canonical write path. Wire `AgentSupervisor.spawn` and `send_user_turn` to call `submit_intent` per turn.
- Extension-side: when the operator manually edits a cell's directive (e.g. fixing a typo before re-running), submit a `set_cell_metadata` intent so the writer records the cell→turn binding.
- The metadata-loader at file-open re-renders cells from `metadata.rts.zone.agents[*].turns[]` per the V1 hydrate path.

**Estimate**: 1 day (mostly extension-side; kernel write paths exist). **Slice owner**: K-MW-S6 + X-EXT-S6.

### S7 — Sidebar Activity Bar (chapter 07 §"V1 feasibility assessment" item 5)

**Operator-visible payoff**: tree views for zones, agents, recent activity in the VS Code sidebar. Clicking an agent jumps to its first cell; clicking an event log entry shows the turn.

**Why seventh**: depends on materialized turn DAG (S6) so there's data to render.

**Concrete work**:
- Three `vscode.TreeDataProvider` implementations consuming `metadata.rts.{agents,layout,event_log}`.
- `package.json contributes.viewsContainers` registers an activity bar entry.
- Live updates via the metadata-applier's `onLastAcceptedVersion` hook (each snapshot push refreshes the trees).

**Estimate**: 1 day. **Slice owner**: X-EXT-S7.

### S8 — Inline approval `vscode.diff` (chapter 07 item 7)

**Operator-visible payoff**: when an agent calls `propose_edit` (RFC-001), the operator sees a real diff view inline in the cell, not a JSON blob.

**Why now**: depends on multi-turn rendering (S3). The renderer surface needs to know how to embed a `vscode.diff` URI.

**Concrete work**:
- Renderer: detect spans with `name=propose_edit` and create a clickable affordance that opens a temporary `vscode.diff` editor against the proposed file.
- `Approve` / `Reject` buttons in the diff view post an `operator.action approval_response` envelope to the kernel.

**Estimate**: half day. **Slice owner**: X-EXT-S8.

### S9 — Streaming with auto-scroll + interrupt button (chapter 07 item 8)

**Operator-visible payoff**: long agent responses stream into the cell as they arrive (already shipped at the wire level). The new piece is a cell-toolbar interrupt button that maps to SIGINT on the agent's process.

**Why now**: depends on persistent agents (S2). Interrupt only makes sense if the agent is alive.

**Concrete work**:
- `vscode.NotebookCellStatusBarItem` with an interrupt action.
- Maps to an `operator.action` envelope `{"action_type":"agent_interrupt","agent_id":...}`.
- Kernel routes to `AgentSupervisor.interrupt(agent_id)` which sends SIGINT to the agent's PID.

**Estimate**: half day. **Slice owner**: K-AS-S9 + X-EXT-S9.

### S10 — Three-pane mental model (chapter 07 item 10) + FSP-002 search/collapse

**Operator-visible payoff**: the notebook visually distinguishes *streaming* (current cell's in-flight output) / *current* (the cell the operator is editing) / *artifacts* (overlay cells, attachments). Plus FSP-002 search across cell content + bulk collapse.

**Why last**: pure UX polish. Depends on everything else being stable.

**Concrete work**:
- CSS tweaks + cell-status decoration to distinguish the three states.
- FSP-002 implementation per spec.

**Estimate**: 1 day. **Slice owner**: X-EXT-S10.

### S11 (deferred to V2) — FSP-001 cells → OpenUI button

Per the FSP, this is V2 work. Not blocking V1 ship. Slice spec already exists.

## 3. What this means in practice

V1 ship-readiness today means **substrate works**. After S1+S2 (~1.5 days), the operator gets a real "this is a notebook" feeling — agent identity visible per cell, conversations actually persist across cell re-runs.

After S3+S4 (~3 days more), the operator can have a multi-agent conversation that threads correctly without manual context paste.

After S5 (~2 days), git-style ops on agents are real.

After S6+S7+S8+S9+S10 (~3.5 days), V1 is operator-feature-complete.

**Total runway from green Tier 4 to V1 UX ship-ready**: ~10 working days, sliceable in either dependency order or 2-3-agent parallel.

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

For the next session: pick **S1 + S2 in parallel**.
- S1 is pure extension; runs against existing wire data.
- S2 is pure kernel; runs against existing data model.
- They land independently, can be reviewed independently, and together close the visible gap between "spawn-and-die" and "real conversation."

After S1+S2 land and you've tested them by hand, S3 is the clear next pick.

## Changelog

- **Issue 1, 2026-04-28**: initial. 10 slices in dependency order from cell badges (S1) through three-pane mental model + search (S10), plus S11 deferred to V2. Cross-cutting concerns flagged in §4. ~10 working days to V1 UX ship-ready.
