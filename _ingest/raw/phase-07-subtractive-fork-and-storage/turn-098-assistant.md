---
turn_id: 098
merged_turn_id: 084
role: assistant
phase: 07-subtractive-fork-and-storage
source_lines: [10685, 11111]
source_sha256: 5d740d7fb7965fbbc9051e8de5c58bc4a610d42484cce4d9b6328a89729f2293
char_count: 23797
---



## Assistant

Good move. Once you commit to all three structures being JSON anyway, embedding them in a single file makes sense — you eliminate the cross-file coordination problem and you give the operator one durable artifact to manage. Let me work through what this actually looks like, because there are some real implications worth being deliberate about.

The cross-file coordination problem from the previous turn was a real cost: notebook + layout sidecar + agent graph snapshot + event log, all referencing each other via IDs, all needing to stay in sync, all having their own lifecycle. Embedding them resolves several issues at once:

One file per session = one artifact to manage. Operators understand "the conversation file." Sharing, versioning, archiving all become single-file operations. Sending a colleague the conversation means sending one file, not four.

No sync problems. Layout, graph, and chat flow all live in the same JSON document. They can't get out of sync because there's nothing to sync. A single read produces the entire state; a single write persists it.

ID resolution becomes scoped. All references — agent IDs, zone IDs, file paths — live in the same document, so resolution is local. No cross-file lookups, no orphan references, no "which version of the agent graph does this notebook expect."

Atomic operations. Updating "transfer file from zone A to zone B" touches the layout tree and emits chat flow events; both happen in the same write to the same file. No partial-update window.

Versioning is uniform. One file format, one version field at the top, one migration path. Schema evolution is one effort, not three.

Git diffs are coherent. A change to the conversation produces one diff in one file showing all the affected state. Reviewers see the full picture in one place.

The cost is mostly in the file format design and in handling files that get large, both of which are tractable. The benefits are real and immediate.

`.ipynb` files are JSON with a specific top-level structure: cells, metadata, nbformat fields. The format explicitly allows arbitrary metadata at multiple levels (notebook-level, cell-level), which gives you legitimate places to embed your additional structures.

The natural embedding:

