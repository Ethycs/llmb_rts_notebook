# Knowledge base: cells and notebooks

**Status**: Living reference, 2026-04-28 — reborn as a navigation index after the atom refactor.
**Audience**: agents picking up cell-related work; future-self at session start.
**Purpose**: navigation surface only. Definitions live in [docs/atoms/](../atoms/). Behavior + wire formats live in the relevant BSP / RFC. This doc is a pointer index — when a section says "see X," go there.

This doc is NOT a spec. Specs win on conflict. Atoms win on definitions.

> **History**: this doc was a 434-line prose reference until 2026-04-28, when the [atom refactor](PLAN-atom-refactor.md) moved every concept definition into [docs/atoms/](../atoms/) and the file was deleted in `4207504`. An empirical A/B/C test (atoms-only vs. original prose vs. ref-only) showed the prose version actively misled agents on specific cell ops (it omitted `split_cell` from its index entirely), while the ref-only form gave agents fast navigation plus the rigor of cross-atom synthesis. This file is the surviving ref-only form, restored as the reborn KB.

---

## §0. Quick-find index

| If you need to know about... | Read this first |
|---|---|
| The full V1 operator narrative (plain English) | §1 of this doc (unique illustrative content) |
| What a cell IS (data model) | [atoms/concepts/cell](../atoms/concepts/cell.md) + [BSP-002 §3](BSP-002-conversation-graph.md#3-cell-directive-grammar) |
| Cell types (kinds enum) | [atoms/concepts/cell-kinds](../atoms/concepts/cell-kinds.md) |
| Sections (operator narrative range) | [atoms/concepts/section](../atoms/concepts/section.md) |
| Turns (immutable agent truth) | [atoms/concepts/turn](../atoms/concepts/turn.md) |
| Sub-turns (merge artifact) | [atoms/concepts/sub-turn](../atoms/concepts/sub-turn.md) |
| Spans + tool calls + atomicity | [atoms/concepts/span](../atoms/concepts/span.md), [atoms/concepts/tool-call](../atoms/concepts/tool-call.md), [atoms/discipline/tool-calls-atomic](../atoms/discipline/tool-calls-atomic.md) |
| Cell lifecycle (spawn → continue → branch → revert → save → reopen) | [atoms/operations/](../atoms/operations/) + [BSP-002 §4](BSP-002-conversation-graph.md#4-persistent-agent-lifecycle) |
| Cell-to-agent binding, identity rendering | [atoms/concepts/agent](../atoms/concepts/agent.md) + [BSP-002 §6](BSP-002-conversation-graph.md#6-cell-as-agent-issuance-scope) + [BSP-005 S1](BSP-005-cell-roadmap.md) |
| Cell directive grammar | [BSP-002 §3](BSP-002-conversation-graph.md#3-cell-directive-grammar) + the operations atoms |
| Cross-agent context handoff | [BSP-002 §4.6](BSP-002-conversation-graph.md#46-cross-agent-context-handoff) + [atoms/concepts/context-manifest](../atoms/concepts/context-manifest.md) |
| Persistence — saving and reopening | [RFC-005](../rfcs/RFC-005-llmnb-file-format.md) + [RFC-006 §8](../rfcs/RFC-006-kernel-extension-wire-format.md) + [atoms/discipline/save-is-git-style](../atoms/discipline/save-is-git-style.md) |
| Slice ladder (what to implement, in what order) | [BSP-005](BSP-005-cell-roadmap.md) |
| Scratch-inspired additions (comment, annotation, promoted cells) | [BSP-005](BSP-005-cell-roadmap.md) M1-M5 |
| Future / V2+ cell concepts (OpenUI, search, graph view) | [FSP-001](FSP-001-cells-to-openui.md), [FSP-002](FSP-002-cell-search-collapse.md), [BSP-002 §11](BSP-002-conversation-graph.md) |
| Cell Manager façade (split/merge/move/promote ownership) | [atoms/discipline/cell-manager-owns-structure](../atoms/discipline/cell-manager-owns-structure.md) |
| Overlay commits (operator edits as second git layer) | [atoms/concepts/overlay-commit](../atoms/concepts/overlay-commit.md) + [BSP-007](BSP-007-overlay-git-semantics.md) |
| ContextPacker + RunFrames | [atoms/concepts/context-manifest](../atoms/concepts/context-manifest.md), [atoms/concepts/run-frame](../atoms/concepts/run-frame.md) + [BSP-008](BSP-008-contextpacker-runframes.md) |
| 24 V1 decisions (D1-D8, S1-S6, M1-M3, SD1-SD3, CK1-CK3, F1) | [atoms/decisions/](../atoms/decisions/) + [PLAN-atom-refactor.md §4](PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms) |
| Anti-patterns we've already learned | [atoms/anti-patterns/](../atoms/anti-patterns/) |
| Cross-cutting concerns and open questions | §12 of this doc (unique unresolved-thread tracker) |
| Session chronology | §15 of this doc (unique historical record) |

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

Other UX you get: search, collapse-all, interrupt button, sidebar trees, approval flows, comment cells (M1), annotations (M2), promoted cells (M3) — see [BSP-005](BSP-005-cell-roadmap.md) for the full slice ladder.

---

## §2-§8. Definitions & lifecycle — see atoms

| Topic | Atoms | Spec |
|---|---|---|
| Data model — cells, turns, agents, sections, sub-turns | [cell](../atoms/concepts/cell.md), [turn](../atoms/concepts/turn.md), [agent](../atoms/concepts/agent.md), [section](../atoms/concepts/section.md), [sub-turn](../atoms/concepts/sub-turn.md), [zone](../atoms/concepts/zone.md), [span](../atoms/concepts/span.md), [blob](../atoms/concepts/blob.md), [artifact-ref](../atoms/concepts/artifact-ref.md) | [BSP-002 §2-§3](BSP-002-conversation-graph.md), [RFC-005](../rfcs/RFC-005-llmnb-file-format.md) |
| Cell types | [cell-kinds](../atoms/concepts/cell-kinds.md) | [BSP-002 §13.2](BSP-002-conversation-graph.md) |
| Lifecycle ops | [spawn-agent](../atoms/operations/spawn-agent.md), [continue-turn](../atoms/operations/continue-turn.md), [branch-agent](../atoms/operations/branch-agent.md), [revert-agent](../atoms/operations/revert-agent.md), [stop-agent](../atoms/operations/stop-agent.md) | [BSP-002 §4](BSP-002-conversation-graph.md#4-persistent-agent-lifecycle), [BSP-005 S2-S5](BSP-005-cell-roadmap.md) |
| Cell-as-agent identity rendering | [agent](../atoms/concepts/agent.md), [cell](../atoms/concepts/cell.md) | [BSP-002 §6](BSP-002-conversation-graph.md), [BSP-005 S1](BSP-005-cell-roadmap.md) |
| Directive grammar | (no atom — grammar is BSP-002 §3) | [BSP-002 §3](BSP-002-conversation-graph.md#3-cell-directive-grammar) |
| Cross-agent context handoff | [context-manifest](../atoms/concepts/context-manifest.md) | [BSP-002 §4.6](BSP-002-conversation-graph.md) |
| Persistence (save/hydrate) | [save-is-git-style](../atoms/discipline/save-is-git-style.md), [no-rebind-popen](../atoms/decisions/no-rebind-popen.md) | [RFC-005](../rfcs/RFC-005-llmnb-file-format.md), [RFC-006 §8](../rfcs/RFC-006-kernel-extension-wire-format.md) |
| Overlay commits & cell structural ops | [overlay-commit](../atoms/concepts/overlay-commit.md), [split-cell](../atoms/operations/split-cell.md), [merge-cells](../atoms/operations/merge-cells.md), [move-cell](../atoms/operations/move-cell.md), [promote-span](../atoms/operations/promote-span.md), [apply-overlay-commit](../atoms/operations/apply-overlay-commit.md), [cell-manager-owns-structure](../atoms/discipline/cell-manager-owns-structure.md) | [BSP-007](BSP-007-overlay-git-semantics.md) |
| Run framing & context | [context-manifest](../atoms/concepts/context-manifest.md), [run-frame](../atoms/concepts/run-frame.md), [v1-contextpacker-walk](../atoms/decisions/v1-contextpacker-walk.md), [v1-runframe-minimal](../atoms/decisions/v1-runframe-minimal.md) | [BSP-008](BSP-008-contextpacker-runframes.md) |

---

## §9. Slice ladder

See [BSP-005](BSP-005-cell-roadmap.md). Recommended next pair: **S1** (cell-as-agent badges, X-EXT only) + **S2** (persistent Claude Phase 2 `--resume`, K-AS only). File-disjoint, biggest visible UX gap.

---

## §10. Scratch-inspired additions

See [BSP-005](BSP-005-cell-roadmap.md) M1-M5 mapping (Sprite→Agent, Stage→Notebook, comment-block→comment cell, etc.). M5 directory-mirroring is V2 per [BSP-002 §8](BSP-002-conversation-graph.md).

---

## §11. Future / V2+

See [FSP-001](FSP-001-cells-to-openui.md), [FSP-002](FSP-002-cell-search-collapse.md), [BSP-002 §11](BSP-002-conversation-graph.md), [atoms/decisions/capabilities-deferred-v2](../atoms/decisions/capabilities-deferred-v2.md), [atoms/decisions/asgi-deferred](../atoms/decisions/asgi-deferred.md).

---

## §12. Cross-cutting concerns and open questions

These are unresolved discussion threads NOT yet pinned in atoms or specs. Keep this section live.

### 12.1 Render-time heaviness as cells accumulate turns
Once S3 lands, a single cell may carry tens of OTLP spans. Mitigation queued for S6: cell metadata cache (`metadata.rts.cells[<id>].metadata.rts.cell.cached_render`).

### 12.2 Operator vs agent ownership of cell text
- **Append model** (V1): operator owns the cell's first line (directive); agent appends responses below as outputs.
- **Conversation model** (future): cell renders as a chat transcript with operator + agent turns interleaved.
- V1 picks append. [FSP-001](FSP-001-cells-to-openui.md) OpenUI is a third-flavor answer.

### 12.3 Multi-cell zones running the same agent
If alpha's `/spawn` is in cell 1 and operator sends `@alpha` from cell 5: response lands in cell 5 (BSP-002 §6 implicit). The agent identity is the link, not the cell.

### 12.4 NotebookCellExecution model and multi-turn
Current controller maps one `executeCell` call to one terminal span. Multi-turn cells (S3) either re-execute the cell on every continuation OR keep the cell idle and let new turns flow into outputs. (b) is cleaner but doesn't match VS Code's execution model. **Worth a §3.x amendment to BSP-002.**

### 12.5 Directive vs `metadata.rts` source-of-truth
Cell's first line carries the directive, but `metadata.rts.cells[<id>].metadata.rts.cell.directive` could also store it. If they diverge (operator edits the cell but doesn't re-run), which wins? V1 answer: the cell's text is the working copy; metadata.rts.cell.directive is updated only on a successful run via `set_cell_metadata` intent.

### 12.6 Comment cell persistence under hydrate
Markdown cells aren't bound to a turn. They have no `metadata.rts.cell.turn_id`. Hydrate must preserve them by index/ordering. **Spec ambiguity flagged.**

### 12.7 Promoted cell uniqueness
What happens if the operator promotes the same span twice? V1 answer: idempotent — second promotion no-ops (writer's `submit_intent` deduplicates by promoted span_id). Worth verifying the writer registry actually does this.

---

## §13. Anti-patterns

See [atoms/anti-patterns/](../atoms/anti-patterns/) — RLock-on-logging, workspace-shadows-global, BSP-004 retrospective, Windows FD inheritance, PATH propagation, stub-kernel-race, secret-redaction, mitmdump-discovery.

---

## §14. How agents should use this doc

1. **Read §0 quick-find** to locate what you need.
2. **Read §1 narrative** if you've never worked on cells before.
3. **Follow links to atoms** for definitions / invariants / decisions.
4. **Follow links to specs (BSP / RFC / FSP)** for behavior / wire formats / interactions.
5. **Read §12** for unresolved threads — many implementation choices already have a "right answer" surfaced.
6. **Spec wins on conflict.** Atom wins on definition. This doc is a pointer index — never authoritative.
7. **Flag drift** in your report if you find an atom or spec out of date with reality.

---

## §15. Session chronology — how this doc came to exist

This doc was distilled from the 2026-04-26..28 working sessions. Rough chronology of cell-related decisions:

1. **2026-04-26**: V1 hero loop (`/spawn` works) lands. `b4ec3e3` controller race fix; `e26a352` FSP-003 typed-wait scaffolding.
2. **2026-04-27**: BSP-002 conversation graph specified. BSP-003 writer registry. BSP-004 kernel runtime under uvicorn. FSP-001 cells → OpenUI. FSP-002 in-cell search.
3. **2026-04-27 (late)**: BSP-002 §4 Phase 1 lands (claude_session_id + idempotency). 4 new tests; kernel pytest 317/0.
4. **2026-04-28 (overnight)**: K-AS/K-CM vocab reconciled. FSP-003 typed-wait refactor finalized. Tier 4 e2e fix lands via socket inheritability + revert to legacy `main()`.
5. **2026-04-28 (morning)**: Workspace useStub override bug found and fixed. RFC-009 zone_control + module shipped. Tier 4 finally green 4/4.
6. **2026-04-28 (afternoon)**: BSP-005 cell roadmap written; BSP-006 embedded ASGI sketched. The plain-English V1 narrative (§1 of this doc) composed. Scratch-inspired additions (M1-M5) flagged. Original KB-cells consolidated.
7. **2026-04-28 (evening)**: PLAN-atom-refactor written. Phase 1+3+4 atoms shipped. Original prose KB-cells deleted in commit `4207504`. A/B/C empirical test confirmed the atoms refactor (prose form misled agents; atoms gave correct plans; ref-only form caught real spec drift). KB-cells restored as ref-only navigation index — definitions stay in atoms.

If you're picking up the project later, browse [docs/atoms/](../atoms/) by category and follow links into the specs cited.

---

## Changelog

- **2026-04-28**: reborn as ref-only navigation index. Drops prose definitions in §2-§11 + §13 (now in [docs/atoms/](../atoms/)); keeps §1 narrative, §12 open questions, §15 chronology as the unique illustrative/historical content. 201 lines vs original 434. Promoted from empirical A/B/C test in `docs/_ab-test/`.
