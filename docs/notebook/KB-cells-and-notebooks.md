# Knowledge base: cells and notebooks

**Status**: Living reference, 2026-04-28 — derived from the 2026-04-26..28 session transcript.
**Audience**: agents (sub-agents dispatched via the multi-agent rounds) AND future-self at the start of a new session.
**Purpose**: every notebook / cell decision discussed across the session, in one place. Replaces the need to read the full chat log to ramp on cell work.

This doc is **not a spec.** Specs are normative; this doc summarizes them and captures the surrounding rationale + decisions that didn't make it into spec text. Specs cited inline (BSP-NNN, FSP-NNN, RFC-NNN). When this doc and a spec disagree, the spec wins.

---

## §0. Quick-find index

| If you need to know about... | Read this first |
|---|---|
| The full V1 operator narrative (plain English) | §1 of this doc |
| What a cell IS (data model) | §2 + BSP-002 §3 |
| Cell types (directive / comment / promoted / output-only) | §3 |
| Cell lifecycle (spawn → continue → branch → revert → save → reopen) | §4 + BSP-002 §4 |
| Cell-to-agent binding, identity rendering | §5 + BSP-002 §6 |
| Cell directive grammar (`/spawn`, `@id`, `/branch`, `/revert`, `/stop`) | §6 + BSP-002 §3 |
| Cross-agent context handoff | §7 + BSP-002 §4.6 |
| Persistence — saving and reopening | §8 + RFC-005 + RFC-006 §8 |
| Slice ladder (what to implement, in what order) | §9 + BSP-005 |
| Scratch-inspired additions (comments, annotations, promoted cells) | §10 |
| Future / V2+ cell concepts (OpenUI, search, graph view) | §11 + FSP-001/002, BSP-002 §11 |
| Cross-cutting concerns and open questions | §12 |
| Anti-patterns we've already learned | §13 |

---

## §1. The V1 operator narrative (plain English)

What it should feel like to use a notebook in V1, end-to-end.

You open an `.llmnb` file in VS Code. The kernel is already running in the background. You see one or more cells from a previous session, each tagged with a small badge in the corner showing which agent ran in it: `alpha · claude-code · idle`.

You write your first directive in a fresh cell:

```
/spawn alpha task:"design a database schema for a recipe app"
```

Hit Enter or click Run. The cell's badge flips to `alpha · claude-code · spawning`, then `active`, then text streams into the cell output — Claude's response, token by token. Tool calls appear inline (a `read_file` here, a `propose_edit` there with a clickable diff). The cell finishes; badge says `idle`. You read alpha's schema. You like it.

You write a second cell — but instead of `/spawn`, you start with `@alpha:` because you want to keep talking to the *same* agent:

```
@alpha: now optimize for read performance assuming 100M recipes
```

Run it. The cell's badge says `alpha · claude-code · active`. Behind the scenes the kernel writes your message to alpha's stdin (alpha is still alive from cell 1). Alpha's response streams into *this* cell. Same conversation, same memory.

You spawn a second agent in cell 3:

```
/spawn beta task:"review alpha's schema for compliance issues"
```

Beta's a fresh agent. But it sees the existing turns from alpha as context — when beta starts thinking, it knows what alpha said. (The kernel feeds alpha's prior turns to beta's session before beta gets your task.) Beta produces a critique. Badge: `beta · claude-code · idle`.

You go back to alpha in cell 4:

```
@alpha: incorporate beta's feedback
```

Same trick — but this time the kernel notices alpha's session hasn't seen beta's turn yet. Before sending your message, it injects beta's reply into alpha's session as context: "Beta said: ...". Then your message. Alpha responds with an updated schema. You didn't have to copy-paste between agents.

Things go off the rails. Alpha's last response was bad. You highlight cell 2 and type:

```
/revert alpha to <turn-id-from-cell-1>
```

