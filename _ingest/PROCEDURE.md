# Procedure: Decompose `chat-export-2026-04-26T04-22-39.md` into a Document Tree + Dev Guide + Decision Records

## Context

The repo `llmb_rts_notebook` is a blank slate: only `LICENSE` and a single
1.1 MB / 14,491-line LLM conversation export
(`chat-export-2026-04-26T04-22-39.md`) sit at the root. That conversation is
the entire project so far — it contains an evolving architecture for an
"RTS-metaphor LLM-agent supervisor" / `.llmnb` notebook system, traversing
**~7 distinct phases** and **~5 explicit decision checkpoints** (rendering
substrate → zone architecture → MCP-as-context → tool taxonomy → V1 scope cuts
→ notebook embedding → spec discipline).

A 1 MB monolithic transcript is unreadable, ungreppable in practice, and
loses the architectural decisions inside conversational noise. We need a
**reproducible procedure** that:

1. Segments the chat into a navigable nested folder tree.
2. Uses parallel agents to assess and group turns by topic (not just by
   line range).
3. Splits the source into individual per-turn / per-phase files.
4. Rewrites each cluster into an imperative **dev guide** chapter (current
   state, not Q&A).
5. Extracts explicit **decision records** (ADRs) with options considered,
   choice, and consequences — preserving the *journey* (e.g. "no MCP" →
   "MCP as core") that the dev guide flattens away.

Outcome: the chat export remains as source-of-truth, but the project becomes
a working notebook of design — humans can scan the dev guide, auditors can
trace decisions through ADRs, and any segment can be re-derived from the
preserved raw turns.

---

## Target tree

```
llmb_rts_notebook/
├── LICENSE
├── README.md                                  # NEW — project intro + links
├── chat-export-2026-04-26T04-22-39.md         # PRESERVED, never edited
├── docs/
│   ├── README.md                              # top-level index
│   ├── dev-guide/
│   │   ├── 00-overview.md
│   │   ├── 01-rendering-substrate.md
│   │   ├── 02-zone-architecture.md
│   │   ├── 03-mcp-context-substrate.md
│   │   ├── 04-tool-taxonomy.md
│   │   ├── 05-v1-scope.md
│   │   ├── 06-llmnb-notebook-embedding.md
│   │   └── 07-specification-discipline.md
│   └── decisions/
│       ├── README.md                          # ADR index
│       ├── 0001-vega-as-debug-overlay.md
│       ├── 0002-mcp-as-context-substrate.md
│       ├── 0003-v1-scope-cuts.md
│       ├── 0004-llmnb-unified-state.md
│       └── 0005-rfc-and-bell-system-discipline.md
└── _ingest/                                   # working artifacts (regenerable)
    ├── PROCEDURE.md                           # this procedure, persisted
    ├── manifests/
    │   ├── turns.json                         # turn_id, line_start, line_end, role, hash
    │   ├── phases.json                        # phase_id, name, turn_range, summary, decisions[]
    │   └── reconciliation.md                  # how parallel-agent disagreements were merged
    └── raw/
        └── phase-NN-<slug>/
            ├── 00-overview.md                 # phase summary, links to turns
            ├── turn-NNN-user.md
            └── turn-NNN-assistant.md
```

**Naming rules**:
- Phase slugs are kebab-case, prefixed `01-`..`07-` to enforce reading order.
- Turn IDs are zero-padded 3-digit (`turn-001`..`turn-061`), preserving the
  global order from the source file regardless of which phase they fall in.
- ADR IDs are zero-padded 4-digit (`0001`..`NNNN`), MADR-lite format
  (status / context / decision / consequences / alternatives).

---

## Stage 0 — Snapshot & turn index *(deterministic, no LLM)*

**Goal**: build the addressable backbone before any agent work.

1. Verify `chat-export-2026-04-26T04-22-39.md` SHA-256 and record in
   `_ingest/manifests/source.sha256`. The file is **never** edited after this.
