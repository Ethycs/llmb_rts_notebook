# BSP-002: Conversation Graph and Agent Refs

**Status**: Issue 2 — Draft, 2026-04-28 (amends Issue 1, 2026-04-27)
**Supersedes**: One-shot `/spawn` cell directive grammar (RFC-006 §6 v2.0.3); the per-cell ephemeral agent model in `agent_supervisor.spawn`
**Related**: BSP-001 (proxy lifecycle), RFC-005 (`.llmnb` file format), RFC-006 (wire format), BSP-005 (cell roadmap), BSP-007 (overlay git semantics — sibling), BSP-008 (ContextPacker + RunFrames — sibling), KB-notebook-target.md §0 (V1 amendments source)

## 1. Scope

This BSP specifies how cells, agents, and turns relate. It answers five questions left ambiguous in V1's one-shot cell-spawn model:

1. **What is a zone?** — one notebook = one zone. Each `.llmnb` file is its own zone; the file is the canonical record.
2. **Can different cells use different agents/providers?** — yes. Cells declare which agent (and provider) they target. Cells with no agent declaration extend the most recently used agent.
3. **What context does a cell see?** — the linear prefix of all turns above it in the notebook, regardless of which agent produced each. The notebook is a single shared transcript that all agents read from.
4. **Can the operator branch and revert?** — yes, with git-style ref semantics on agents (BSP-002 v1.x defines the data model; full UX for branch-switching ships V2+).
5. **Where is the canonical record?** — the `.llmnb` file (`metadata.rts.zone`). The agent is a runtime executor; the notebook is the score.

**Core axioms:**