Alpha's badge: `runtime_status: idle`. Next time you `@alpha:`, the kernel re-spawns with `--resume` pointed at the pre-bad-turn state. The DAG of turns is preserved (you can branch off the bad turn into a fork later if you want), but alpha's *current head* moves backward.

You want to try a parallel direction:

```
/branch alpha at <turn-id> as gamma
```

Now there are two agents — alpha continues from its current head, gamma is a fork from an earlier turn. You can `@alpha:` and `@gamma:` independently, and the sidebar shows the agent tree: `alpha (5 turns)`, `beta (2 turns)`, `gamma (3 turns, branched from alpha@t_2)`.

You save. Ctrl-S. The notebook serializes — cells, directives, agent emissions, turn DAG, overlay graph, OTLP spans. Close VS Code.

Tomorrow you reopen. The kernel restarts. The extension ships persisted `metadata.rts` to the kernel via the hydrate envelope. Each cell re-renders its previous output from the stored span data. Each idle agent gets re-spawned via `claude --resume <session_id>` so it picks up where it left off. Status badges show `alpha · idle (resumable)` until you `@alpha:` and they go `active` again.

Other UX you get:
- **Search**: Ctrl+F across all cell content (FSP-002).
- **Collapse all / expand all**: toolbar buttons (FSP-002).
- **Interrupt**: every running cell has a stop button → SIGINT to that agent.
- **Sidebar tree views**: zones, agents, recent events. Click an agent to jump to its first cell.
- **Approval flows**: `propose_edit` spans render a `Review diff` button that opens `vscode.diff` with `Approve`/`Reject`.
- **Comment cells** (M1): markdown blocks anywhere, no agent.
- **Annotations** (M2): operator notes attached to specific spans.
- **Promoted cells** (M3): right-click any tool-call output → "Promote to cell" → it becomes a read-only cell of its own.

---

## §2. What a cell IS (data model)

Per BSP-002 §3, the V1 abstractions are:

```
zone (= notebook)
 └── agents.<id>                — mutable refs (head_turn_id, session, runtime_status, last_seen_turn_id)
       └── turns[]              — immutable nodes (id, parent_id, role, body, claude_session_id)
 └── overlays.<id>              — operator edits (overlay graph; second git-style layer)
 └── overlay_refs.<turn_id>     — mutable; points an overlay at a specific turn
 └── cells[].metadata.rts.cell  — render-time cache + cell→turn binding
 └── ordering[]                 — operator-controlled cell display order
 └── blobs.<sha256>             — content-addressed large outputs
 └── event_log[]                — append-only operator-visible event stream
 └── config.recoverable[]       — agents that should re-spawn on hydrate
 └── config.volatile[]          — runtime values not persisted across kernel restarts
```

