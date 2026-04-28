# LLM Notebook System — What We Have and What We Do Well

**Status:** working system document
**Frame:** notebook UI + state model + execution model
**Core claim:** this is not merely “Jupyter for LLMs.” It is a notebook-shaped operating environment for stateful semantic execution.

---

## 0. V1 decisions and amendments (2026-04-28)

This doc is the **target architecture** (V2+ vision in many places). The decisions below pin what V1 actually ships, what gets reshaped vs. what keeps its shape, and the naming reconciliations between this doc and the existing kernel/wire specs (BSP-002 / BSP-003 / RFC-005 / RFC-006).

When this section and the doc body disagree, **this section wins for V1.** The body stays as the future target.

### 0.1 Naming reconciliation

| This doc says | V1 says | Why |
|---|---|---|
| **Zone** (§6) — operator-defined narrative range | **Section** | Conflicts with kernel `zone_id` (= notebook session) used by RFC-006. Rename the overlay-graph concept; kernel `zone_id` keeps its meaning. |
| `zone_id` field in RunFrame (§9) | `section_id` | Same fix |
| `current_zone` / `parent_zone` (§17, §22.1) | `current_section` / `parent_section` | Same fix |
| Doc uses **Zone** in §6, §9, §13.4, §17, §22.1, §23, §24 — all are **Section** in V1 | | The body of this doc is unmodified; treat every "zone" / "Zone" outside this §0 as the operator-narrative concept named **Section** in implementation. |

### 0.2 Sub-turns are merge artifacts, not fundamental

Per §4 the doc shows `In[5] alpha · schema design / 5.1 / 5.2 / 5.3` as if sub-turn numbering were native. **V1 says: a freshly created cell containing one operator turn has no sub-turn numbering.** Sub-turns emerge when cells merge:

```
before: cell c_5 (one turn t_a)
        cell c_6 (one turn t_b)
operator: merge(c_5, c_6)
after:  cell c_5 with sub-turns c_5.1 (= t_a) and c_5.2 (= t_b)
```

Sub-turn addressing (`cell:c_17.2`) per §14 stays as the V1 stable handle, but the addressing only carries a sub-index when merges have happened.

### 0.3 Tool calls live in their parent turn

Per §11 tools are devices. **V1 clarifies**: when an agent makes a tool call without explicit operator intervention, the tool call's record stays inside the same cell as the agent's turn that triggered it. Tool calls are part of the agent's turn, not their own cells. **`tool_cell` (§13.1) exists only for cases where the operator explicitly invokes a tool outside an agent's reasoning** (e.g., `/run tests` as a control-cell directive).

### 0.4 Cell kinds typed in V1

§13.1 enumerates 8 cell kinds. **V1 ships at minimum**: `agent_cell`, `markdown_cell` (= comment cell M1 from BSP-005), `scratch_cell`, `checkpoint_cell`. Other kinds (`tool_cell`, `artifact_cell`, `control_cell`, `native_cell`) are **reserved** in the enum from day one — declared but not necessarily wired. The kind is enforced at `metadata.rts.cells[<id>].kind` so the merge-correctness rules of §22.1 (which require `same primary cell kind`) work from V1.

### 0.5 RunFrames — minimal V1 schema

§9 lists the full RunFrame. **V1 ships the minimal subset**:

```jsonc
RunFrame: {
  run_id: string,
  cell_id: string,
  executor_id: string,                  // agent_id
  turn_head_before: string,             // turn_id
  turn_head_after: string,              // turn_id
  context_manifest_id: string,          // ContextPacker output
  status: "complete" | "failed" | "interrupted"
}
```

V1 does NOT yet ship `parent_run_id`, `source_snapshot_id`, `overlay_commit_id`, `artifact_windows[]`, full `tool_permissions`. Those are V2.

### 0.6 ContextPacker — simple V1 contract

§22.2 lists what the full ContextPacker needs. **V1 ships a dumb structural walker**:

```
input:  current cell, current section, notebook overlay
output: ordered list of turn_ids to include in the agent's context

V1 rule: include in this order:
  1. Pinned cells (anywhere in notebook)
  2. Previous cells in current section (chronological)
  3. Current cell (its prior sub-turns if merged)
exclude:
  - Cells flagged scratch
  - Cells flagged excluded
  - Cells flagged obsolete (superseded by branch/revert)
no ranking. no budget overflow strategy. no summary trust.
```