2. Scan for the turn delimiter (`---` on its own line; 122 occurrences ≈ 61
   turns) and emit `_ingest/manifests/turns.json`:
   ```json
   [
     { "turn_id": "001", "role": "user",      "line_start": 3,    "line_end": 47,   "char_count": 1820, "hash": "…" },
     { "turn_id": "002", "role": "assistant", "line_start": 49,   "line_end": 312,  "char_count": 9442, "hash": "…" },
     …
   ]
   ```
   Role is inferred from the `## User` / `## Assistant` heading inside each
   block. Hash is sha256 of the turn body (used later for change detection).
3. Sanity-check: `sum(char_count)` ≈ source size; flag if turn count is odd
   (incomplete trailing turn).

This stage is a small Python or Bash script — write it once into
`_ingest/scripts/build_turn_index.py`. It is the **only** part of the
pipeline that should be re-run automatically if the source changes.

---

## Stage 1 — Phase clustering *(parallel Explore + Plan agents)*

**Goal**: agree on phase boundaries (turn ranges) and topical labels. The
Stage-0 exploration already proposed 7 phases; Stage 1 must *validate or
refine* them, not blindly accept.

### 1a. Launch 3 Explore agents IN PARALLEL, each covering ~5k lines:

| Agent | Range          | Brief                                                                          |
|-------|----------------|--------------------------------------------------------------------------------|
| A     | turns 1–20     | Identify topic shifts. Output `[{turn_start, turn_end, topic, one_line_why}]`. |
| B     | turns 21–40    | Same brief, plus flag any reference back to A's range.                         |
| C     | turns 41–61    | Same brief, plus mark explicit "decisions to lock" / scope-cut moments.        |

Each agent returns a **phase proposal** (JSON list) and a list of candidate
**decision moments** (turn_id + one-line description). Cap each response at
500 words.

### 1b. Reconciliation (1 Plan agent, sequential after 1a):

Input: the three proposals. Task: merge overlaps, resolve disagreements at
phase seams, and emit canonical `_ingest/manifests/phases.json`:

```json
[
  {
    "phase_id": "01",
    "slug": "rendering-substrate",
    "name": "Vega-as-RTS rendering evaluation",
    "turn_range": ["001", "008"],
    "line_range": [1, 612],
    "summary": "Evaluating Vega/Vega-Fusion as a renderer for RTS-style sims; mark-count ceiling; options A/B/C.",
    "decisions": ["DR-0001"]
  },
  …
]
```

Plus `_ingest/manifests/reconciliation.md` recording disagreements and how
they were resolved (one paragraph per seam) — this is the audit trail for
how the tree was decided, and informs the ADRs in Stage 4.

**Stop condition**: reviewer (you) reads `phases.json` and approves. If the
phase count drifts dramatically from the Stage-0 estimate of 7, re-run 1a
with revised ranges before proceeding.

---

## Stage 2 — Segmentation into folder tree *(deterministic, no LLM)*

**Goal**: physically split the source into the `_ingest/raw/` tree.

For each phase in `phases.json`:

1. `mkdir _ingest/raw/phase-NN-<slug>/`
2. For each turn in `turn_range`, slice the source by `[line_start,
   line_end]` from `turns.json` and write `turn-NNN-<role>.md`. Prepend a
   tiny YAML header:
   ```yaml
   ---
   turn_id: 001
   role: user
   phase: 01-rendering-substrate
   source_lines: [3, 47]
   source_sha: <hash from turns.json>
   ---
   ```
3. Write `00-overview.md` containing the phase `summary` from `phases.json`,
   a turn-by-turn table of contents (with relative links), and a list of
   linked decision IDs.

This stage is mechanical — extend `_ingest/scripts/build_turn_index.py` or
write `split_into_phases.py`. **No agent involvement.** Re-running it must be
idempotent: same inputs → same outputs.

---

## Stage 3 — Dev-guide chapter rewrite *(parallel Plan agents, one per phase)*

**Goal**: turn the conversational raw turns into imperative, scannable
chapters under `docs/dev-guide/`.