Key invariants (BSP-002 §2):
1. **Turns are immutable.** Once committed, a turn's id, parent_id, role, body, and claude_session_id never change.
2. **Agents are mutable refs.** `head_turn_id` moves forward (continuation), backward (revert), or sideways (branch). The mutation is what `submit_intent("move_agent_head", ...)` records.
3. **Append-only collections.** turns, overlays, blobs, event_log are append-only. Refs are mutable but only via typed intents (BSP-003 registry).
4. **The cell IS the turn-issuance site.** One cell typically maps to one operator turn (and the agent's response). M3 promoted cells are the exception — they're read-only views of an emitted span.

What a cell physically is in V1:
- A `vscode.NotebookCell` of type `llmnb-cell` (directive cell), `Markup` (comment cell M1), or read-only `llmnb-cell` (promoted cell M3).
- Its **first line** is the directive (`/spawn …`, `@<id>: …`, `/branch …`, `/revert …`, `/stop …`).
- Its **outputs** are bare OTLP/JSON spans per RFC-006 §1, MIME `application/vnd.rts.run+json`.
- Its **metadata** carries `metadata.rts.cell.{turn_id, agent_id, cached_render?}` per BSP-002 §6.

---

## §3. Cell types

| Type | Operator action | Has directive | Has agent | Re-runnable | Persisted |
|---|---|---|---|---|---|
| **Directive cell** (default) | Type `/spawn` or `@<id>` and run | Yes | Yes | Yes | Yes |
| **Comment cell** (M1) | Insert markdown block | No | No | No | Yes |
| **Promoted cell** (M3) | Right-click span → "Promote to cell" | No | Bound to source span's agent | No (read-only) | Yes |
| **Output-only display** (transient) | Auto-created by agents emitting `propose_edit` / `present.artifact` | No | Bound to source span | No | Embedded in source cell unless promoted |

V1 ships directive + comment + promoted. Output-only display is the existing renderer behavior (already shipped).

---

## §4. Cell lifecycle (spawn → continue → … → save → reopen)

Per BSP-002 §4 and BSP-005 slices S2-S6:

```
operator types /spawn alpha task:"X"
  → extension parses directive
  → ships operator.action {action_type: agent_spawn, agent_id: alpha, task: X}
  → kernel.AgentSupervisor.spawn(alpha, X)
       → idempotency check: if alpha is alive, return existing handle (Phase 1)
       → if alpha exists but DEAD: claude --resume <existing_session_id> (Phase 2, S2)
       → else: assign new claude_session_id, claude --session-id=<new>
  → claude streams stdout
  → kernel emits OTLP spans on cell output
  → terminal span: cell shows status

operator types @alpha: Y in a new cell
  → extension parses directive
  → ships operator.action {action_type: agent_continue, agent_id: alpha, text: Y}
  → kernel.AgentSupervisor.send_user_turn(alpha, Y)  [S3]
       → if alpha is idle, resume first
       → write JSON line to alpha's stdin: {"type":"user","message":Y}
       → response streams back as new spans

cross-agent context handoff (S4)
  → when @alpha is sent: kernel walks turn DAG between alpha.last_seen_turn_id and notebook.head
  → for each missed turn (e.g., beta's t_3): inject "Beta said: …" into alpha's session
  → then send the operator's message
  → record alpha.last_seen_turn_id = new turn id

operator types /branch alpha at t_3 as beta (S5)
  → kernel.AgentSupervisor.fork(alpha, t_3, beta)
       → Case A (t_3 is alpha's current head): claude --resume=<alpha_session> --fork-session
       → Case B (t_3 is ancestor): new claude --session-id=<new>, replay turns t_root..t_3 over stdin

operator types /revert alpha to t_2 (S5)
  → SIGTERM alpha (if alive)
  → set agent.head_turn_id = t_2
  → record ref-move event in event_log
  → next @alpha re-spawns via Case B replay

save (Ctrl-S)
  → kernel emits notebook.metadata snapshot (RFC-006 §8 trigger=save)
  → extension's metadata-applier writes metadata.rts onto vscode.NotebookDocument
  → vscode serializes the notebook as JSON via the .llmnb serializer

reopen
  → extension parses .llmnb, extracts metadata.rts
  → ships notebook.metadata mode:"hydrate" envelope to kernel (RFC-006 §8 v2.0.2)
  → kernel.MetadataWriter.hydrate(snapshot)
  → kernel.DriftDetector.compare(snapshot, current_volatile)
  → kernel.AgentSupervisor.respawn_from_config(snapshot.config.recoverable.agents[])
  → kernel emits hydrate_complete confirmation
  → extension renders cells from snapshot's turns + spans
```

---

## §5. Cell-as-agent identity rendering

Per BSP-002 §6 and BSP-005 S1.

Every directive cell renders:
- **Badge** in the cell status bar: `<agent_id> · <provider> · <runtime_status>`. Read from the latest span's `llmnb.agent_id` attribute + the agent's current `runtime_status`.
- **Gutter color**: stable per `agent_id` (same agent → same color across cells, persisted in workspace state so reload preserves).
- **Turn count** (S3+): `alpha · claude-code · idle (5 turns)` once multi-turn is in.
- **Branch indicator** (S5+): branched-from arrow if `agent.parent_id` is set.

The cell's *visible identity* is owned by the LAST emitted span in its outputs. If alpha emits a `notify` span and then later a `report_completion` span, the badge tracks the most recent.

Promoted cells (M3) carry a fixed badge of the source span's agent, with a `(promoted)` suffix.

Comment cells (M1) carry no badge.

---

## §6. Cell directive grammar

Per BSP-002 §3 and the V1 grammar in `extension/src/notebook/cell-directive.ts`:

| Directive | Form | Effect | Slice |
|---|---|---|---|
| `/spawn` | `/spawn <agent_id> task:"<task>"` | Create or rebind an agent | S2 (active today as Phase 1) |
| `@<agent>` | `@<agent_id>: <text>` | Send a continuation turn to existing agent | S3 |
| `/branch` | `/branch <src> at <turn_id> as <new_id>` | Fork a new agent from a turn | S5 |
| `/revert` | `/revert <agent_id> to <turn_id>` | Move agent's head_turn_id backward | S5 |
| `/stop` | `/stop <agent_id>` | Clean SIGTERM; agent goes idle | S5 |

Open spec ambiguities (flagged in BSP-005 §4):
- **Multi-line directives**: V1 grammar is single-line per directive; no embedded newlines in the task string.
- **Embedded escaped quotes** in `task:"..."`: not supported in V1; use a comment cell for long prompts and reference it.
- **Agent ID character set**: `[a-z][a-z0-9_]*` per RFC-002 (not formally specified; empirically what works).

---

## §7. Cross-agent context handoff (BSP-002 §4.6)

The shared-notebook axiom (BSP-002 §1) means an agent's claude session can fall behind the notebook's truth. The handoff rule:

```
On @<agent_id>: <message>:
  missed = turns AFTER agent.last_seen_turn_id in the notebook's chronological order
  for t in missed:
    feed to agent.claude_session as: "<role from t.agent_id>: <t.body>"
  send the new operator <message>
  capture the agent's response as the new turn
  agent.last_seen_turn_id = new turn id
  agent.head_turn_id = new turn id
```

Handoff messages are NOT separate turns in the DAG. They're transient context injection. The DAG records only the operator's message and the agent's reply. Replay is deterministic: re-running the zone replays the same handoffs from the same DAG.

If the target agent's process is `idle` or `exited`, the kernel re-spawns it (S2 plumbing) before performing the handoff.

---

## §8. Persistence — saving and reopening

Per RFC-005 (file format) and RFC-006 §8 (wire envelope `notebook.metadata mode:"hydrate"`).

**Save flow**: kernel emits `mode:"snapshot"` envelopes on triggers (`save | shutdown | timer | end_of_run`). Extension's metadata-applier writes them to the `vscode.NotebookDocument.metadata` via `vscode.WorkspaceEdit.updateNotebookMetadata`. VS Code's serializer turns the in-memory notebook into the on-disk `.llmnb` JSON.

**Reopen flow**: extension parses `.llmnb`, extracts `metadata.rts`, ships `notebook.metadata mode:"hydrate"` envelope to kernel (RFC-006 v2.0.2). Kernel runs:
1. `MetadataWriter.hydrate(snapshot)` — replaces in-memory state
2. `DriftDetector.compare(snapshot, current_volatile)` — flags any volatile-state drift
3. `AgentSupervisor.respawn_from_config(snapshot.config.recoverable.agents[])` — restores idle agents via `--resume`
4. Emits confirmation `mode:"snapshot" trigger:"hydrate_complete"` envelope

**Cell rendering on reopen**: cells are restored from the snapshot's `cells[].metadata.rts.cell.turn_id` linkage. The renderer reads each cell's bound turn and re-renders the OTLP spans from `agents.<id>.turns[<turn_id>].spans[]`.

**Forbidden secrets**: `metadata.rts.config` cannot carry api_key / token / password / authorization fields. Per RFC-005 forbidden-fields rule and metadata-loader's secret scan (refuses to ship hydrate if found).

---

## §9. Slice ladder (BSP-005 + M-additions)

Reproduced here for at-a-glance reference. Full detail in [BSP-005-cell-roadmap.md](BSP-005-cell-roadmap.md).

| # | Slice | Days | Owner | Depends on |
|---|---|---|---|---|
| **S1** | Cell-as-agent identity badges | 0.5 | X-EXT | nothing |
| **M1** | Comment cells (markdown, no agent) | 0.5 | X-EXT | S1 |
| **S2** | Persistent Claude Phase 2 (`--resume`) | 0.4 | K-AS | nothing |
| **S3** | Multi-turn cells via `@<agent>` | 1.0 | K-AS + X-EXT | S2 |
| **S4** | Cross-agent context handoff | 1.5 | K-AS | S2 + S3 |
| **S5** | `/branch`, `/revert`, `/stop` | 2.0 | K-AS + X-EXT | S2-S4 |
| **S6** | Cell-to-turn binding write-back | 1.0 | K-MW + X-EXT | S2-S5 |
| **M2** | Span annotations | 0.5 | K-MW + X-EXT | S6 |
| **M3** | Tool-call cells (promoted outputs) | 1.0 | K-MW + X-EXT | S6 + S7 |
| **S7** | Sidebar Activity Bar (zones/agents/events trees) | 1.0 | X-EXT | S6 |
| **M4** | Per-agent inspection panel | 0.5 | X-EXT | S7 |
| **S8** | Inline `vscode.diff` for `propose_edit` | 0.5 | X-EXT | S3 |
| **S9** | Streaming + interrupt button | 0.5 | K-AS + X-EXT | S2 |
| **S10** | Three-pane mental model + FSP-002 search/collapse | 1.0 | X-EXT | everything else |
| ~~S11~~ | FSP-001 cells → OpenUI | — | deferred V2 | — |
| ~~M5~~ | Directory-mirroring import/export | — | deferred V2 | — |

**Total V1 UX runway**: ~12-13 working days (parallelizable to ~7-8 wall-clock with 2-3 agents).

**Recommended next pair (file-disjoint)**:
- **S1** (extension only — badges from existing wire data)
- **S2** (kernel only — `--resume` plumbing in `AgentSupervisor`)

Both small, both file-disjoint, biggest visible gap closed.

---

## §10. Scratch-inspired additions (M-series)

Recap of how Scratch's mental model maps:

| Scratch | Our equivalent |
|---|---|
| Sprite | Agent (its scripts/data live under `metadata.rts.zone.agents.<id>`) |
| Stage | Notebook (the visible canvas — cells in display order) |
| Comment block (yellow sticky) | Comment cell (M1) + span annotations (M2) |
| Per-sprite project.json | Per-agent subtree under `agents.<id>` |
| Tool blocks vs control blocks | Output-only / promoted cells (M3) vs directive cells |
| Sprite inspection (double-click) | Per-agent panel (M4) |
| Sprite costumes / sounds | (Future V2+: agent-specific assets) |

**M5 directory-mirroring** comes from BSP-002 §8: the convertibility invariant says `.llmnb` (single JSON file) ↔ directory of files (one subtree per agent). Useful for git diffs, manual editing, multi-tool workflows. Deferred to V2 explicitly per BSP-002.

---

## §11. Future / V2+ cell concepts

| Concept | Spec | Why V2 |
|---|---|---|
| Cells → OpenUI button | FSP-001 | Requires V1 substrate stable; UX research on generative-vs-structural form-gen |
| In-cell search + collapse all | FSP-002 | UX polish; not blocking V1 ship |
| Graph view sidebar (top-to-bottom mirror of cell list) | BSP-002 §11 | Second rendering of `metadata.rts.zone`; needs S7 first |
| Overlay graph (operator edits as second git-style layer) | BSP-002 §12 | Requires the turn DAG (S6) to be materialized first |
| Multi-operator on one notebook | BSP-002 §"V3+ forward-compat" | V3 — needs CRDT or coordination layer |
| Multi-kernel writing to one notebook | BSP-003 §"V3 forward-compat" | V3 — same |
| Edit-and-resend with branching | RFC-005 (deferred to git) | Intentional non-feature; operator uses VS Code's git instead |

---

## §12. Cross-cutting concerns and open questions

### 12.1 Render-time heaviness as cells accumulate turns
Once S3 lands, a single cell may carry tens of OTLP spans. Current renderer parses every span on every render. Mitigation queued for S6: cell metadata cache (`metadata.rts.cells[<id>].metadata.rts.cell.cached_render`).

### 12.2 Operator vs agent ownership of cell text
- **Append model** (V1): operator owns the cell's first line (directive); agent appends responses below as outputs.
- **Conversation model** (future): cell renders as a chat transcript with operator + agent turns interleaved.

V1 picks append. FSP-001 OpenUI is a third-flavor answer.

### 12.3 Multi-cell zones running the same agent
If alpha's `/spawn` is in cell 1 and operator sends `@alpha` from cell 5: response lands in cell 5 (BSP-002 §6 implicit). The agent identity is the link, not the cell.

### 12.4 NotebookCellExecution model and multi-turn
Current controller maps one `executeCell` call to one terminal span. Multi-turn cells (S3) either re-execute the cell on every continuation OR keep the cell idle and let new turns flow into outputs. (b) is cleaner but doesn't match VS Code's execution model. **Worth a §3.x amendment to BSP-002.**

### 12.5 Directive vs `metadata.rts` source-of-truth
Cell's first line carries the directive, but `metadata.rts.cells[<id>].metadata.rts.cell.directive` could also store it. If they diverge (operator edits the cell but doesn't re-run), which wins? V1 answer: the cell's text is the working copy; metadata.rts.cell.directive is updated only on a successful run via `set_cell_metadata` intent.