This is fully `.ipynb`-conformant. Standard Jupyter tooling can read it (it'll just see unknown metadata it ignores). Your fork reads the `metadata.rts` field for the layout and graph; reads cell outputs' RTS-typed displays for chat flow.

The chat flow lives in two places now, which is structurally honest:

For v1, you can embed both in the file:

This is more data in one file but eliminates the side-log file. For most operator workflows that'll be fine. For very long sessions with high event volume, you might want to externalize the event log later. v1 keeps it embedded; v2 can split if needed.

The rename is the right move because it signals what the file actually is and prevents the confusion of "is this a Jupyter notebook?" Operators (and tools) seeing `.llmnb` know it's a different kind of artifact, even though the JSON inside is `.ipynb`-compatible.

A few considerations on the naming:

.llmnb is short and signals "LLM notebook" — good. Memorable, distinct from `.ipynb`, suggests purpose.

Alternative naming considered:

`.llmnb` lands at a reasonable spot — short, evocative, distinctive.

Tooling implications of the rename:

Marketplace and ecosystem:

The rename is a small change with real payoff in clarity and ecosystem isolation.

A few things shift when everything's in one file:

File-scoped agent graph instead of workspace-scoped. Previously the agent graph was at `.rts/agents.json`, workspace-scoped. Now it's per-`.llmnb` file. This means:

For v1, file-scoped is fine. Each `.llmnb` is a self-contained conversation environment. Cross-file coordination is a v2 problem.

File-scoped event log. Same shift. The full event log is per-file. If you want cross-file event tracking, that's separate infrastructure.

Workspace-scoped state shrinks. The `.rts/` directory we discussed last turn becomes either empty or just for kernel-runtime files (not data). VS Code workspace state still exists for camera position and operator session ephemera. Global state still exists for preferences.

Layout tree, agent graph, and chat flow all in one document. Single source of truth per conversation. This is the core simplification.

The kernel becomes the file's primary writer. Since LLMKernel produces all the events that go into the file (chat flow, agent graph mutations, layout updates), it owns the write path. The fork reads from the live kernel state and from the file; the kernel writes to the file via standard Jupyter notebook output mechanisms (cell outputs) plus periodically updating the metadata fields.

This is cleaner than the previous design where the fork wrote the layout sidecar separately. Now there's one writer (kernel produces events that flow into cell outputs and metadata) and the fork is purely a reader/renderer for the file plus a UI driver for layout edits that get communicated back to the kernel.

Wait — that's not quite right. Layout edits are operator-initiated in the map view (drag a zone, save a viewpoint). The fork generates these events. They need to land in the file. So the writer is split: kernel writes chat flow and agent graph; fork writes layout updates.

Two writers to the same file. Coordination needed. Options:

Option 3 is clean and matches how the rest of the system works. The kernel is the source of truth; UI manipulations send commands to the kernel; the kernel reflects state back to the UI and persists it.

This means the kernel needs to maintain layout state in memory now, alongside the agent graph and chat flow. That's fine — the kernel is the natural place for "all RTS state for this conversation."

Pulling it together, the `.llmnb` file structure:

Top-level metadata (metadata.rts): contains the layout tree, the agent graph snapshot, and conversation-level config. This is the workspace-equivalent of the conversation — the structure of the world being conversed in.

Cell metadata (cells[*].metadata.rts): per-cell information — branch points, trace IDs, RTS-specific cell hints (which agent the cell targets, which zone, etc.).

Cell outputs (cells[*].outputs[*]): the chat flow events as MIME-typed displays. Each LangSmith blob is one display item. Cell can have multiple outputs (multiple runs in one cell execution).

Top-level event log (metadata.rts.event_log): optional comprehensive event log including non-cell-level runs (intermediate child runs, kernel-internal events, etc.). Stored as JSON array of LangSmith blobs.

This is `.ipynb`-conformant JSON with `metadata.rts` and `cells[*].metadata.rts` as your namespaced extensions.

Embedding everything in one file means files get larger. Worth estimating:

A short conversation (10 cells, 50 runs, a small agent graph, simple layout): maybe 100-500KB. Fine.

A medium conversation (100 cells, 500 runs with their inputs/outputs, larger graph): maybe 1-5MB. Still fine.

A long conversation (1000 cells, 10000 runs with full content, complex graph): could be 50-200MB. Getting heavy.

A huge session (continuous use over days, ten thousand events with verbose content): could exceed 500MB. Problematic.

VS Code's notebook editor handles large `.ipynb` files but slows down past a few MB. JSON parsing and serialization at write time is O(n). Git diffs get unwieldy. Loading time becomes noticeable.

Mitigation strategies, ordered by when you should care about them:

v1: don't worry. Most conversations will be small or medium. Optimizing for the rare huge case is premature.

v1.5: truncate cell outputs. When a cell output exceeds N KB, truncate with a "view full output" link to an external file. Notebooks already do this for huge plot images.

v2: extract the event log. When the embedded event log gets too large, split it into a side file (`<name>.llmnb.events.jsonl`). The notebook references it but doesn't contain it.

v2: tool result reference, not embedding. Large tool results (file contents, big JSON blobs) get stored externally with a content-hash reference; the notebook holds the reference. Similar to git's blob storage.

v2: archival splits. Long sessions get split into multiple `.llmnb` files chronologically, with explicit "this is part 2 of conversation X" metadata.

For v1, accept that files might get large in extreme cases. Optimize when it bites real operators.

A real consideration: with everything in one file, every chat flow update touches the file. If the kernel writes the whole file on every event, that's slow and risks corruption.

The pattern that works: the file is the durable snapshot, but live state lives in the kernel's memory and is flushed on save.

Concretely:

This is how Jupyter already works for cell outputs, mostly. You're extending the pattern to the metadata fields.

The risk: if the kernel crashes between snapshots, recent state is lost. Mitigation: shorter snapshot intervals, or write-ahead logging where each event is appended to a small WAL file before being incorporated into the main file. Standard durability patterns.

For v1, a 30-second snapshot interval plus save-on-explicit-save is fine. Crash recovery is "you might lose the last 30 seconds of activity," which is acceptable for v1.

Branching gets cleaner with a unified file. To branch from a point:

The whole branching operation is "copy file, prune past-branch state, open new file." Clean. The two notebooks share a common history (in their event logs and cell outputs up to the branch point), then diverge.

If you want fancier branching — multiple branches in the same file, branch switcher UI — that's v2. v1's "branch = new file" is honest and simple.

LLMKernel's lifecycle around the file:

On open: kernel reads the `.llmnb` file. Restores layout tree, agent graph, and event log into in-memory state. Determines which agents need to be alive (based on agent graph state). Restarts agents if they were active in the file's last state.

During session: kernel processes cells, mutates state in memory, emits events that update the file's cell outputs (via standard Jupyter mechanisms) and that periodically flush to metadata fields.

On save: kernel writes current in-memory state to the file's metadata fields. Cell outputs are already written via standard Jupyter pipeline.

On close: kernel does a final write, then shuts down agents cleanly. Or marks them for restart on next open.

On reopen: same as on open; agents restart.

This makes the `.llmnb` file genuinely a resumable session — close the file, reopen it tomorrow, and the kernel restores agents and continues from where you left off. That's a meaningful capability.

The agents themselves are processes; restarting them means re-spawning with the saved state context. Their working directories (chroots/zones) might persist as their own filesystem state separate from the file. That's a daemon concern, not a file-format concern.

When a `.llmnb` is open in your fork with active agents, it's a live session. When closed, it's a static record. When opened again, it can become live again.

This dual nature is normal for kernel-backed notebooks (Jupyter has the same pattern), but it's worth being explicit:

VS Code's notebook editor handles this naturally — when no kernel is attached, the notebook is read-only-ish. Your fork inherits this.

A conversation ID in `metadata.rts.conversation_id` lets the kernel detect whether it's resuming an existing conversation or starting a new one.

A few things worth considering:

Conversation-level config: zone policies, allowed tools per agent, default agent for unspecified messages. Stored in `metadata.rts.config`.

Visual preferences specific to this conversation: theme override, custom symbol styles, default viewpoint. Stored in `metadata.rts.config.view_preferences`.

Schema version per substructure: layout has its own version, agents have their own, chat flow has its own. Each can evolve independently within the same file.

Provenance metadata: which version of LLMKernel created this file, which version of the fork wrote which fields. Useful for debugging old files.

Optional encryption hints (for sensitive conversations): could note that certain fields are encrypted with a key the operator has. v2+ feature; v1 stores plaintext.

These are all small additions to the metadata namespace. Plan for them but don't over-engineer for v1.

To stay subtractive in spirit:

The `.rts/` directory might still exist for kernel-runtime files (PIDs, sockets, log files for debugging) but it's no longer durable state storage. v1 might not need it at all.

VS Code Mementos still exist for session ephemera (camera position, theme preference for the operator). That stays unchanged.

Honest list:

Wins:

Costs:

The wins are immediate and structural. The costs are mostly performance/scale issues that emerge at scale you might not hit. For v1, the tradeoff is clearly favorable.

Updating from the previous turn's storage decisions:

The cuts compound nicely. v1 is now:

Forking work (~1-2 weeks, as previously estimated): subtract from vscode-jupyter, target `.llmnb` instead of `.ipynb`, restrict to LLMKernel.

Storage layer (~3-4 days, simpler than three structures with cross-references):

Map view (~1 week, mostly unchanged): webview panel reads layout from kernel, renders, posts edits back.

Sidebar contributions (~2-3 days): zones tree, agents tree, recent activity — all reading from kernel state.

Custom commands (~2-3 days): spawn, transfer, branch, save viewpoint.

Polish (~1 week): handling edge cases, error states, file recovery, etc.

Total v1 with the embedded-file decision: ~4 weeks, similar to before, but cleaner architecture and one fewer subsystem (no sidecar files to write/sync).

Embedding all three structures in `.llmnb` and renaming the file extension is a clean simplification. You eliminate cross-file coordination, get atomic state, give operators one artifact to manage, and reduce the v1 scope. The file format stays JSON-and-`.ipynb`-conformant under the hood, so tooling compatibility is preserved where it matters.

The cost — files getting large for long sessions — is real but bounded and addressable in v2 if it ever becomes a problem. For v1 it's not a concern.

The architecture is now:

That's a coherent, focused, v1-shippable design. The whole system is more honest about what each piece does and where it lives.

Decisions to lock:

Want to dig into the schema details for `metadata.rts`, the kernel's snapshot strategy, the branching workflow, or the migration path for old `.llmnb` files as the schema evolves?

```json
{
  "nbformat": 4,
  "nbformat_minor": 5,
  "metadata": {
    "kernelspec": {
      "name": "llm_kernel",
      "display_name": "LLMKernel"
    },
    "language_info": { ... },
    "rts": {
      "version": 1,
      "layout": {
        "type": "workspace",
        "id": "root",
        "children": [ ... ]
      },
      "agents": {
        "nodes": { ... },
        "edges": [ ... ]
      },
      "config": {
        "zone_policies": { ... },
        "view_preferences": { ... }
      }
    }
  },
  "cells": [
    {
      "cell_type": "code",
      "metadata": {
        "rts": {
          "trace_id": "trace_001",
          "branch_point": false
        }
      },
      "source": [ "spawn alpha in zone refactor" ],
      "outputs": [
        {
          "output_type": "display_data",
          "data": {
            "application/vnd.rts.run+json": {
              "version": 1,
              "id": "run_001",
              "trace_id": "trace_001",
              "type": "agent",
              "name": "alpha",
              "inputs": { ... },
              "outputs": { ... }
            }
          }
        }
      ]
    }
  ]
}
```

```json
{
  "nbformat": 4,
  "nbformat_minor": 5,
  "metadata": {
    "kernelspec": { "name": "llm_kernel" },
    "rts": {
      "version": 1,
      "conversation_id": "uuid",
      "created_at": "...",
      "layout": { /* layout tree */ },
      "agents": { /* agent graph */ },
      "config": {
        "default_zone": "...",
        "zone_policies": { ... }
      },
      "event_log": [ /* JSONL-equivalent as array */ ]
    }
  },
  "cells": [
    {
      "cell_type": "code",
      "metadata": {
        "rts": {
          "trace_id": "...",
          "branch_point": false,
          "target_agent": "alpha"
        }
      },
      "source": [ "..." ],
      "outputs": [
        {
          "output_type": "display_data",
          "data": {
            "application/vnd.rts.run+json": { /* LangSmith blob */ }
          }
        }
      ],
      "execution_count": 1
    }
  ]
}
```

- Cell outputs: the displayed conversation, the visible transcript
- Could-be-elsewhere full event log: every internal run, including non-cell-level child runs

- Cell outputs are the curated display (what the operator sees in cells)
- A metadata.rts.event_log field stores the full JSONL-equivalent as a JSON array of all runs

- .rts.ipynb: maintains compatibility signaling. Loses the rebrand.
- .llmn: shorter but ambiguous.
- .agent: too generic.
- .llmconv: explicit but ugly.
- .chat: too generic.

- Standard Jupyter tools won't open .llmnb files by default (file extension association). This is good — operators don't accidentally open .llmnb in JupyterLab and see a confusing kernel-mismatch.
- Your fork registers .llmnb as its file extension exclusively.
- You could add a fallback: if someone opens an .ipynb with the LLMKernel kernelspec set, treat it as .llmnb. But cleaner to just ship .llmnb.
- Git treats .llmnb as JSON for diff/merge purposes (set *.llmnb diff=json in .gitattributes or use nbdime-style diff tools you write).

- Search-indexable: .llmnb is googleable as a unique term once you publish.
- Mime type: application/x-llmnb+json (or just keep application/x-ipynb+json since the structure is compatible).
- Open in browser: if anyone opens it in a browser, they see JSON, which is fine.

- Different .llmnb files have different agent graphs. Reasonable.
- Agents can't easily span multiple files. If you want cross-file agents, you handle it via shared IDs and explicit references.
- Workspace-level state (which agents exist across all conversations in this workspace) needs a different home if you want it.

1. Fork sends layout updates to kernel via custom messages; kernel writes. Unified writer; clean.
2. Both write directly, with file locking and merge logic. Multi-writer; more complex.
3. Layout edits go through the kernel always. Operator drags zone → fork sends "user moved zone X to (a,b)" message to kernel → kernel updates its in-memory layout state → kernel writes. Same as option 1 but explicit about the message flow.

- Kernel maintains live state in memory (layout, agents, events, all of it)
- Kernel writes to the .llmnb file when:

The notebook is saved (operator's Cmd+S, or autosave)
The kernel shuts down cleanly
A timer-based snapshot (every 30s or so, for crash safety)
- The notebook is saved (operator's Cmd+S, or autosave)
- The kernel shuts down cleanly
- A timer-based snapshot (every 30s or so, for crash safety)
- Between writes, live state is updates that the fork sees via kernel messages, not via file reads

- The notebook is saved (operator's Cmd+S, or autosave)
- The kernel shuts down cleanly
- A timer-based snapshot (every 30s or so, for crash safety)

1. Operator chooses "branch from cell N"
2. Fork copies the .llmnb file to a new file
3. New file is opened; cells after N are removed (or marked as the pre-branch state)
4. Layout tree is preserved (same world, different conversation continuation)
5. Agent graph is preserved (same agents existed at branch point)
6. Event log is truncated to events at or before the branch point
7. Operator continues from the branch point in the new file

- Live mode: kernel running, agents active, cell execution dispatches to the kernel, layout edits flow through.
- Static mode: file viewable but no kernel attached, no cell execution, no live updates. View only.

- No more .rts.layout.json sidecar: layout is in the notebook
- No more .rts/agents.json: agent graph is in the notebook
- No more .rts/events.jsonl: event log is in the notebook (with possible v2 split for huge cases)
- No more cross-file coordination layer: everything's in one file, references are local

- One file to manage
- No cross-file sync problems
- Atomic state, single source of truth
- Self-contained sharing
- Coherent git diffs
- Resumable sessions in one artifact

- Files grow large for long sessions
- All state writes touch the same file (can be slow)
- Cross-conversation coordination requires explicit infrastructure (separate from the file)
- Forking/branching produces multiple files that share history but aren't linked
- Event log embedded in metadata is fine for moderate size, awkward for huge
- Some tools (.ipynb viewers in browsers, GitHub renderers) won't show the RTS metadata, just the cells

1. Single .llmnb file for the whole conversation, including layout, agent graph, chat flow, and event log.
2. .llmnb extension: rename to signal LLM notebook, distinct from .ipynb.
3. JSON structure is .ipynb-conformant: metadata.rts namespace for RTS state; cells[*].metadata.rts for cell-specific RTS hints; cells[*].outputs[*] for chat flow events as MIME-typed displays.
4. Layout tree in metadata.rts.layout. Tree structure as before.
5. Agent graph in metadata.rts.agents. Graph structure as before.
6. Chat flow split: cell-level in cells[*].outputs[*], full event log in metadata.rts.event_log (as JSON array).
7. Conversation-level config in metadata.rts.config.
8. Per-substructure versioning: each section has its own version field.
9. LLMKernel is the writer for metadata.rts; standard Jupyter machinery writes cell outputs.
10. Snapshot interval: 30 seconds plus on save plus on close.
11. Branching creates a new file; cross-branch coordination via shared history in event logs.
12. No more sidecar files, no more .rts/ directory for durable state.
13. VS Code Mementos remain for camera, filters, theme.
14. Files might get large; acceptable for v1, optimization is v2.
15. Custom MIME type for cell outputs: application/vnd.llmnb.run+json or application/vnd.rts.run+json. Pick consistent with file extension; probably application/vnd.llmnb+json for the file itself.

- Define the .llmnb schema with versioning
- Implement read/write for the metadata fields (layout, graph, event log)
- Implement the LangSmith-shaped MIME type and renderer (one renderer with internal dispatch)
- Implement layout-edit message flow (fork → kernel → file)

- One .llmnb file per conversation
- Three logical substructures (tree, graph, chat flow) embedded in one JSON document
- LLMKernel as the writer, fork as the reader/UI driver
- Standard .ipynb machinery handles cell outputs; custom logic handles metadata.rts
- Layout edits flow through the kernel
- 30-second snapshots plus save-driven writes

1. Single .llmnb file with embedded layout, agent graph, chat flow, event log.
2. Naming: .llmnb extension, application/vnd.llmnb+json MIME for the file.
3. Structure: .ipynb-conformant JSON with metadata.rts and cells[*].metadata.rts namespaces.
4. Substructure versioning: independent versions per section.
5. Single writer (kernel) for metadata; standard pipeline for cell outputs.
6. Snapshot strategy: periodic + save + close.
7. Branching: file-copy with truncation; v2 considers richer branching.
8. No sidecars: everything in the file or in VS Code Mementos.
9. v1 accepts large files; v2 splits if needed.
10. Custom MIME type for runs: application/vnd.rts.run+json or similar.

