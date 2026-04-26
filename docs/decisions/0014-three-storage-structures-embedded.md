# 0014. Three storage structures (layout tree, agent graph, chat flow) embedded in single .llmnb file

- **Status:** Accepted
- **Date:** 2026-04-26
- **Tag:** LOCK-IN

## Context

By the time the storage question was reached, three distinct kinds of state had emerged from prior decisions, each with a different natural data shape. The RTS map's layout (DR-0001, DR-0007) is hierarchical: workspaces contain zones, zones contain files and sub-zones, viewpoints are named camera positions over the same hierarchy. The agent runtime model (DR-0002, DR-0008, DR-0010) is a graph: agents have parent-child, peer, supervisor, and capability relationships, configuration forms cycles, edges carry properties. The chat flow surface (DR-0009, DR-0010) is a sequence of cells whose outputs are LangSmith-shaped run records, optionally nested as run trees.

The forcing question was whether to give these three structures three different storage formats, three different files, or three different physical persistence backends — or to find a unifying treatment. The temptation toward uniformity is strong: most systems default to "one storage scheme, applied uniformly," because it feels architecturally clean. But each candidate uniform scheme distorts at least two of the three structures. A flat JSON record loses the tree's traversal semantics and cannot express graph cycles. A SQLite database makes the per-cell sequence opaque to the diff and merge tooling that DR-0009 committed to inheriting from `.ipynb`. A graph database is overkill for the layout tree and forces the chat flow into a shape it does not naturally have.

Meanwhile, the structures are not fully independent — they reference each other by stable IDs. Splitting them across separate files raises the cross-file synchronization problem and makes git diffs incoherent across a single logical change. The architectural insight needed was that the right answer is at two levels at once: different shapes per structure, single physical container.

## Decision

Three independent in-memory structures, each using the data shape that fits its data; all three serialize as JSON inside one `.llmnb` file (a JSON-compatible extension of `.ipynb`).

The three structures:

- **Layout tree.** Hierarchical, JSON-serialized, with each node carrying a type tag (`workspace`, `zone`, `file`, `agent`, `viewpoint`, `annotation`), an id, render hints, and a `children` array. Tree operations (find by id or path, walk, insert child, remove subtree, re-parent, diff between layouts) are implemented in roughly 50 lines of TypeScript with no database.
- **Agent state graph.** Nodes are agents, zones, MCP servers, tools, the operator, and referenced files. Edges include `spawned`, `in_zone`, `has_tool`, `connects_to`, `supervises`, `collaborates_with`, `has_capability`, `configured_with`. V1 uses an in-memory graph (`graphology` in TypeScript, `networkx` in Python) with JSON persistence; no graph database. This is the canonical hypergraph model from DR-0002, specialized for runtime concerns.
- **Chat flow JSON.** Sequence of cells whose outputs are LangSmith-shaped run records (`id`, `trace_id`, `parent_run_id`, `run_type`, `inputs`, `outputs`, `events`, `tags`, `metadata`). The custom MIME type is `application/vnd.rts.run+json`, with a single renderer dispatching internally on `run_type`.

The three are loosely coupled but not independent: they share IDs as glue. Each structure is the source of truth for its own concern; cross-references resolve by stable id (agent ids, zone ids, file paths, run ids).

The single physical container is `.llmnb`, a JSON file whose top-level shape is `.ipynb`-conformant: `nbformat`, `nbformat_minor`, `metadata`, `cells`. RTS state lives in a namespaced extension: `metadata.rts` holds layout, agents, config, and the full event log; `cells[*].metadata.rts` holds cell-specific hints (trace id, target agent, branch markers); `cells[*].outputs[*]` holds the cell-level chat flow as MIME-typed displays. The MIME type for the file itself is `application/vnd.llmnb+json`.

## Consequences