### 12.6 Comment cell persistence under hydrate
Markdown cells aren't bound to a turn. They have no `metadata.rts.cell.turn_id`. Hydrate must preserve them by index/ordering. Spec ambiguity flagged.

### 12.7 Promoted cell uniqueness
What happens if the operator promotes the same span twice? V1 answer: idempotent — second promotion no-ops (writer's `submit_intent` deduplicates by promoted span_id). Worth verifying the writer registry actually does this.

---

## §13. Anti-patterns (already learned)

These come from the session's debugging cycles. Reading these saves repeating the failure.

### 13.1 RLock on the logging path (Engineering Guide §11.7)
Any module-level lock that emits a log record from inside its critical section MUST be `threading.RLock`, not `threading.Lock`. The OTLP data-plane handler routes log records through SocketWriter, which holds its own lock; non-reentrant locks deadlock under live wiring. Found via 50-min test hang.

### 13.2 Workspace settings shadow Global update (Engineering Guide §11.8)
A test fixture's `.vscode/settings.json` ALWAYS wins over `getConfiguration().update(..., ConfigurationTarget.Global)`. Don't pin a value in the workspace fixture if tests need to override it. Rely on the package.json default.

### 13.3 BSP-004 V1 / V2 (BSP-004 issue 2 retrospective)
Running `_run_read_loop` on a thread-pool executor (V1) regressed Tier 4 e2e. Running it on a dedicated `threading.Thread` driven by uvicorn lifespan (V2) regressed differently (proxy startup `FileNotFoundError`). Both fixes deferred to legacy `main()` for V1 ship; V3 sock_recv-based design queued (BSP-006 if uvicorn-replacement is the path).

### 13.4 Windows handle inheritance for sockets
`socket.socket()` on Windows returns inheritable handles by default. When the kernel spawns Claude, the child inherits the data-plane socket FD. Fix: `sock.set_inheritable(False)` immediately after creation. Already shipped in `socket_writer.py`.

### 13.5 PATH propagation extension → kernel
node-pty captures Extension Host's `process.env.PATH` at spawn time. Mutations after spawn don't propagate. RFC-009 §4.2 specifies the discovery contract (env > PATH > pixi-env probe); the kernel side uses `zone_control.locate_*_bin()` so PATH can be undefined and binaries still resolve.

### 13.6 Stub kernel race in `onRunComplete`
Original controller deleted from `inflight` map AFTER awaiting `appendOutput`. Sync fallback in `runOne()` saw `inflight.has(cellKey) === true` and called `exec.end(false)` before the async commit. Fix: synchronously delete from `inflight` at top of `onRunComplete`. Live kernel doesn't hit this because `PtyKernelClient.executeCell` awaits the terminal span.

### 13.7 Don't use `subprocess.Popen("mitmdump", ...)` directly
Use `zone_control.locate_mitmdump_bin()` per RFC-009 §4.2. Same applies to any binary the kernel spawns.

### 13.8 NEVER log secrets, even in debug
RFC-009 §4.4 + zone_control's `_record()` redacts credential values to `<set>` / `<unset>` in marker file emissions. Apply this discipline everywhere: secrets are env-only, never logged, never persisted in settings or `metadata.rts.config`.

---

## §14. How agents should use this doc

When dispatched for cell-related work:

1. **Read §0 quick-find** to locate what you need.
2. **Read §1 narrative** if you've never worked on cells before — it grounds the rest.
3. **Read §2-§8** when implementing the slice you've been assigned.
4. **Read §9** to understand which slice depends on which.
5. **Read §12 and §13** before coding — many implementation choices already have a "right answer" surfaced from prior debugging.
6. **When the doc and a spec disagree, the spec wins.** This doc summarizes; specs are authoritative. If you find a discrepancy, flag it in your report.
7. **When this doc is incomplete or out of date, flag that too.** The KB is meant to drift with the project; keeping it current is a shared responsibility.

---

## §15. Session chronology — how this doc came to exist

This doc was distilled from the 2026-04-26..28 working sessions. Rough chronology of cell-related decisions:

1. **2026-04-26**: V1 hero loop (`/spawn` works) lands. `b4ec3e3` controller race fix; `e26a352` FSP-003 typed-wait scaffolding.
2. **2026-04-27**: BSP-002 conversation graph specified (turns + agents-as-refs). BSP-003 writer registry. BSP-004 kernel runtime under uvicorn. FSP-001 cells → OpenUI. FSP-002 in-cell search.
3. **2026-04-27 (late)**: BSP-002 §4 Phase 1 lands (claude_session_id + idempotency). 4 new tests; kernel pytest 317/0.
4. **2026-04-28 (overnight)**: K-AS/K-CM vocab reconciled. FSP-003 typed-wait refactor finalized. Tier 4 e2e fix lands via socket inheritability + revert to legacy `main()`.
5. **2026-04-28 (morning)**: Workspace useStub override bug found and fixed (Engineering Guide §11.8). RFC-009 zone_control + module shipped. mitmdump discovery extension. Tier 4 finally green 4/4.
6. **2026-04-28 (afternoon)**: BSP-005 cell roadmap written; BSP-006 embedded ASGI sketched. The plain-English V1 narrative (§1 of this doc) is composed and reviewed. Scratch-inspired additions (M1-M5) flagged as missing from BSP-005. This KB doc consolidates everything.

If you're picking up the project at a later date, search this doc for the slice you're picking up; if the slice is in §9's table and not yet shipped, the work to do is precisely what §2-§8 describe.

---

## Changelog

- **2026-04-28**: initial. Distilled from session transcript. §1 narrative + §2-§8 reference + §9 slice table + §10-§11 future work + §12 open questions + §13 anti-patterns + §14 agent usage guide + §15 chronology.