Launch **one Plan agent per phase** (up to 3 in parallel per round; 7 phases
→ 3 rounds). Each agent gets:

- Read access to `_ingest/raw/phase-NN-<slug>/` (its phase only).
- The phase summary and decisions list from `phases.json`.
- The cross-phase phase index so it can link forward/backward.

Agent prompt skeleton (per phase):

> You are writing chapter `NN-<slug>.md` of a dev guide. Your input is the
> raw conversational turns in `_ingest/raw/phase-NN-<slug>/`. Rewrite as an
> **imperative description of the current design** — not as a Q&A, not as a
> narrative, not as a recap of who said what. Reflect the **latest**
> decisions (the chat shows reversals; the dev guide takes the endpoint).
> Capture the journey only via short "Why not X" subsections where the
> reversal is load-bearing.
>
> Required sections:
> 1. **Purpose** (1–2 sentences).
> 2. **Design** (the current shape: components, interfaces, data, lifecycle).
> 3. **Why this shape** (1–3 short rationales, each tied to a constraint).
> 4. **Why not X** (alternatives that were tried and dropped — link to the
>    relevant ADR for each).
> 5. **Open questions** (what's deferred, what's unresolved).
> 6. **Source turns**: a footer linking back to `_ingest/raw/phase-NN-…/`.
>
> Cap at ~600 lines per chapter. If a phase doesn't have material for a
> section, omit the section rather than padding.

Output goes directly to `docs/dev-guide/NN-<slug>.md`. After all chapters
are written, hand-write `00-overview.md` (~100 lines) that links the chapters
in order with one-paragraph teasers.

---

## Stage 4 — Decision record extraction *(parallel agents, one per decision)*

**Goal**: convert each candidate decision moment from `phases.json` into an
ADR under `docs/decisions/`.

For each `DR-NNNN`:

1. Locate the source turns where the decision crystallized (recorded in
   `phases.json[*].decisions[*].turn_refs`).
2. Launch one agent with read access to those specific turns + the
   corresponding dev-guide chapter (for current-state context).
3. Agent writes `docs/decisions/NNNN-<slug>.md` in **MADR-lite**:

```markdown
# NNNN. <Title>

- **Status**: Accepted | Superseded by NNNN | Proposed
- **Date**: 2026-04-26 (date of source conversation)
- **Deciders**: (extract from chat or "primary author")

## Context
What forced the decision. The constraint, the failure mode, the deadline.

## Decision
The chosen path, stated as an imperative.

## Consequences
- Positive: …
- Negative / cost: …
- Follow-ups required: …

## Alternatives considered
- **<Option A>** — why rejected
- **<Option B>** — why rejected

## Source
- Source turns: `_ingest/raw/phase-NN-<slug>/turn-NNN-*.md`
- Dev guide: `docs/dev-guide/NN-<slug>.md#…`
```

Then write `docs/decisions/README.md` as an index:
`| ID | Title | Status | Supersedes |` table.

**Why MADR-lite over full ADR**: simple, widely-recognized, no template
plumbing, fits the early-project blank-slate state. Can be upgraded later
without breaking links.

Initial ADRs (from Stage-0 survey — final list comes from Stage 1b):

| ID   | Working title                                  | Source turns ~       |
|------|------------------------------------------------|----------------------|
| 0001 | Vega as debug overlay (not core engine)        | turns covering L120–152 |
| 0002 | MCP as context substrate, not peripheral       | L7255–7360           |
| 0003 | V1 scope cuts (no 3D / macOS / bubblewrap …)   | L3700–3809           |
| 0004 | Unified state in `.llmnb` (no sidecars)        | L10868–11067         |
| 0005 | RFC discipline + Bell System layering          | L14374–14489         |

---

## Stage 5 — Top-level wiring

1. Write `docs/README.md`:
   - Two-paragraph project intro (lifted from chapter `00-overview.md`).
   - Links: dev guide table-of-contents, ADR index, raw archive,
     procedure document.
2. Write root `README.md`:
   - One-paragraph "what is this", link to `docs/README.md`,
     license, and a "How this repo was bootstrapped" footnote pointing to
     `_ingest/PROCEDURE.md`.
3. Persist this plan as `_ingest/PROCEDURE.md` so the procedure itself is
   versioned alongside the artifacts it produced.

---

## Critical files to create / modify

| Path                                              | Action  | Origin                       |
|---------------------------------------------------|---------|------------------------------|
| `_ingest/scripts/build_turn_index.py`             | Create  | Stage 0                      |
| `_ingest/scripts/split_into_phases.py`            | Create  | Stage 2                      |
| `_ingest/manifests/turns.json`                    | Create  | Stage 0                      |
| `_ingest/manifests/phases.json`                   | Create  | Stage 1b                     |
| `_ingest/manifests/reconciliation.md`             | Create  | Stage 1b                     |
| `_ingest/raw/phase-NN-<slug>/turn-NNN-*.md`       | Create  | Stage 2 (×~61)               |
| `docs/dev-guide/NN-<slug>.md`                     | Create  | Stage 3 (×7)                 |
| `docs/decisions/NNNN-<slug>.md`                   | Create  | Stage 4 (×~5)                |
| `docs/README.md`, `docs/decisions/README.md`      | Create  | Stage 5                      |
| `README.md` (root)                                | Create  | Stage 5                      |
| `_ingest/PROCEDURE.md`                            | Create  | Stage 5 (this file, copied)  |
| `chat-export-2026-04-26T04-22-39.md`              | **Untouched** | — preserved as source-of-truth |

---

## Reusable utilities to lean on (no new code where avoidable)

- **Turn splitting**: standard Python `re.split(r"^---\s*$", text,
  flags=re.M)` on the source text — no library needed.
- **YAML frontmatter writer**: `pyyaml` if already installed; otherwise a
  10-line manual writer is fine.
- **MADR-lite template**: copy verbatim from this plan; do not introduce a
  templating engine.
- **Agent orchestration**: use the harness's existing parallel-Agent
  capability (multiple `Agent` calls in one assistant turn). Do **not**
  build a new orchestrator.

---

## Verification

End-to-end checks after the procedure runs:

1. **Coverage**: every line in the source maps to exactly one
   `_ingest/raw/.../turn-NNN-*.md`. Script:
   `sum(line_end - line_start + 1 for turn in turns) == total_lines`.
2. **No silent edits**: re-hash each raw turn file's body and compare to
   `turns.json[*].hash` — must match.
3. **Link integrity**: every link in `docs/dev-guide/*.md` and
   `docs/decisions/*.md` resolves to an existing file. Use a simple
   markdown link checker (e.g. `markdown-link-check`) or a 30-line script.
4. **ADR ↔ chapter cross-references**: each ADR's "Source" section names a
   dev-guide chapter that exists, and at least one chapter's "Why not X"
   section links each ADR.
5. **Spot read** (manual, you): read `00-overview.md` cold and confirm a
   newcomer could navigate to any phase in <30 seconds. Read one ADR cold
   and confirm the alternatives + rationale are intelligible without the
   chat export open.
6. **Idempotency**: re-run Stage 0 + Stage 2 scripts on an unchanged
   source; diff should be empty.

---

## Defaults chosen (flag for review)

- **ADR format**: MADR-lite (not full ADR, not Nygard) — simple, no template
  engine.
- **Folder split**: `docs/` for polished output, `_ingest/` for raw +
  manifests + procedure. Underscore prefix signals "regenerable working
  artifacts, not the readme'd surface."
- **Source preservation**: chat export is **never** edited or moved.
  All decomposition is additive.
- **Dev-guide voice**: imperative description of the *current* design;
  reversals captured in ADRs, not in chapter prose.
- **Agent count**: max 3 parallel in any stage (matches Plan-mode guidance,
  avoids rate hits).
- **Scripts vs. one-shot prompts**: deterministic stages (0, 2, 5) are
  scripts, checked in. Semantic stages (1, 3, 4) are agent prompts —
  re-runnable but not byte-stable, which is the right tradeoff.