V2 adds ranking policies, recency decay, budget overflow handling, summary trust, manifest diffing.

### 0.7 Capabilities — V2

§20's full capabilities table (read_context / read_files / ... / access_secrets) and privilege levels (view/draft/edit/execute/admin) are **deferred to V2**. Single-operator V1 has one trust boundary (operator → kernel → agents). RFC-001's `--allowedTools` covers the agent→tool boundary today.

V1 reserves `metadata.rts.cells[<id>].capabilities[]` as an empty array for V2 expansion.

### 0.8 Typed outputs — V1 ships the tag, V2 ships lenses

§15 enumerates 12 output kinds enabling lenses. **V1 ships only the tag** as an OTLP attribute `llmnb.output.kind` on every emitted span (`prose | code | diff | patch | decision | plan | artifact_ref | test_result | diagnostic | checkpoint | question | warning`). **V2 ships the lens UI** ("show decisions only") that filters on the tag.

### 0.9 Artifacts — V1 ships the shape, V2 ships streaming

§16 specifies full ArtifactRef + viewport-driven streaming. **V1 ships the shape**:

```jsonc
ArtifactRef: {
  id: string,
  kind: string,
  size: number,
  content_hash: string,
  body: string | null     // V1: inline body. V2: null when externalized.
}
```