- **Zone = notebook.** No sub-zone or cross-zone concept in V1. The kernel's existing `zone_id` (RFC-006 §1) maps to the notebook's session_id.
- **Notebook is linear.** Turns are appended in cell-execution order. Every cell's context is the prefix of all turns above it.
- **Agents are per-zone.** All agent refs live within one notebook. There is no notion of "agent alpha across notebooks."
- **The notebook is single-truth; agent claude-sessions are caches.** When the cache and truth diverge (another agent contributed a turn the cache doesn't know about), the kernel reconciles by feeding the missed turns to the agent before the new user turn.

## 2. Data model — git for the notebook's turn DAG

Two immutable + mutable concepts, mirroring git's commits and refs:

| Concept | Mutability | Stored at | Analog |
|---|---|---|---|
| `turn` | immutable | `metadata.rts.zone.turns[]` | git commit |
| `agent` | mutable head ref | `metadata.rts.zone.agents[]` | git branch ref |

The zone (notebook) IS the connected DAG. There is no separate "conversation" entity — the zone is the only conversation. Multiple agents within the zone share the turn DAG; each agent has its own ref pointing into it.

### 2.1 Turn

A `turn` is one operator-or-agent message contributed to the notebook. Immutable once persisted.

```json
{
  "id": "t_01HZX7K3...",
  "parent_id": "t_01HZX7J9..." | null,
  "agent_id": "alpha" | null,
  "provider": "claude-code",
  "claude_session_id": "9d4f-..." | null,
  "role": "operator" | "agent" | "system",
  "body": "the text typed into the cell, or the agent's response summary",
  "spans": [...],
  "cell_id": "vscode-notebook-cell:.../#abc",
  "created_at": "2026-04-27T17:30:00Z"
}
```

`parent_id: null` denotes the zone's root turn. `parent_id` defines the DAG; the linear "mainline" is the chain of turns reachable from the document's last cell by following `parent_id` backward. Multiple turns sharing one parent are sibling branches (V2+ for branch-switching UX).

`agent_id` identifies which agent produced or received the turn. `null` for operator turns that target the most-recent agent (the kernel resolves the target at execution time and rewrites this field on persistence).

`provider` is the runtime that produced the agent turn (`claude-code` for V1; `gpt-cli`, `gemini`, `ollama` reserved for V2+). Operator turns carry the provider that will execute the *next* agent turn so the spec is unambiguous.

`claude_session_id` is the underlying claude-code session UUID for that turn. Different turns by the same agent may have different session IDs after a revert (see §5).

### 2.2 Agent

An `agent` is a named ref pointing at a turn and a runtime status. Like a git branch ref.

```json
{
  "id": "alpha",
  "head_turn_id": "t_01HZX7K3...",
  "provider": "claude-code",
  "claude_session_id": "9d4f-...",
  "runtime_status": "alive" | "idle" | "exited",
  "pid": 32856 | null,
  "last_seen_turn_id": "t_01HZX7K3...",
  "work_dir": "/.../.llmnb-agents/alpha",
  "created_at": "...",
  "model": "claude-haiku-4-5-20251001"
}
```

`head_turn_id` is mutable — moving it is how revert works. `claude_session_id` is the session this agent is currently bound to (changes on `/branch` or `/revert`). `last_seen_turn_id` is the most recent turn that this agent's claude-session has been fed; if it is behind `head_turn_id` (e.g., another agent contributed turns since), the kernel catches the agent up before the next operator turn — see §4.6 (cross-agent context handoff).

`runtime_status`:
- `alive` — process running, accepting turns over stdin
- `idle` — process exited gracefully; resumable via `claude --resume <claude_session_id>`
- `exited` — process exited and cannot be resumed; the conversation is rebuilt from turn replay if re-engaged

### 2.3 Zone

The zone is the notebook itself; the only fields stored explicitly are session-level. The turn DAG and agent refs live under it.

```json
{
  "zone_id": "00000000-0000-0000-0000-...",
  "schema_version": "1.1.0",
  "created_at": "...",
  "agents": [...],
  "turns": [...]
}
```

## 3. Cell directive grammar

Five verbs. The cell's first line carries the directive; the rest of the cell is the message body. All directives operate within the current notebook's zone.

```
/spawn <agent_id> [provider:<name>] task:"<initial task>"
  → Creates new agent in the zone. Spawns the chosen provider's process (claude-code default).
  → Initialized with the zone's full turn prefix as context (the agent sees what's above).
  → First turn for this cell: role=operator, body=task. Agent's response = next turn.

@<agent_id>: <message>
  → Continuation: appends a turn targeting the named agent.
  → Cross-agent context handoff (§4.6): if other agents have contributed turns since this
    agent's last_seen_turn_id, the kernel catches it up before sending <message>.

<plain text with no prefix>
  → Implicit continuation against the most recent agent in the zone (the agent_id of the
    most recent turn). Errors with K25 if no agent has been spawned yet.

/branch <source_agent> [at <turn_id>] as <new_agent_id>
  → Creates a new agent with head=turn_id (default: source_agent.head). Spawns claude
    --resume=<source_session> --fork-session. Both agents now coexist within the zone.

/revert <agent_id> to <turn_id>
  → Moves agent.head_turn_id = turn_id. Subsequent turns targeting this agent build from
    turn_id. Turns after turn_id remain in the DAG (still visible to /branch).
```

Plus: `/stop <agent_id>` for explicit clean shutdown of an agent's runtime process (idle exit before timeout).

A cell with no recognized directive AND no prior agent in the zone is a `cell_edit` (current behavior; no agent action). Once any agent exists in the zone, plain-text cells implicitly continue against it.

## 4. Persistent agent lifecycle

### 4.1 Spawn

`/spawn alpha task:"..."` runs:

```
new_session_id = uuid4()
spawn claude --session-id=<new_session_id> \
             --output-format=stream-json --input-format=stream-json \
             --replay-user-messages \
             --system-prompt=<rendered template> \
             [--bare] [--model ...]
```

The process stays alive. Operator turns are sent over stdin as `{"type": "user", "message": ...}` JSON lines. The agent's responses arrive on stdout as the existing OTLP span stream + tool calls. `report_completion` no longer terminates the process — it just records the response turn.

### 4.2 Continuation

`@alpha: more details please` writes a JSON line to alpha's stdin. The agent processes the turn, emits spans, returns to idle waiting for the next stdin line. `agent.head_turn_id` advances when the response turn is committed.

### 4.3 Idle exit

The agent process exits when:
- Operator issues `/stop alpha` (explicit) — clean shutdown, `runtime_status: "idle"`, conversation resumable via `claude --resume`.
- Idle timeout: 30 minutes with no stdin input (configurable via `LLMNB_AGENT_IDLE_SECONDS`). Same clean shutdown.
- Kernel shuts down: all agents receive SIGTERM, then SIGKILL after the existing `shutdown_grace_seconds`.

After exit the agent is not lost — `runtime_status: "idle"` and `claude_session_id` is preserved. The next `@alpha` turn re-spawns claude with `--resume=<claude_session_id>`. Idle agents survive notebook close → reopen via the `metadata.rts` snapshot.

### 4.4 Branch

`/branch alpha at t_3 as beta` runs in two cases:

**Case A: t_3 is alpha's current head.** Equivalent to `claude --resume=<alpha_session> --fork-session`. New session ID assigned to beta; beta inherits the full conversation up to t_3.

**Case B: t_3 is an ancestor of alpha's head.** claude doesn't natively support "fork from arbitrary past turn." We synthesize it: new claude process, `--session-id=<new-uuid>`, `--input-format=stream-json`, then replay turns t_root..t_3 over stdin as user/assistant JSON lines. The replay is internal and not visible to the operator.

### 4.5 Revert

`/revert alpha to t_2`:

1. Sends SIGTERM to alpha's claude process (if alive). `runtime_status: "idle"`.
2. Mutates `agent.head_turn_id = t_2`. Records a `ref-move` event in `metadata.rts.event_log`.
3. The next `@alpha` turn re-spawns claude using Case B mechanics from §4.4 (replay t_root..t_2). A new `claude_session_id` is assigned to alpha at that point; the old session is unreachable from alpha but turns are preserved in the DAG.

Reverts are operator-intuitive (HEAD moves backward) and non-destructive at the turn level. They DO terminate the in-flight claude process — that's the price of moving the ref while the process held a different session.

### 4.6 Cross-agent context handoff

**The shared-notebook axiom (§1) means the agent's claude session can fall behind the notebook's truth.** Example sequence in one zone:

| Cell | Directive | What happens |
|---|---|---|
| 1 | `/spawn alpha task:"design a schema"` | alpha spawned; alpha's session sees turn t_1 (operator) → produces t_2 (alpha) |
| 2 | `/spawn beta task:"review alpha's schema for performance"` | beta spawned; beta's session is initialized with t_1, t_2 as context → produces t_3 (beta). alpha's `last_seen_turn_id` = t_2; beta's = t_3 |
| 3 | `@alpha: incorporate beta's feedback` | alpha's session has not seen t_3. Before sending the t_4 user message, the kernel feeds t_3 to alpha's session as a system/user message: "Beta replied: <t_3 body>". Then the operator's t_4 message. alpha produces t_5; alpha's `last_seen_turn_id` advances to t_5 |

The handoff rule:

```
On @<agent_id>: <message>:
  missed = turns where parent chain from notebook.head ⊃ {turns AFTER agent.last_seen_turn_id}
  for t in missed (in chronological order):
    feed to agent.claude_session as: "<t.role from t.agent_id>: <t.body>"
  send the new operator <message>
  capture the agent's response as the new turn
  agent.last_seen_turn_id = new turn id
  agent.head_turn_id = new turn id
```

If `missed` is empty (alpha was the most recent agent), the handoff is a no-op — alpha just resumes naturally.

If alpha's process is `idle` or `exited`, the kernel re-spawns it via `claude --resume <claude_session_id>` (idle) or via full transcript replay (exited), then performs the handoff above.

The handoff messages are NOT separate turns in the DAG — they're transient context injection. The DAG records only the operator's message (t_4) and the agent's reply (t_5). Replay is deterministic: re-running the zone replays the same handoffs in the same order from the same DAG.

## 5. Claude session ID strategy

`claude_session_id` is owned by the kernel. Each agent gets a session ID at spawn or fork time. The mapping is:

- Linear continuation (`@alpha`): same session ID across many turns. claude's own internal context is reused.
- Fork (`/branch alpha as beta`): new session ID for beta. claude's `--fork-session` handles the copy.
- Revert + continue: NEW session ID for alpha (replay synthesizes the new session). The turns from before the revert keep their original session ID; the new turns get the new session ID. This is why `claude_session_id` lives on `turn`, not (only) on `agent`.

This model means each immutable turn knows the exact claude session that produced it, which keeps replay deterministic.

## 6. Cell ↔ turn binding and cell-as-agent-identity

**V1 rule: one cell = one turn, and the cell visibly identifies its bound agent.** The operator never has to read the cell's first line to know which agent ran in it; the cell renders a decoration (badge, gutter color, or status-bar item — concrete UX up to X-EXT) showing `agent_id` + `provider` + `runtime_status`.

This is what makes the cross-agent context handoff (§4.6) work without text-level attribution: the agent reading the synthesized context already knows it didn't write those turns because the operator can SEE which cells produced which turns. The notebook itself is the attribution surface, not the message text.

Binding determination at execution time:

| Cell directive | Bound agent |
|---|---|
| `/spawn alpha task:"..."` | new agent `alpha` |
| `/spawn alpha provider:gpt task:"..."` | new agent `alpha` (provider sticky on agent — see §10 Q5) |
| `@alpha: <message>` | existing agent `alpha` |
| `<plain text>` | most recent agent in the zone |
| `/branch alpha as beta` | new agent `beta` (no turn produced; ref-creation cell) |
| `/revert alpha to t_2` | `alpha` (no operator turn produced; ref-move cell) |

The cell's bound agent is persisted in cell metadata (`vscode.NotebookCellData.metadata.rts.cell.bound_agent_id`) so the renderer can show the decoration without re-parsing the directive on every refresh. The directive on the cell's first line remains the source of truth; the metadata is a render-time cache that the controller writes after parse.

**Re-execution.** Re-running a cell produces a NEW turn (new `id`). The previous turn stays in the DAG but is no longer this cell's `cell_id` target. The cell's `bound_agent_id` may change if the operator edited the directive (e.g., changed `@alpha:` to `@beta:` and re-ran). The decoration updates accordingly.

**Branching UX.** Branching produces parallel cell sequences in the document. V1 just appends new cells in document order; the operator reads the cell decorations + directive prefixes to follow which branch they're in. V2+ adds a sidebar / picker for switching the rendered branch.

## 7. Failure modes (K-class numbering, continued from BSP-001 K11–K13)

| Code | Symptom | Marker | Operator action |
|---|---|---|---|
| K20 | `@<agent_id>` references an unknown agent | `cell_directive_unknown_agent` with `agent_id` | Use `/spawn` first, or check the agent name |
| K21 | `/branch` source_agent has no head turn (never spawned or fully reverted) | `cell_directive_invalid_branch_source` | Spawn or continue source agent first |
| K22 | `/revert` target turn_id is not in agent's ancestry | `cell_directive_invalid_revert_target` | Use `/branch` instead — `t_<id>` is in another lineage |
| K23 | Persistent agent process died unexpectedly mid-turn | `agent_runtime_died` with `agent_id`, `pid`, `exit_code` | Check `kernel.stderr.<id>.log`; re-issue the turn (will resume via `--resume`) |
| K24 | `--resume <session_id>` failed (claude reports session not found) | `agent_resume_failed` with `claude_session_id` | The session expired in claude's local cache; replay from turn DAG (kernel falls back automatically; no operator action) |
| K25 | Plain-text cell with no prior agent in the zone | `cell_directive_no_agent_in_zone` | Use `/spawn` to create the first agent in this notebook |
| K26 | Cross-agent handoff failed (provider rejected synthesized context messages) | `agent_handoff_failed` with `agent_id`, `missed_turn_count` | Provider may have token-limit or format issues; consider a fresh spawn or revert |
| K27 | Provider for `/spawn provider:<name>` is unknown to the kernel | `cell_directive_unknown_provider` with `provider` | V1 supports `claude-code` only; V2+ adds others |

## 8. Storage in `metadata.rts` — directory-mirroring JSON

The notebook IS the zone. The JSON layout under `metadata.rts.zone` is **structured so that mechanical conversion to a directory format is one-to-one** — each nested object key = directory name, each array = ordered file list, each leaf = file content. The directory format itself is a deferred spec (RFC-005 v2); the V1 single-file format below is the canonical store today, but its shape is fixed now so the future conversion is naive.

### 8.1 Convertibility invariant

```
JSON path                                      ↔  Future directory path
metadata.rts.zone.zone_id                      ↔  zone-id (in metadata.rts.json)
metadata.rts.zone.agents.<id>.session          ↔  agents/<id>/session.json
metadata.rts.zone.agents.<id>.turns[N]         ↔  agents/<id>/turns/<NNN>-<kind>.{md|json}
metadata.rts.zone.blobs.<hash>                 ↔  blobs/<hash>/{content,meta.json}
metadata.rts.zone.ordering[N]                  ↔  ordering.json (entry N)
```

Conversion is `flatten` (file → directory) and `inline` (directory → file), nothing more. No re-keying, no schema massage. Tests assert round-trip equivalence.

### 8.2 Schema

```json
{
  "rts": {
    "schema_version": "1.1.0",
    ...,
    "zone": {
      "zone_id": "00000000-0000-0000-0000-...",
      "version": 1,

      "agents": {
        "alpha": {
          "session": {
            "id": "alpha",
            "head_turn_id": "002-agent-response",
            "last_seen_turn_id": "002-agent-response",
            "claude_session_id": "9d4f-...",
            "provider": "claude-code",
            "runtime_status": "alive",
            "pid": 32856,
            "model": "claude-haiku-4-5-20251001",
            "work_dir": ".llmnb-agents/alpha",
            "created_at": "..."
          },
          "turns": [
            {
              "id": "001-operator-spawn",
              "parent_id": null,
              "kind": "operator",
              "body": "/spawn alpha task:\"design a schema\"",
              "cell_id": "vscode-notebook-cell:.../#abc",
              "spans": [],
              "created_at": "..."
            },
            {
              "id": "002-agent-response",
              "parent_id": "001-operator-spawn",
              "kind": "agent_response",
              "body": "Here is a schema...",
              "cell_id": "vscode-notebook-cell:.../#def",
              "spans": [...],
              "created_at": "..."
            }
          ]
        },
        "beta": { "session": {...}, "turns": [...] }
      },

      "blobs": {
        "sha256-abc123...": {
          "content": "<base64 or utf8>",
          "meta": {
            "mime": "text/x-python",
            "source": "tool:read_file",
            "size_bytes": 4912,
            "created_at": "..."
          }
        }
      },

      "ordering": [
        { "agent_id": "alpha", "turn_id": "001-operator-spawn" },
        { "agent_id": "alpha", "turn_id": "002-agent-response" },
        { "agent_id": "beta",  "turn_id": "001-operator-spawn" },
        { "agent_id": "beta",  "turn_id": "002-agent-response" }
      ]
    }
  }
}
```

### 8.3 Navigation paths (stable, used by kernel + extension)

These dot-paths are part of the contract; producers and consumers must agree:

| Operation | Path |
|---|---|
| Look up an agent | `zone.agents.<id>.session` |
| List an agent's turns | `zone.agents.<id>.turns` |
| Read a specific turn | `zone.agents.<id>.turns[N]` (where N is array index; turn `id` is the human-readable filename) |
| Resolve a blob ref | `zone.blobs.<hash>` |
| Render the linear notebook | walk `zone.ordering[]` and resolve each `(agent_id, turn_id)` to `zone.agents.<agent_id>.turns.find(t => t.id === turn_id)` |
| Find an agent's head | `zone.agents.<id>.session.head_turn_id` |

`<id>` and `<hash>` are object keys (string-typed); they appear as path components. `[N]` is array index. Both forms are JSONPath-compatible.

### 8.4 Schema bump

This is additive to RFC-005 v1.0.x; the schema bump is `1.0.x → 1.1.0` (minor — backward-compatible with kernels that ignore the new key but lose multi-turn semantics on resume). DriftDetector should warn but not block on this version mismatch.

### 8.5 Event log additions

The existing `event_log.runs[]` continues to record OTLP spans per turn. New events for ref moves and handoffs:

```json
{
  "type": "agent_ref_move",
  "agent_id": "alpha",
  "from_turn_id": "002-agent-response",
  "to_turn_id": "001-operator-spawn",
  "reason": "operator_revert" | "operator_branch" | "turn_committed",
  "timestamp": "..."
}
{
  "type": "agent_context_handoff",
  "agent_id": "alpha",
  "missed_turn_ids": ["beta/003-tool-read_file"],
  "synthesized_messages": 1,
  "timestamp": "..."
}
```

## 9. Implementation slices

Three independent slices. None blocks the others.

1. **K-MW** (metadata_writer): turn/agent/conversation CRUD on `metadata.rts.conversation_graph`. Pure-data; testable in isolation. Adds `MetadataWriter.append_turn`, `move_agent_head`, `create_agent`, `fork_agent`. Persists to file + emits `notebook.metadata` snapshots per RFC-006.

2. **K-AS** (agent_supervisor): persistent claude lifecycle. Replaces `spawn(...) → exits after task` with `spawn → stays alive → accepts turns via stdin`. Adds `AgentHandle.send_turn(message)`, `AgentHandle.fork(at_turn_id)`, `AgentHandle.replay_to(turn_id)` (synthesizes a new session from a transcript). Idle-exit watchdog. Resume path on next turn after idle.

3. **X-EXT** (extension): cell directive parser extended with the four verbs (§3). Cell decoration showing `agent.id` + `agent.runtime_status`. Routes parsed directives to the kernel via the existing `operator.action` envelope (new `action_type`s: `agent_continue`, `agent_branch`, `agent_revert`, `agent_stop`).

V1 ships with `/spawn` and `@<agent>:` working. `/branch` and `/revert` are V2 if the lifetime work is more complex than estimated. The data model in §2 is ratified now so we don't have to migrate later.

## 10. Open questions

These resolve before slices 2 and 3 ship; not blockers for §2 or §9 slice 1.

1. Does claude-code's `--input-format=stream-json` actually accept *new* user turns mid-process, or only the initial conversation prefix? If only the prefix, all "continuations" become re-spawn-with-replay (Case B mechanics from §4.4 applied universally). The user-facing semantics in §3 stay identical; only K-AS's implementation changes.
2. ~~Cross-agent context handoff (§4.6): should synthesized messages be tagged so the agent knows they came from a different agent, or should they be presented as if the agent itself wrote them?~~ **Resolved Issue 3**: handoff messages are NOT tagged at the text level. Cell-as-agent-identity (§6) makes the notebook itself the attribution surface; the operator sees which cells produced which turns. Handoff content is fed verbatim.
3. How should the cell render when its bound agent's `runtime_status: "exited"`? Surface a clear "this conversation is closed" state, or auto-resume on next `@`? (Suggest: surface clearly; require explicit `@` to re-engage.)
4. UX for branch switching in the document — V2+ scope; deferred. V1 just appends new cells in document order; the operator reads the cell decorations + directive prefixes to follow which branch they're in.
5. Should `provider:<name>` be a per-cell hint (this turn uses GPT) or a sticky attribute on the agent (alpha is forever a Claude agent)? **Recommended sticky** — providers have different context formats and switching mid-conversation is a footgun. `/spawn beta provider:gpt` creates a separate agent.

## 11. Views: notebook is one rendering, sidebar is another

The notebook IS the canonical operator surface — a linear chat-like sequence of cells. The graph view is a **second rendering of the same `metadata.rts.zone` data**, no new data, no new state. Pinning two views to one source of truth is what keeps "modify without getting lost" tractable: editing a cell's bound agent, branching, reverting all show up in both views immediately because both views just re-render from the data.

### 11.1 V1 — vertical list (top-to-bottom mirror)

Right-hand sidebar (VS Code's secondary sidebar, or a tab in the explorer activity). Each entry is one cell in `zone.ordering[]` sequence. For each entry the sidebar shows:

- icon by `turn.kind` (operator / agent_response / tool_call / system)
- agent badge (the same one rendered on the cell, §6)
- one-line label: agent_id + first ~40 chars of `turn.body` (or `tool_name` for tool_call)
- click → `vscode.window.activeNotebookEditor.revealRange(...)` on the corresponding cell

The sidebar is read-only in V1. Bidirectional highlight: notebook cell focus → sidebar selection follows; sidebar click → notebook cell reveal.

### 11.2 V2 — graph (DAG with branches)

Same data source. Different visualization: walk `zone.agents.<id>.turns[]` and follow each turn's `parent_id` to render a tree. Branches show as forks; the active branch (currently in the notebook) is highlighted. The operator can switch the rendered branch by clicking a fork point.

Branch switching = updating `zone.ordering[]` to walk a different path through the DAG. The notebook re-renders. The DAG itself doesn't change (turns are immutable per §2). Defer to V2+ implementation; V1 freezes the contract.

### 11.3 The lift property

V2's graph view doesn't extend the data model. It just changes the rendering algorithm from "linear walk of `ordering[]`" to "DAG layout from `parent_id`." The notebook is always one path through the DAG (whichever path `ordering[]` describes). V1's sidebar is the trivial case where the DAG is a line.

This is why §8's directory-mirroring JSON layout matters: per-agent storage (`agents.<id>.turns[]`) directly enables the DAG view because each agent's turns are already a coherent sequence. The graph view layout algorithm can be naive — pull each agent's chain, render parent edges, group by zone.

## 12. Overlays — operator edits as a second git-style graph

Computation turns are locked (§2: immutable). To let the operator annotate, correct, redact, or tag an emitted output without losing the original, this BSP adds a **second graph** with the same mechanism: immutable overlay nodes + mutable overlay refs.

### 12.1 The two-graph stack

| Graph | Nodes | Refs (mutable head) | Authored by | Render role |
|---|---|---|---|---|
| Computation (BSP-002 §2) | `turns[]` | `agent.head_turn_id` | agents + operator inputs | base — what happened |
| Overlay (this section)   | `overlays{}` | `overlay_refs{turn_id → overlay_id}` | operator only | applied at render time |

The overlay graph branches and reverts independently of the computation graph. An operator may have three overlay versions on one turn and zero on another. Branching the conversation (`/branch alpha as beta`) does NOT branch overlays — overlays are pinned to specific turn IDs in the computation graph and follow those turns into any branch that includes them.

### 12.2 Schema (extends §8.2)

```json
"zone": {
  ...,
  "overlays": {
    "ovr_<id>": {
      "id": "ovr_<id>",
      "parent_overlay_id": "ovr_<id>" | null,
      "target_turn_id": "<agent_id>/<turn_id>",
      "overlay_kind": "annotation" | "replacement" | "redaction" | "tag",
      "context_modifying": false,
      "content": "<overlay payload — text for annotation, blob ref for replacement, byte ranges for redaction>",
      "author": "operator",
      "created_at": "..."
    }
  },
  "overlay_refs": {
    "<agent_id>/<turn_id>": "ovr_<id>"
  }
}
```

Directory-mirror: `overlays/ovr_<id>.json` and `overlay_refs.json` (one file). Same convertibility invariant as §8.1.

### 12.3 Overlay kinds

- **`annotation`** — operator notes attached to a turn. Always `context_modifying: false` (notes never alter agent context).
- **`replacement`** — swaps the rendered content of a turn (text or blob). May be `context_modifying`.
- **`redaction`** — masks bytes/regions in the turn's content. May be `context_modifying` (e.g., scrub API keys before downstream agents see them).
- **`tag`** — operator-applied labels for filtering/search. Always `context_modifying: false`.

### 12.4 Composition at render time

```
renderCell(turn_id):
  turn = lookup(turn_id)
  base = turn.body  # locked to computation
  if overlay_refs[turn_id]:
    ovr = overlays[overlay_refs[turn_id]]
    base = applyOverlay(base, ovr)
  return base
```

`applyOverlay` is overlay_kind-specific. For tool_call cells, replacement may swap `output_ref` to a different blob; redaction may mask byte ranges in the referenced blob's rendering.

### 12.5 Context-modifying overlays and cross-agent handoff (§4.6)

When agent beta receives missed turns from agent alpha, the kernel checks `overlay_refs[<alpha turn>]`:

- If no overlay, or overlay has `context_modifying: false` → beta sees the base computation.
- If overlay has `context_modifying: true` → beta sees the composed (overlaid) version.

This is the operator's signed receipt: setting `context_modifying: true` is an explicit decision to alter what downstream agents perceive as alpha's actual output. Default is `false`. The operator-facing edit UI (§12.6) requires an explicit checkbox to set this flag.

Replay determinism is preserved: the overlay graph is part of `metadata.rts.zone`, so re-running the zone with the same overlay state produces the same composed context.

### 12.6 UX — the edit affordance

Computation cells (`kind: agent_response | tool_call`) render as **read-only** with a lock icon next to the agent badge (§6). The cell text cannot be directly edited.

To add an overlay:

1. Right-click the cell → "Add overlay…" (or click the lock icon)
2. A panel opens with overlay_kind picker, content editor, and a `context_modifying` checkbox (default unchecked, with a warning when checked: "Downstream agents will see this version, not the original")
3. Saving creates a new overlay version; `overlay_refs[<turn_id>]` advances to it

An overlaid cell renders an "✎ overlay vN (kind)" badge alongside the agent badge. Click → shows the overlay's own mini DAG (the chain of overlay versions for this turn). From there: revert (move ref backward), branch (create alternative version), delete (remove ref → base shows again).

### 12.7 Failure modes (continued from §7)

| Code | Symptom | Marker | Operator action |
|---|---|---|---|
| K30 | Overlay's `target_turn_id` references a turn that doesn't exist | `overlay_invalid_target` with `target_turn_id` | Likely a corrupted file; check the `.llmnb` |
| K31 | Overlay parent chain has a cycle | `overlay_parent_cycle` with `overlay_id` | Corrupt graph; rebuild from a valid checkpoint |
| K32 | `context_modifying: true` overlay on a turn whose parent is in a different zone | `overlay_cross_zone_context_modify` | Disallowed by zone-scope axiom (§1); kernel refuses |

### 12.8 Why this is the right shape (game-dev rationale)

- **Maya animation layers**: base animation + override tracks. Each override has its own timeline (versions). Overlays here are exactly that — base + override, layered at render time, each with its own history.
- **Photoshop layers + layer history**: identical. Source pixels (computation) + edit layers (overlays) + each layer has undo history.
- **Source assets vs derived assets in a build pipeline**: source is sacred; derived can be regenerated; manual overrides are tracked separately so they survive regeneration. Same pattern.

**The key design discipline:** the locked computation node is sacred — it's the agent's actual emission, evidence that this run happened. Overlays are operator-applied transformations. Two graphs is one more concept but it preserves both "agent output is real" and "operator can edit without destruction." Mixing them into one would force a choice between those two; keeping them separate gives you both.

## 13. Issue 2 — 2026-04-28 amendment

This section amends Issue 1 to lock in the V1 decisions captured in `docs/notebook/KB-notebook-target.md §0`. The amendment is **additive** — Issue 1's data model in §2, the directive grammar in §3, the lifecycle in §4, and the storage layout in §8 are unchanged. Issue 2 introduces:

- **Sections** as a new operator-side overlay-graph concept distinct from kernel-side `zone_id` (§13.1).
- A typed **cell kinds enum** under `metadata.rts.cells[<id>].kind` (§13.2).
- **Sub-turns as merge artifacts**, not native cell substructure (§13.3).
- **Tool calls bound to their parent turn** by default, with the operator-explicit `tool_cell` kind reserved for V2+ (§13.4).
- **Reserved metadata slots** for V2+ capabilities, output-kind tags, and ArtifactRef shape on blob refs (§13.5).

When Issue 2 and Issue 1 disagree, Issue 2 wins for V1.

### 13.1 Section as overlay-graph concept (KB-target §0.1, KB-target §6)

See [Section](../atoms/concepts/section.md) atom for the definition, schema, and the kernel-`zone_id` vs operator-`section_id` rename rationale. This section retains only the wire-impact note in §13.1.3.

The schema lives at `metadata.rts.zone.sections[]`; the V2-reserved `flow_policy: null` slot is described in the atom. Section creation, edits, and membership changes flow through the BSP-007 overlay-commit primitive (sibling spec).

#### 13.1.3 Why the rename matters for the wire

RFC-006 §1 specifies `llmnb.zone_id` as a mandatory OTLP attribute on every Family A span. **That attribute keeps its meaning** — it identifies the notebook session, not the operator-side section. Family A spans MAY additionally carry `llmnb.section_id` as a situational attribute when the kernel knows which operator section a turn was issued from (the cell carries `metadata.rts.cell.section_id` — see §13.2). RFC-006 wire impact is therefore **additive only**: no existing attribute changes meaning; one new optional attribute is reserved.

### 13.2 Cell kinds typed enum (KB-target §0.4)

See [cell-kinds atom](../atoms/concepts/cell-kinds.md) for the canonical enumeration of the eight cell kinds, V1-shipped vs reserved status, and the per-kind role descriptions. The cell's kind is typed at `metadata.rts.cells[<id>].kind` from V1 day one so the merge-correctness rules of KB-target §22.1 (replicated in §13.2.3 below) can be enforced structurally.

The cell metadata shape:

```json
"cells": {
  "vscode-notebook-cell:.../#abc": {
    "kind": "agent",
    "bound_agent_id": "alpha",
    "section_id": "sec_01HZX...",
    "capabilities": [],
    "..."
  }
}
```

The `kind` field is **required** in V1. V1 directive parsers MUST recognize `agent | markdown | scratch | checkpoint`. Receiving a cell whose `kind` is one of the four reserved values (`tool | artifact | control | native`) MUST be treated as a forward-compat marker: the cell is preserved verbatim, rendered as inert (kind label visible), and no action is dispatched.

#### 13.2.2 Default and back-compat

A cell with no `kind` field (e.g., a cell written by a pre-Issue-2 producer or hand-edited `.llmnb`) **defaults to `kind: "agent"`** at load time. This preserves the Issue 1 semantics — every cell pre-Issue-2 was implicitly an agent cell. The `MetadataWriter` (BSP-005 S6) MUST write the resolved `kind` back into `metadata.rts.cells[<id>].kind` on the next snapshot so the default is materialized.

Validation rules:

- If `kind` is present, it MUST be one of the eight enum values above. Unknown values MUST be rejected at load with a `wire-failure` LogRecord (RFC-006 §"Failure modes" W4).
- For `kind: "markdown"`, fields `bound_agent_id`, `directive`, and any agent-coupled metadata MUST be absent or `null`. Producers that emit a markdown cell with a stale `bound_agent_id` are buggy; loaders SHOULD log and clear.
- For `kind: "scratch"`, the cell SHOULD carry `bound_agent_id: null` to prevent accidental inclusion in a continuation chain. ContextPacker (BSP-008) treats scratch cells as excluded by default.
- For `kind: "checkpoint"`, the cell SHOULD carry `summary_text` and `summarized_cell_range[]` (schema TBD in BSP-005 S6 / BSP-008); these fields are not ratified in Issue 2.

#### 13.2.3 Cell-kind merge invariants (KB-target §22.1 forward reference)

KB-target §22.1 requires that merge candidates share the **same primary cell kind**. Issue 2 ratifies the typed `kind` field so that BSP-007's merge operation (overlay commit of `merge(c_a, c_b)`) can enforce this rule structurally. Merge-correctness:

```
merge(c_a, c_b) is allowed only if:
  c_a.kind == c_b.kind
  AND (if kind == "agent") c_a.bound_agent_id == c_b.bound_agent_id
  AND neither cell is currently executing
  AND no pin/exclude/checkpoint boundary lies between them
```

Cross-reference: BSP-007 (sibling) specifies the merge operation as an overlay commit; the cell-kind rule above is one precondition on that commit.

### 13.3 Sub-turns as merge artifacts (KB-target §0.2)

See [sub-turn atom](../atoms/concepts/sub-turn.md) for the addressing convention (`cell:<cell_id>.<n>`, 1-indexed) and the rule that a freshly created cell has no sub-turn numbering until a merge commits. The worked example below is preserved as the canonical illustration of the merge → sub-turn transition.

#### 13.3.2 Worked example — the merge that produces sub-turns

```
Initial state (no merges):
  cell c_5 — bound_agent_id: alpha — turns: [t_a]
  cell c_6 — bound_agent_id: alpha — turns: [t_b]

  Addresses: cell:c_5  → t_a
             cell:c_6  → t_b

Operator: merge(c_5, c_6)
  Preconditions per §13.2.3 are met (same kind, same agent, no boundary).
  BSP-007 records the merge as an overlay commit.

Post-merge state:
  cell c_5 — bound_agent_id: alpha — turns: [t_a, t_b] (in display order)
  cell c_6 — removed by the merge overlay commit

  Addresses: cell:c_5     → the whole cell (still resolves)
             cell:c_5.1   → t_a (first sub-turn)
             cell:c_5.2   → t_b (second sub-turn)
             cell:c_6     → invalid (returns a "merged into c_5" hint per BSP-007 ref-resolution)
```

Each sub-turn retains its original immutable turn record under `metadata.rts.zone.agents.<id>.turns[]`; the merge commits only the cell-overlay change (the new `cell_range` ordering, the deletion of c_6's cell metadata). The DAG is unaffected.

#### 13.3.3 Splitting back

A `split(c_5, at=t_b)` overlay commit is the inverse: it moves t_b's record into a new cell c_7 and re-parents the cell metadata accordingly. After split, `cell:c_5.2` is no longer valid; the operator addresses t_b as `cell:c_7` going forward. BSP-007 specifies the split commit as a sibling of merge.

Cross-reference: BSP-007 (sibling) defines the merge / split commits as overlay-graph operations. The sub-turn semantics in this section are the data shape those commits produce; BSP-007 defines the mechanism, this section ratifies the addressing contract.

### 13.4 Tool calls live in their parent turn (KB-target §0.3)

See [discipline/tool-calls-atomic.md](../atoms/discipline/tool-calls-atomic.md) for the canonical rule and [concepts/tool-call.md](../atoms/concepts/tool-call.md) for the span-shape definition.

The wire-impact: agent-internal tool calls live in `parent_turn.spans[]` (Issue 1 §2.1's `spans[]` array on the `turn` schema). The cell↔turn binding from §6 is preserved — one cell, one turn, many spans — and the cell's `bound_agent_id` is the agent that made the turn; tool spans inherit that attribution via `llmnb.agent_id` per RFC-006 §1.

The `tool` cell kind (§13.2) remains **reserved** in V1 for the operator-explicit case (e.g., a future `/run tests` directive); the V1 directive parser (§3) does not recognize it.

### 13.5 Reserved metadata slots (KB-target §0.7-§0.9)

Issue 2 reserves four metadata slots for V2+ capabilities so that V1-written `.llmnb` files are forward-compatible without a schema major bump.

#### 13.5.1 `metadata.rts.cells[<id>].capabilities[]` (KB-target §0.7 — V2)

V1 reserves an empty `capabilities[]` array on every cell:

```json
"cells": {
  "vscode-notebook-cell:.../#abc": {
    "kind": "agent",
    "bound_agent_id": "alpha",
    "capabilities": []
  }
}
```

V2 will populate this array with capability tokens (`read_context | read_files | write_files | run_commands | call_tools | call_agents | modify_overlay | checkpoint | export | access_secrets` per KB-target §20). V1 producers MUST write `capabilities: []` and V1 consumers MUST ignore non-empty arrays (forward-compat: a V2 producer's capabilities are not enforced by V1 kernels, but the metadata round-trips intact).

#### 13.5.2 OTLP attribute `llmnb.output.kind` (KB-target §0.8 — V1 tag, V2 lenses)

Every output span emitted on Family A SHOULD carry an `llmnb.output.kind` attribute typing the output. Permitted values per KB-target §15:

```
prose | code | diff | patch | decision | plan | artifact_ref
| test_result | diagnostic | checkpoint | question | warning
```

This attribute is **additive on the wire** (RFC-006 §1 "Mandatory attributes per run" is unchanged; this is one more optional attribute). V1 ships only the tag; V2 ships the lens UI ("show decisions only") that filters spans by this attribute. V1 producers SHOULD emit it; V1 consumers MUST tolerate its absence (treat as untyped output).

#### 13.5.3 `ArtifactRef` shape on `metadata.rts.zone.blobs.<sha256>` (KB-target §0.9)

Issue 1 §8.2 specifies blob storage as:

```json
"blobs": {
  "sha256-abc123...": {
    "content": "<base64 or utf8>",
    "meta": { "mime": "...", "size_bytes": 4912, "..." }
  }
}
```

Issue 2 amends the blob entry to align with the `ArtifactRef` shape (KB-target §16):

```json
"blobs": {
  "sha256-abc123...": {
    "id": "sha256-abc123...",
    "kind": "text/x-python",
    "size": 4912,
    "content_hash": "sha256-abc123...",
    "body": "<base64 or utf8>",
    "meta": {
      "mime": "text/x-python",
      "source": "tool:read_file",
      "created_at": "..."
    }
  }
}
```

The amendment is **additive** — `id`, `kind`, `size`, `content_hash`, `body` are new top-level fields on each blob entry; `meta` (with its existing children) is preserved unchanged. V1 stores body inline (`body: "<utf8 or base64>"`, never `null`). V2 will permit `body: null` when the artifact is externalized, plus add `byte_index`, `line_index`, `semantic_index`, `loaded_windows`, `pinned_ranges`, and `summaries` per KB-target §16. The cell-side ArtifactRef references stay valid across the V1→V2 transition because the *shape* doesn't change; only `body: null` becomes legal.

Convertibility (extends §8.1):

```
JSON path                                ↔  Future directory path
metadata.rts.zone.blobs.<hash>           ↔  blobs/<hash>/{body,meta.json,artifact.json}
```

The flatten/inline rule continues to hold. `id`, `kind`, `size`, `content_hash` flatten into `artifact.json`; `body` flattens into a dedicated file (so directory diffs don't have to re-emit large bodies); `meta` flattens into `meta.json`.

#### 13.5.4 Section `flow_policy` slot (V2+)

Already declared in §13.1.1; reiterated here for completeness. V1 producers MUST write `flow_policy: null`; V1 consumers MUST ignore non-null values. The slot reserves a per-section flow-control rule space (e.g., context bounding, executor pinning) for V2+ without a schema bump.

### 13.6 Cross-references to sibling specs

Issue 2 leans on two sibling BSPs being written concurrently and one wire-format spec:

- **BSP-007 (overlay git semantics, sibling)** — defines the overlay-graph commit model that records section creation/edits (§13.1), cell merges that produce sub-turns (§13.3.2), and splits that undo them (§13.3.3). Issue 2 ratifies the data shapes those commits produce; BSP-007 defines the commit primitives.
- **BSP-008 (ContextPacker + RunFrames, sibling)** — consumes the typed `kind` field (§13.2) to filter scratch and checkpoint cells, consumes `section_id` (§13.1.1) to scope context, and reads the `summary` field on sections and checkpoint cells.
- **RFC-006 v2.0.3 (kernel↔extension wire format)** — Issue 2 has wire impact only via §13.1.3 (new optional `llmnb.section_id` OTLP attribute) and §13.5.2 (new optional `llmnb.output.kind` attribute). Both are additive; no existing attribute changes meaning; the kernel `zone_id` keeps its semantics.

### 13.7 Validation summary (forward-compat checklist for V1 implementations)

Producers (kernel `MetadataWriter`, extension `metadata-applier`):

- MUST emit `metadata.rts.cells[<id>].kind` for every cell.
- MUST emit `metadata.rts.cells[<id>].capabilities: []` for every cell (V2 expansion slot).
- MAY emit `metadata.rts.cells[<id>].section_id` when the cell is part of a section.
- MUST emit `metadata.rts.zone.sections[]` with valid section objects when sections exist; MUST NOT emit `flow_policy: <non-null>` in V1.
- SHOULD emit `llmnb.output.kind` on output spans where the kind is known.
- MUST emit blob entries with `id`, `kind`, `size`, `content_hash`, `body` fields populated; `body` MUST NOT be `null` in V1.

Consumers (kernel handlers, extension renderers):

- MUST default missing `kind` to `"agent"` and write the resolved value back on next snapshot.
- MUST reject unknown `kind` values with a `wire-failure` LogRecord.
- MUST tolerate the four reserved `kind` values (`tool | artifact | control | native`) by rendering inert without dispatch.
- MUST ignore non-empty `capabilities[]` arrays from forward-version producers.
- MUST ignore non-null `flow_policy` on sections from forward-version producers.
- MUST tolerate absence of `llmnb.output.kind` (treat as untyped output).
- MUST tolerate `body: null` on blob entries from forward-version producers; SHOULD surface "artifact externalized — open lens to materialize" in the cell UI when encountered.

## Changelog

- **Issue 1, 2026-04-27**: initial draft.
- **Issue 2, 2026-04-27**: incorporate operator constraints. Notebook = zone (§1). Turns are zone-scoped (§2; collapse "conversation" entity into zone). Add §4.6 cross-agent context handoff. Grammar §3 adds plain-text-as-continuation, `provider:` hint, `/stop`. Failure modes K25–K27 added.
- **Issue 3, 2026-04-27**: cell-as-agent-identity promoted to V1 requirement (§6). Cell renders agent decoration; binding determined at execution; persisted in cell metadata as a render-time cache with the directive remaining source of truth. §10 Q2 resolved (handoffs not text-tagged because cells already attribute).
- **Issue 4, 2026-04-27**: storage layout (§8) restructured to mirror the eventual directory format 1:1. Convertibility invariant + stable navigation paths (§8.1, §8.3). Directory format itself deferred to RFC-005 v2; this issue is the JSON spec only. Inspired by Scratch's per-sprite project.json layout: stage rendering (linear ordering) is separate from per-sprite (per-agent) storage.
- **Issue 5, 2026-04-27**: views (§11). The notebook is the canonical chat-like surface; the graph view is a second rendering of the same data. V1 ships a vertical list mirror (right sidebar); V2 lifts to DAG visualization with branch-switching. Both views read from `metadata.rts.zone` directly — no second source of truth. The lift property keeps "modify without getting lost" tractable.
- **Issue 6, 2026-04-27**: overlay graph (§12). Computation turns stay locked to their emission events; operator edits live in a second git-style graph attached to specific turns. Composition at render time. `context_modifying: true` opt-in for overlays that should affect downstream agents' context handoff — preserves the "agent output is real" invariant by default. Game-dev framing: animation-layer / Photoshop-layer pattern, two graphs, one mechanism.
- **2026-04-28 (atom-refactor Phase 4)**: §13.1 / §13.2 / §13.3 / §13.4 collapsed to atom links per `docs/notebook/PLAN-atom-refactor.md`. Definitions now live in `docs/atoms/` (concepts/section, concepts/cell-kinds, concepts/sub-turn, discipline/tool-calls-atomic, concepts/tool-call). Wire-impact notes and worked examples (§13.1.3, §13.2.2, §13.2.3, §13.3.2, §13.3.3, §13.5, §13.6, §13.7) preserved verbatim. Issue 1 (§§1-12) is unchanged — it remains the normative wire spec. No behavioral or wire-format changes.
- **Issue 2, 2026-04-28** (this amendment, §13): locks in the V1 decisions from KB-notebook-target.md §0. Introduces **Section** as an operator-side overlay-graph concept distinct from the kernel-side `zone_id` (which keeps its meaning) — schema at `metadata.rts.zone.sections[]` with `id`, `title`, `parent_section_id`, `cell_range[]`, `summary`, `status`, `collapsed`, and a V2-reserved `flow_policy` slot (§13.1). Adds typed cell kinds enum at `metadata.rts.cells[<id>].kind` — V1 ships `agent | markdown | scratch | checkpoint`; reserves `tool | artifact | control | native` for V2+; missing-kind defaults to `agent` for back-compat (§13.2). Specifies sub-turns as merge artifacts only (cells get sub-turn numbering only after a merge overlay commit; addressing `cell:<id>.<n>` is 1-indexed) (§13.3). Specifies tool calls live in their parent agent turn's `spans[]` and don't spawn child cells; the `tool` cell kind is for operator-explicit tool invocation only and is V2+ (§13.4). Reserves four V2+ metadata slots: `cells[<id>].capabilities[]` (KB-target §0.7), `llmnb.output.kind` OTLP attribute on output spans (KB-target §0.8), `ArtifactRef` shape on `zone.blobs.<sha256>` with `id | kind | size | content_hash | body` fields — body stays inline in V1 (KB-target §0.9), and the section `flow_policy` slot (§13.5). Wire impact (RFC-006) is additive only: two new optional OTLP attributes (`llmnb.section_id`, `llmnb.output.kind`); no existing attribute or family changes meaning. Cross-references BSP-007 (sibling — overlay commit primitives for section/merge/split) and BSP-008 (sibling — ContextPacker consumes the typed kinds and section scope).