- **Positive:** Each structure uses operations native to its shape — no forcing trees into flat records, no forcing graphs into trees, no forcing per-cell sequences into a database. Updates that touch multiple structures (transferring a file from zone A to zone B touches the layout tree and emits chat flow events) are atomic because they write one document; there is no partial-update window. Git diffs are coherent: one change produces one diff in one file showing all affected state, and notebook diff/merge tools (nbdime and similar) operate on the inherited `.ipynb` shape. ID resolution is local: all references resolve within the same document. Schema evolution has one top-level migration path with per-substructure version fields for independent evolution. Operators understand "the conversation file" as a single artifact for sharing, versioning, and archiving. A closed `.llmnb` is a resumable session: reopen tomorrow, the kernel restores layout and graph from embedded state and restarts active agents.
- **Negative / cost:** Files grow large for very long sessions. The mitigation ladder is staged: V1 accepts it; V1.5 truncates large cell outputs to external blobs by content hash; V2 splits the embedded event log into a side file when it exceeds a threshold; V2 adds archival splits for sessions running over days. None of these is needed at V1. Standard Jupyter tools opening `.llmnb` files would see a kernel mismatch, so the rename is deliberate: the fork registers `.llmnb` exclusively and standard tools have no extension association. Two physical writers exist (VS Code's notebook pipeline writes cell outputs; LLMKernel writes `metadata.rts`) but there is one logical writer because the kernel is the source of truth for everything except the cell-output stream the editor already owns.
- **Follow-ups:** Notebook diff and merge tooling integration via `.gitattributes` so review tools render `.llmnb` correctly and ignore the `metadata.rts` namespace they do not understand. Snapshot strategy locks in: write on save, on clean shutdown, and on a 30-second timer for crash safety; crash recovery loses at most the last 30 seconds of activity. DR-0015 (kernel mediator) formalizes LLMKernel as the single logical writer of `metadata.rts`.

## Alternatives considered

- **Three separate sidecar files (one per structure).** Rejected. Sync issues across files; weird git diffs that show a single logical change spread across three files; ID references can become orphaned across files; sharing requires bundling. The single-document atomicity is lost for nothing.
- **SQLite database as the storage backend.** Rejected. Opaque to git diff and review tooling; harder to share as a single artifact; loses the cell semantics that DR-0009 committed to inheriting from the `.ipynb` editor; would require a parallel diff/merge story.
- **One giant flat JSON file (no `.ipynb` shape).** Rejected. Loses the inherited cell-rendering, cell-metadata-namespace, and notebook-diff infrastructure that DR-0009 explicitly chose. The container shape was the point: keep cell semantics, namespace RTS state under `metadata.rts`, inherit the editor for free.
- **A graph database (Neo4j or similar) as the unified store.** Rejected. Overkill for the layout tree, awkward for the per-cell sequence, no inherited tooling, deployment complexity that defeats single-file portability.
- **Force all three structures into one shape (e.g., everything is a graph).** Rejected as the uniformity trap. Trees become degenerate graphs that lose cleanest tree operations; sequences become degenerate graphs that lose cleanest sequence operations; the win of "uniform processing" never materializes because each structure still needs shape-specific logic.

## Source

- **Source merged turns:** 081, 082, 083
- **Raw sub-turns:**
  - [turn-095-user.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-095-user.md) — the proposal: store RTS layout as a tree, agent state and config as a graph, chat flow as JSON.
  - [turn-096-assistant.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-096-assistant.md) — three-structure rationale, per-shape operations, cross-structure ID glue, the resist-uniformity insight.
  - [turn-097-user.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-097-user.md) — embed in `.ipynb` since it is JSON anyway, rename to `.llmnb`.
  - [turn-098-assistant.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-098-assistant.md) — single-file embedding locked, `metadata.rts` namespace, MIME types, snapshot and writer model, mitigation ladder for file growth.
- **Dev guide:** [chapter 07](../dev-guide/07-subtractive-fork-and-storage.md)