V1 stores body inline (matches today's `metadata.rts.zone.blobs` semantics). V2 adds `byte_index`, `line_index`, `semantic_index`, `loaded_windows`, `pinned_ranges`, `summaries`, and the streaming materializer. The cell-side ArtifactRef references stay valid across the V1→V2 transition because the *shape* hasn't changed.

### 0.10 Implementation slices on top of BSP-005

The slice ladder in BSP-005 is amended to include:

| Slice | Where in BSP-005 ladder | Driver |
|---|---|---|
| **S0.5**: Cell kinds typed enum + reserved metadata slots | Before S1 | §0.4 |
| **S3.5**: ContextPacker (simple V1 contract) | After S3, before S4 | §0.6, §22.2 |
| **S5.5**: Sections (overlay-graph narrative range) | After S5, before S6 | §0.1, §6 |
| **S6.x**: RunFrames + minimal Inspect mode | Folded into S6 | §0.5, §9, §18 |

Net: ~+5-6 days on top of BSP-005's original ~12 days. Total V1 UX runway: ~17-18 days.

### 0.11 Three new BSPs needed

V1 cannot ship without three new BSPs filling gaps:

- **BSP-002 Issue 2**: amendment locking §0.1-§0.4 into the existing conversation-graph spec.
- **BSP-007**: overlay git semantics (commits, refs, diff, branches, history) — fills the `git-style` gap that target gestures at without developing.
- **BSP-008**: ContextPacker + RunFrames module spec — names the §22.2 / §9 modules with V1-minimal contracts.

These land before any cell-side slice that depends on them.

---

## 1. One-sentence system definition

The LLM Notebook is a programmable workspace where **cells are operator-scoped instruction blocks**, **agents are registered semantic executors**, **tools are registered devices**, **context is explicit memory**, and the system preserves both **what happened** and **how the operator arranged it**.

Sharper:

> The notebook separates immutable agent truth from mutable operator truth, then gives the operator structured controls for scope, flow, context, artifacts, and execution.

---

## 2. What we already have

The architecture already has the essential objects:

```text
Turn DAG          immutable execution/conversation substrate
Cell overlay      mutable editorial/program layout
Bindings          cell ↔ turn/span references
Cell Manager      resolver between substrate and overlay
Agents            registered semantic executors
Tools             registered devices/peripherals
ContextPacker     explicit context/memory assembler
Artifacts         addressable large outputs/files/logs/diffs
Zones             narrative/workflow sections over cells
RunFrames         execution snapshots for cell runs
Overlay commits   reversible structure edits
Modes             progressive disclosure views
```

The most important achievement is that the design has found its real objects. It is no longer just a chat UI, and it is no longer merely a notebook UI. It has the beginnings of a real state model and execution model.

---

## 3. The central architectural split

The strongest idea is the split between two kinds of truth.

```text
Turn DAG
  agent truth
  append-only
  what was said, by whom, when
  includes turns, tools, spans, outputs, branches, provenance

Cell overlay
  operator truth
  mutable and git-like
  how the human arranged, interpreted, compacted, labeled, and scoped the work
```

This separation solves the deepest chat problem: chat conflates **history** with **presentation**.

In this notebook, history remains intact while presentation can be repaired.

That lets the operator split, merge, collapse, summarize, checkpoint, reorder, label, pin, exclude, branch, and inspect without corrupting the underlying conversation trace.

This is the architectural foundation.

---

## 4. What a cell is

A cell is not a message.

A cell is not merely a prompt.

A cell is an **issuance scope chosen by the operator**.

```text
Cell =
  source directive
  local scope policy
  local flow policy
  bound turns
  bound spans
  context manifest
  artifact references
  execution state
  overlay metadata
  provenance hooks
```

A cell may contain multiple sub-turns:

```text
In[5] alpha · schema design
  5.1 /spawn alpha task:"design schema"
  5.2 @alpha: optimize for reads
  5.3 @alpha: assume 100M rows
```

This gives us the best part of Jupyter: a cell is a meaningful unit of work. But unlike Jupyter, the cell is not forced to equal one execution event.

The notebook gets to preserve the flow of thinking while allowing the operator to continuously repair the structure of that flow.

---

## 5. What we do especially well: split and merge

Principled cell split/merge is one of the rescue moves.

In chat, the structural unit is accidental: one message after another.

In this notebook, the structural unit is intentional: the cell.

Split and merge become refactoring operations:

```text
split(cell, at_turn_or_span)
  declare a semantic boundary

merge(cell_a, cell_b)
  declare semantic continuity
```

These are not destructive edits. They are overlay commits.

The underlying Turn DAG does not change. The operator’s arrangement changes.

This gives the system a refactoring calculus for conversation.

### Why this matters

Split/merge solves three problems at once:

1. **Saturation**
   Thousands of turns can become a manageable set of thread-cells.

2. **Context authorship**
   Operators can pin, exclude, checkpoint, and summarize meaningful cells instead of arbitrary chat fragments.

3. **Conceptual drift**
   When a conversation changes topic, object, artifact, or purpose, the operator can repair the boundary.

The principle:

> The cell is the unit of human intentionality. Split and merge are the primitive refactorings of conversational structure.

---

## 6. Sections and zones

Cells are local units. Zones are narrative/workflow units.

A zone is an operator-defined range over the cell overlay graph.

```text
Zone =
  id
  title
  ordered cell range
  optional parent zone
  collapsed / expanded state
  scope policy
  flow policy
  summary
  status
  open questions
```

Zones let the notebook preserve flow at a larger scale:

```text
## Architecture
  In[1] core model
  In[2] cell semantics
  In[3] source/runtime split

## Runtime
  In[4] agents as executors
  In[5] tools as devices
  In[6] scheduler and RunFrames
```

Zones are not cosmetic headings. They are overlay objects.

They are the natural unit for:

```text
folding
summarizing
checkpointing
exporting
routing
scoping
reviewing
freezing completed work
```

The principle:

> Cells preserve local issuance. Zones preserve narrative flow.

---

## 7. Scope control

Scope control should not be a complex programmable policy language inside cells.

The user should not have to write nested scope configuration to make the notebook work. Scope should mostly emerge from visible notebook structure:

```text
cell order
cell kind
zone membership
split/merge boundaries
pinned cells
excluded cells
checkpoint cells
scratch cells
artifact lenses
```

In V1, scope is controlled by **logical reorganization** of the notebook, not by complex local rules embedded in cells.

The operator changes scope by doing notebook-native things:

```text
move this cell into the implementation zone
split this review into its own cell
merge these compatible agent continuations
pin this architecture cell
exclude this obsolete branch
checkpoint this finished section
mark this scratch as not-for-context
promote this artifact range into a cell
```

Those actions flow upward into the kernel/runtime layer. The kernel then derives the context pack from the resulting notebook structure.

The cell itself should remain simple:

```text
cell kind
cell source/directive
cell bindings
cell output/artifact refs
cell status
```

A cell may carry a small number of visible toggles:

```text
pinned
excluded
scratch
checkpoint
read-only
```

But it should not carry an elaborate scope program.

Bad:

```yaml
scope:
  include:
    ranking_policy:
      semantic_weight: 0.7
      recency_decay: 0.13
      checkpoint_trust: operator_approved_only
      branch_visibility: custom
```

Better:

```text
This cell is pinned.
This zone has a checkpoint.
This branch is excluded.
This cell is scratch.
The notebook order says what comes before this.
```

The invariant:

> Cells do not contain complex scope machinery. The notebook structure determines scope, and the kernel materializes it.

This preserves the Zachtronics-style discipline: visible pieces, simple roles, local movement, and emergent global behavior.

---

## 8. Flow control

Flow control answers:

> What happens next?

Scope controls visibility and permissions. Flow controls execution and routing.

The notebook supports flow operations:

```text
run(cell)
continue(cell, agent)
handoff(from_agent, to_agent)
branch(from_turn)
revert(to_turn)
stop(run)
checkpoint(range)
promote(span)
route(condition, target)
```

Flow state is related to but distinct from both the DAG and overlay.

```text
Turn DAG
  what happened

Cell overlay
  how it is arranged

Flow state
  what is active, waiting, routed, interrupted, or paused
```

A flow edge may be durable or transient.

```text
durable:
  branch
  revert
  continuation
  checkpoint

transient:
  handoff context injection
  streaming status
  pending tool call
  interrupted run
```

The invariant:

> Flow may be dynamic, but flow provenance must be durable.

This lets the UI answer questions like:

```text
Why did this agent know that?
What cell triggered this run?
What context was injected?
Which tool call produced this artifact?
Which branch did this output descend from?
```

---

## 9. Self-reference without paradox

Cells can refer to themselves, previous cells, zones, turns, artifacts, and visible ranges.

This is necessary for natural notebook work:

```text
@alpha: summarize this cell
@beta: review the previous section
@gamma: continue from In[12]
@delta: checkpoint the current zone
```

But self-reference must be snapshot-stable.

Each run receives a RunFrame:

```text
RunFrame:
  run_id
  cell_id
  zone_id
  executor_id
  parent_run_id
  source_snapshot_id
  overlay_commit_id
  turn_head_before
  turn_head_after
  context_manifest_id
  artifact_windows
  tool_permissions
  status
```

When a cell says “this cell,” it means:

> this cell at the source snapshot and overlay commit where the run began.

Streaming output from the current run is not part of `this_cell` until the run commits.

The invariant:

> Self-reference is allowed only through snapshot-stable handles.

This preserves conversational flow without creating recursive instability.

---

## 10. Agents as executors

The stronger execution model is:

```text
Agent / LLM = semantic executor / CPU-like core
```

An agent is not ambient intelligence floating over the notebook. It is a registered executor.

```text
Executor:
  id
  kind: llm_agent
  provider
  role
  session_id
  head_turn_id
  supported_opcodes
  context_window
  tool_capabilities
  current_status
  failure_modes
```

A cell run dispatches to an executor:

```text
dispatch cell:c_17
to executor:alpha
with context:ctx_92
using devices:[filesystem, diff_engine, test_runner]
```

This makes execution explicit.

It also lets the scheduler reason about availability, capabilities, permissions, context budget, and failure.

---

## 11. Tools as devices

Tools are not random functions. They are registered devices or peripherals.

```text
Device:
  id
  kind
  driver
  methods
  permissions
  event_stream
```

Examples:

```text
filesystem_device
git_device
diff_device
test_runner_device
shell_device
browser_device
artifact_stream_device
notebook_overlay_device
vector_search_device
```

A tool call becomes a device call:

```text
DeviceCallFrame:
  run_id
  executor_id
  device_id
  method
  args
  permissions_checked
  input_artifacts
  output_artifacts
  status
  logs
```

This gives the system:

```text
provenance
permissioning
replayability
debuggability
failure isolation
```

The key safety principle:

> Agents execute text, but tools commit effects.

An agent should not directly mutate reality. It should request or propose effects through devices.

---

## 12. Cells as instruction blocks

The programming-language view is strong.

A cell is a typed, scoped, relocatable instruction block.

It can declare or infer:

```text
executor
opcode
scope
devices
capabilities
flow
return type
```

Example:

```text
In[21] @alpha IMPLEMENT
  scope: current_zone + pinned(:architecture)
  devices: fs.read, diff.propose, tests.run
  writes: selected_span only
  returns: patch + test_result
```

The system can compile this into an InstructionBlock:

```yaml
InstructionBlock:
  cell_id: c_21
  opcode: IMPLEMENT
  executor: agent:alpha
  devices:
    - filesystem.read
    - diff.propose
    - tests.run
  context_manifest: ctx_92
  artifact_windows:
    - artifact:a_14#L100-L240
  permissions:
    read: current_zone
    write: selected_span
    execute: tests_only
  returns:
    - patch
    - test_result
```

This gives the notebook an ISA-like structure without forcing the user to write assembly.

---

## 13. Cell discipline: Zachtronics, not general ASM

The ISA metaphor is useful only if it produces discipline.

The notebook should not become a general-purpose assembly language with arbitrary jumps, clever configuration, and hidden machine behavior. The better metaphor is **Zachtronics-style instruction tiles**: small, visible, constrained units that compose through placement, order, and simple rules.

V1 should prefer obvious behavior over expressive cleverness.

### 13.1 One cell, one system role

A cell should not perform multiple system roles at once.

Bad:

```text
@alpha implement this, update the checkpoint, route to beta, mutate context policy, run tests, and rewrite the overlay
```

Better:

```text
In[10] Agent cell: implement patch
In[11] Tool cell: run tests
In[12] Review cell: beta reviews patch
In[13] Checkpoint cell: summarize accepted result
```

Each cell should have a primary kind:

```text
markdown_cell      human prose / notes
agent_cell         dispatches to one registered agent executor
tool_cell          invokes one registered tool/device operation
artifact_cell      displays or lenses an artifact/range
checkpoint_cell    summarizes a range or zone
control_cell       simple notebook-level control, such as branch/revert/stop
native_cell        low-level instruction/runtime directive, isolated from agent calls
scratch_cell       temporary human workspace, not automatically part of agent context
```

A cell may reference other objects, but it should have only one dominant role.

The invariant:

> A cell has one primary system role. Composition happens through neighboring cells, zones, bindings, and notebook order.

### 13.2 V1 order drives functionality

In V1, notebook order should do most of the work.

The visible order of cells is the default execution and reading order. Avoid complex flow graphs unless the user explicitly branches.

Default V1 behavior:

```text
run current cell
continue within current cell if addressed to same agent
otherwise append result after current cell
context defaults to current cell + previous relevant cells + pinned/checkpointed summaries
checkpoint summarizes a contiguous range
branch creates a visible new section/cell range
```

This keeps the system legible. The user should be able to understand the notebook by reading it top to bottom.

Flow controls may exist, but they should be sparse and visible:

```text
/branch
/revert
/stop
/checkpoint
/promote
```

No hidden routing language in V1.

### 13.3 Native instruction cells are isolated

Native instruction cells should exist for power users and system development, but they must be isolated from ordinary agent calls.

A native cell is for low-level notebook operations:

```text
%notebook.inspect cell:c_12
%notebook.rebind cell:c_8 turn:t_44
%notebook.dump_context ctx:ctx_91
%notebook.validate_overlay
```

Native cells should not simultaneously dispatch agents.

Bad:

```text
%native rebind cell:c_8; @alpha now continue from it
```

Better:

```text
In[20] Native cell: rebind/inspect/validate
In[21] Agent cell: continue with alpha
```

The invariant:

> Native cells may inspect or mutate notebook machinery, but they do not also perform semantic agent work.

This protects the ordinary notebook from becoming a fragile scripting environment.

### 13.4 Scratch is notebook-level, not hidden configuration

The notebook should have Scratch-like clunkiness at the notebook level: visible, explicit, maybe a little manual.

Scratch cells are temporary workpads:

```text
scratch_cell:
  not automatically included in context
  not part of default checkpoints
  can be promoted to markdown/agent/artifact cell
  visually marked as scratch
```

This is better than invisible configuration panels or elaborate hidden policies.

A user should be able to create a scratch cell, paste messy notes, try an idea, then either promote it or discard it.

The rule:

> Prefer visible scratch space over invisible advanced configuration.

### 13.5 No super-complex configuration in V1

V1 should avoid deeply nested policy configuration.

The notebook should not ask users to program cell behavior with hidden rules. Cells should be simple pieces. The operator should get control by reorganizing those pieces.

Bad:

```yaml
scope:
  include:
    ranking_policy:
      semantic_weight: 0.7
      recency_decay: 0.13
      checkpoint_trust: operator_approved_only
      branch_visibility: ...
```

Better:

```text
move the cell
split the cell
merge compatible cells
pin a cell
exclude a cell
checkpoint a section
promote a span
mark a cell as scratch
```

These visible notebook operations flow upward into runtime behavior.

```text
operator reorganizes cells
→ overlay records simple structural facts
→ kernel derives scope/context/execution behavior
→ Inspect mode explains what was derived
```

The cell should not be a tiny programmable universe. It should be a visible instruction tile with one primary role.

The design discipline:

```text
visible order beats hidden routing
logical reorganization beats in-cell configuration
cell kind beats multi-role behavior
scratch beats policy complexity
simple toggles beat policy languages
native cells exist but stay isolated
kernel derives behavior from structure
```

## 14. Cell registers and flags

Cells should expose a small set of local machine state.

### Registers

```text
$agent        current/default executor
$status       idle | running | waiting | failed | complete
$head         latest bound turn
$ctx          latest context manifest
$zone         containing zone
$artifact     primary artifact ref
$selection    selected span/range
$summary      current summary
$decision     latest accepted decision
$errors       latest errors/warnings
```

### Flags

```text
dirty          source changed since last run
stale          output/context predates dependency change
pinned         forced into context
excluded       barred from context
obsolete       superseded by branch/revert
checkpointed   represented by summary cell
blocked        waiting on another cell/run/tool
unsafe         contains risky/secret/tool-boundary material
partial        stream was interrupted
divergent      overlay view differs from DAG lineage
```

This is how the notebook becomes inspectable.

A normal notebook says: “this cell ran.”

This notebook can say: “this cell ran, but its context is stale, its artifact changed, and its output was partial.”

---

## 14. Addressing modes

Cells need precise references.

Friendly references can exist in the UI, but stored references should use stable handles.

```text
this_cell
previous_cell
next_cell
current_zone
parent_zone
selected_span
visible_range

cell:c_17
cell:c_17.2
turn:t_381
zone:z_4
artifact:a_22#L100-L180
artifact:a_22@byte[1024:4096]
ctx:ctx_92
agent:alpha.head
```

This is the difference between chat reference and machine reference.

Chat says:

```text
fix the thing above
```

The notebook can resolve:

```text
fix artifact:a_22#L100-L180 using ctx:ctx_92
```

This enables relocation. Cells can move, split, or merge while references remain stable.

---

## 15. Typed outputs

Outputs should not just be blobs of text.

They should have types:

```text
prose
code
diff
patch
decision
plan
artifact_ref
test_result
diagnostic
checkpoint
question
warning
```

Typed outputs make lenses reliable:

```text
show decisions only
show failed tests
show proposed edits
show open questions
show checkpoints
show warnings
```

This is much stronger than heuristic filtering over plain chat text.

---

## 16. Artifact streaming

Large files, logs, traces, diffs, and generated outputs should not be stuffed directly into cells.

A cell should point to an artifact.

```text
ArtifactRef:
  id
  kind
  size
  content_hash
  byte_index
  line_index
  semantic_index
  render_lens
  loaded_windows
  pinned_ranges
  summaries
```

The cell becomes a portal:

```text
Out[17]: build.log
  2.7GB · indexed · 14 warnings · 3 errors · 918 matching spans
  [open lens] [pin range] [summarize range] [promote span]
```

Scrolling should materialize ranges on demand:

```text
viewport
→ range resolver
→ byte/line/span window fetch
→ incremental renderer
→ semantic side-channel
```

The principle:

> Cells organize work. Artifact lenses stream mass.

This keeps cells from becoming garbage bags.

---

## 17. Source layer and performing layer

The notebook must not over-abstract the relationship between source and performance.

```text
Source layer:
  cell source
  directives
  prompt text
  files
  ranges
  notebook metadata

Performing layer:
  running agents
  tool calls
  streams
  context packs
  execution status
  output rendering
  logs
```

The invariant:

> No performance without source provenance.
> No source without performance observability.

Clicking a generated output should reveal the source, turns, tools, files, context, and artifact ranges that produced it.

Clicking a source span should reveal where it appeared in agent context, rendered output, diffs, tool calls, and downstream cells.

The system should feel powerful because it organizes reality, not because it hides reality.

---

## 18. Progressive disclosure modes

The four-mode model is good.

```text
Notebook mode
  familiar Jupyter-like surface
  cells, sub-turns, outputs, summaries, collapse/expand

Inspect mode
  metadata, bindings, context manifests, source/performance details

DAG mode
  agent truth
  turn topology, branches, handoffs, heads, obsolete turns

History mode
  operator truth
  overlay commits, split/merge/reorder/checkpoint timeline
```

This is strong because it prevents one UI from doing everything.

The user can live in Notebook mode most of the time and escalate only when needed.

The principle:

> The common path should feel like Jupyter. The uncommon path should reveal the machine.

---

## 19. Persistence model

The `.llmnb` file should preserve the notebook as a stateful workspace.

It needs to store:

```text
metadata
agents
turns
cells
zones
overlay.commits
bindings.cell_turn
context_manifests
artifact_refs
blobs
event_log
recoverable runtime config
context policies
volatile runtime values
```

Important split:

```text
Persisted:
  source
  turns
  overlay
  bindings
  artifacts
  manifests
  provenance

Volatile:
  live process handles
  transient streams
  local runtime state
  active locks
```

A regular notebook often hides state in the kernel.

This notebook should persist explicit state and make volatile state inspectable.

---

## 20. Security and capabilities

Because agents can call devices, cells need capabilities.

```text
capabilities:
  read_context
  read_files
  write_files
  run_commands
  call_tools
  call_agents
  modify_overlay
  checkpoint
  export
  access_secrets
```

Privilege levels:

```text
view      inspect only
draft     propose edits
edit      modify files
execute   run tools/commands
admin     modify notebook state / agents
```

Important security questions become first-class:

```text
Which agent saw this file?
Which context pack contained this secret?
Which device committed this write?
Which cell authorized this tool call?
Which artifact was exported?
```

This matters because “what did the agent see?” is a core security primitive.

---

## 21. What we do well

### 21.1 We separate reality from arrangement

The system does not corrupt history when the operator rearranges the notebook.

This is the biggest win.

```text
DAG = what happened
Overlay = what it now means to the operator
```

### 21.2 We recover the cell as a serious object

The cell becomes a semantic unit, not a chat bubble.

It can be run, continued, split, merged, scoped, inspected, checkpointed, routed, and referenced.

### 21.3 We make context explicit

Context is not just the latest sliding window.

It is an assembled, inspectable manifest.

That makes agent behavior debuggable.

### 21.4 We support long-running work

Thread cells, zones, checkpoints, collapse, virtualized rendering, and artifact streams give the system a credible answer to saturation.

### 21.5 We preserve flow while allowing repair

The notebook can still read linearly, but the operator can repair structure after the fact.

This is the deep advantage over chat.

### 21.6 We have a path to real execution semantics

Agents as executors and tools as devices is a strong model.

It enables scheduling, permissioning, debugging, replay, and inspection.

### 21.7 We avoid over-magic

The source/performance split keeps the operator close to the actual materials: text, files, turns, tool calls, logs, artifacts, diffs, and context manifests.

### 21.8 We have progressive disclosure

The system can feel simple at first and deep when needed.

Notebook → Inspect → DAG → History is a strong escalation path.

---

## 22. What is still underdefined

The architecture has the right objects, but some contracts need to be hardened.

### 22.1 Split/merge invariants

Split and merge should be conservative in V1.

The rule is:

> Split/merge may rearrange instruction buffers, but may not mix provenance domains.

Think of a cell as a buffer of compatible instruction records. If another record can be appended to that buffer without changing its provenance meaning, it may be merged. If appending would mix roles, scopes, or provenance boundaries, the merge is forbidden.

Merge is allowed when cells are buffer-compatible:

```text
same primary cell kind
same executor/provenance domain, if agent-owned
same tool/device provenance, if tool-owned
same zone or compatible parent zone
no pinned/excluded/checkpoint boundary between them
no executing or partial run in either cell
append preserves turn ordering
bindings remain unambiguous
```

Merge is forbidden when cells cross hard provenance boundaries:

```text
agent cell + tool cell
agent cell + native cell
tool output + checkpoint cell
cells owned by different executor sessions without explicit bridge
cells separated by pin/exclude/checkpoint semantics
cells from incompatible branches
cells with committed decision/checkpoint boundaries
currently executing cells
partial/interrupted cells unless first normalized
```

Pins, exclusions, and checkpoints are unmergeable boundaries in V1.

```text
pin        = context boundary
exclude    = context boundary
checkpoint = compression/provenance boundary
```

They may be adjacent to other cells, referenced by other cells, or superseded by explicit overlay commits, but they should not be silently absorbed by merge.

Split is easier: a split may divide a buffer only at a valid instruction/turn/span boundary where both resulting cells remain valid single-role cells.

The invariant:

> Merge preserves provenance or it is not a merge. Split preserves valid cell roles or it is not a split.

### 22.2 ContextPacker algorithm

Need exact rules for:

```text
ranking included items
pin vs recency
exclusion vs retrieval
budget overflow
summary trust
manifest diffing
```

### 22.3 Artifact streaming layer

Need exact implementation model for:

```text
byte windows
line windows
semantic indexes
large logs
large diffs
large tables
scroll synchronization
artifact range pinning
```

### 22.4 Scheduler and executor registry

Scheduler and executor registration are kernel functions, not notebook-surface functions.

The notebook should expose simple status and affordances:

```text
agent available / busy / failed
run queued / running / stopped / complete
interrupt
resume
inspect run
```

But the mechanics belong in the kernel/runtime layer:

```text
executor availability
agent capabilities
run queues
interrupts
handoffs
multi-agent scheduling
failure recovery
session resume
```

The UI should not become a scheduler configuration surface in V1. It should ask the kernel to dispatch a cell and then render the resulting RunFrame, turn bindings, outputs, and artifacts.

### 22.5 Device model

Device and tool registration are also kernel functions.

The notebook may show devices as available capabilities:

```text
filesystem: read-only
shell: disabled
test_runner: available
diff_engine: propose-only
artifact_stream: available
```

But the actual device model belongs below the notebook surface:

```text
device registration
method signatures
permissions
effect boundaries
logs
result artifacts
replayability
```

Cells should not hand-roll device logic. A tool cell invokes one registered device operation; an agent cell may request device calls only through the kernel/device layer.

The V1 rule:

> Tools are devices. Devices are kernel-owned. Cells request device work; they do not define devices.

### 22.6 Checkpoint trust model

Need to know:

```text
who authored the checkpoint
what range it covers
whether operator approved it
whether it is stale
whether it substitutes for raw turns or supplements them
```

### 22.7 Conflict resolution

V1 should borrow simple IPython-like rules.

Executing cells preserve their output while running. The notebook may stream updates into the active output area, but overlay operations that would change the cell’s structural identity are blocked until execution completes or is stopped.

Rules:

```text
no merge during execution
no split during execution unless the run is stopped first
no rebinding an executing cell
no moving an executing cell across zones
no checkpointing a running cell
outputs remain attached to the cell/run that produced them
rerun creates a new run/turn record rather than mutating old provenance
interrupted output is preserved and marked partial
```

This follows the practical spirit of IPython: a cell may execute and preserve its output, but structural editing around active execution should be conservative.

After completion, ordinary overlay edits resume.

The invariant:

> Execution owns the output while it runs. The overlay may organize completed records, not rewrite active execution.

### 22.8 Event schemas

Overlay commits, flow events, run frames, device calls, and context manifests all need durable schemas.

The idea is clear. The contracts need to become boring and exact.

---

## 23. Minimal credible slice

The first build should prove the core model under pressure.

A good V0:

```text
single notebook file
single or two agents
cell = thread
sub-turns
persistent Turn DAG
cell ↔ turn bindings
split/merge overlay commits
basic collapse/expand
basic context manifest
hydrate/replay
simple artifact refs
Inspect mode for one cell
```

A good V1:

```text
multi-agent executors
registered tools/devices
scope policies
pin/exclude
checkpoint
streaming output
artifact windows
source/performance inspector
basic DAG view
```

A good V2:

```text
History mode
branchable overlays
rich ContextPacker
flow routing
macros
breakpoints/watchpoints
multi-operator support
large artifact indexing
```

Do not ship the whole philosophy at once. Ship the core invariant:

> immutable agent trace + mutable cell overlay + inspectable context.

---

## 24. The strongest framing

The notebook is best understood as a small operating system for agentic work.

```text
Cells          instruction blocks
Zones          segments
Agents         semantic executors
Tools          devices
Context        memory/register snapshot
Artifacts      addressable storage
RunFrames      stack frames
Turn DAG       execution trace
Overlay        source/debug layout
History        refactoring log
Inspect        debugger
```

This framing blends cleanly.

But the UI does not need to expose it all at once.

The surface can still look like Jupyter.

The machine underneath should be much more explicit.

---

## 25. Final verdict

What we have is strong because it identifies the real problem:

> Chat lacks a durable, editable structure for stateful work.

And it offers a coherent answer:

> A notebook where cells are semantic instruction blocks over an explicit state machine.

The best parts are already clear:

```text
DAG vs overlay
cell as issuance scope
split/merge as refactoring
context as manifest
agents as executors
tools as devices
zones as workflow scopes
artifacts as streamed addressable memory
progressive disclosure modes
source/performance inspectability
```

The architecture has found its objects.

Now it needs contracts: schemas, invariants, state transitions, permissions, failure modes, and a minimal slice that proves the model can scale without becoming magical.
