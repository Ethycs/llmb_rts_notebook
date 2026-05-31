# LLMNB Versioning Roadmap

**Status**: 2026-04-27
**Purpose**: pin the meaning of V1/V2/V3/V4 so every BSP, RFC, and code comment uses the same axes.

This is the single reference for version scope. When a doc says "V2 ships X," the meaning is fixed here.

## V1 — Core functionality

The complete substrate. Operator can run multi-turn conversations against persistent agents, branch and revert, overlay agent outputs without losing originals, and trust the file format to round-trip cleanly. Everything in BSP-002 §2 (data model), §3 (cell directives), §4 (lifecycle), §5 (session strategy), §6 (cell-as-agent-identity), §8 (storage), §12 (overlay graph) ships here. BSP-003 (writer registry) ships here. The hero loop passes Tier 4 (already done — Phase 1 of the current session).

**Scope:**
- Persistent agents via claude `--resume`/`--session-id` (BSP-002 §4)
- Conversation graph (turns immutable; agents are refs)
- Cross-agent context handoff (BSP-002 §4.6)
- Overlay graph for operator edits (BSP-002 §12)
- Writer registry + intent envelopes (BSP-003)
- Cell-as-agent-identity rendering (badge per cell)
- Enter-to-execute-spawn-and-focus UX (BSP-002 §11 ref note)
- File format JSON layout that mirrors directory layout 1:1 (BSP-002 §8)
- Single kernel, single extension, single operator

**Out of scope (deferred):**
- Graph view as DAG (vertical-list mirror only — V2)
- Branch switcher UI (the data structure exists; V2 ships the picker)
- Overlay editor UI polish (V1 ships the data; V2 ships the editor)

## V2 — UI / utility / graph push

The operator-facing polish layer. Same data, much better surfaces. The "lift" property pays off: the V1 substrate is read by richer renderers and edited through dedicated UIs.

**Scope:**
- Graph view lifts to DAG visualization (BSP-002 §11.2)
- Branch switcher (click a fork point in the graph view → notebook re-renders that branch via `ordering[]` rewrite)
- Overlay editor panel (right-click cell → "Add overlay" → kind picker, content editor, `context_modifying` checkbox)
- Sidebar features: search, filter by agent/kind, jump-to-cell, breadcrumbs
- Utility commands: "Stop all agents", "Show conversation as markdown", "Export turn DAG to graphviz"
- Cell decorations get richer (status, time-since-last-message, runtime indicators)
- Better failure-mode surfacing (K20–K42 land in the operator's eyeline, not just markers)

**Out of scope:**
- RTS-style command-and-control (V3)
- Multi-anything (V4)

## V3 — RTS-style control

Notebook becomes a real-time-strategy command surface. The operator supervises a fleet of agents working in parallel, issues commands across them, watches KPIs, intervenes selectively. The notebook stops being primarily a chat log and becomes primarily a control panel — the chat log is one of several views.

**Scope:**
- Multi-zone overview (one operator, many notebooks open, fleet view across them)
- Real-time KPIs per agent (token spend, time-on-task, tool-call rate, success/failure indicators)
- Bulk commands ("pause all", "stop all in zone X", "shift task ownership from alpha to beta")
- Operator interrupt flows that feel instant (sub-second SIGINT delivery; cell streaming pause/resume)
- Alerts and triggers ("notify me when alpha finishes", "auto-stop if cost exceeds $X")
- Agent-as-citizen view: each agent has a profile (history, performance, current task) viewable independently of any notebook
- Possibly: scripting layer for operator macros

**Out of scope:**
- Multi-operator coordination (V4)
- Multi-kernel writes to the same notebook (V4)

## V4 — Multi everything

Distributed substrate. Multiple operators on different machines, each running their own kernel(s), all editing the same notebooks.

**Scope:**
- Multi-kernel writes to one notebook (coordination via the intent envelope from BSP-003 §3, with a coordination layer added in front of the queue)
- Multi-operator concurrent editing (CRDT or OT on the append-only data model; refs use LWW + vector clocks)
- Distributed durability (replicated `metadata.rts.zone` storage; intent log shipping between replicas)
- Permission model (who can spawn agents, who can edit overlays, who can revert)
- Audit trail (every intent attributed to an operator identity)
- Possibly: federated zones (one notebook viewable across operators with different agent roster perms)

**Why V4 is large:** the V1 simplifications BSP-003 §9 lists collapse into hard problems here. Each gets its own RFC.

## Forward-compat invariants

Things V1 commits to NEVER break, so V2/V3/V4 can build cleanly:

1. **Append-only data model.** Turns are immutable; overlays are version-chained; blobs are content-addressed. CRDTs and OT are feasible because of this.
2. **Intent envelope pattern (BSP-003 §3).** All writes are typed intents. V4's coordination layer wraps the V1 queue without changing the wire schema.
3. **Single canonical writer per zone (V1) → consensus winner per zone (V4).** The discipline is the same; the implementation changes.
4. **JSON↔directory convertibility (BSP-002 §8.1).** V2 may ship the directory format spec (RFC-005 v2); the JSON shape doesn't change.
5. **Two-graph stack (computation + overlays).** The composition rule (BSP-002 §12.4) holds. V3/V4 add coordination metadata but don't restructure the layers.

## Cross-references

| BSP / RFC | Version | What it adds |
|---|---|---|
| BSP-001 | V1 (already shipped) | Anthropic proxy lifecycle |
| BSP-002 | V1 | Conversation graph, cells, agents, overlays, views |
| BSP-003 | V1 | Writer registry + intent envelopes |
| RFC-001..008 | V1 (mostly shipped) | Wire transport, file format, kernel-extension protocol |
| RFC-005 v2 | V2 | Directory file format (deferred per BSP-002 §8) |
| (TBD) | V3 | RTS control surface RFCs |
| (TBD) | V4 | Distributed coordination RFCs |

## Changelog

- **2026-04-27**: initial. Roadmap pinned per operator direction (V1=core, V2=UI/graph, V3=RTS, V4=multi).
