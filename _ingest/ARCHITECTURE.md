# `_ingest/` pipeline architecture

This document explains how a 1.1 MB monolithic LLM conversation export
(`chat-export-2026-04-26T04-22-39.md` at the repo root) is decomposed into a
navigable nested document tree, an imperative dev guide, and a set of
decision records.

The pipeline mixes **deterministic Python scripts** (for byte-stable,
addressable artifacts) with **subagent invocations** (for semantic work
that an LLM does better than a regex). Each stage's output is the next
stage's input.

```
   chat-export-…md  ──►  Stage 0 ──►  Stage 1 ──►  Stage 2 ──►  Stage 3 ──►  Stage 4 ──►  Stage 5
   (1.1 MB, 14.5k    │   (script)      (agents)     (script)     (agents)     (agents)     (manual)
    lines, immutable)│
                     │
                     ▼
              source.sha256 → turns.json → phases.json → _ingest/raw/ → docs/dev-guide/ → docs/decisions/ → docs/README.md
                                            decisions.json
                                            reconciliation.md
```

Read top-to-bottom: **scripts are byte-stable and re-runnable; agents are
re-runnable but produce semantically equivalent rather than byte-identical
output**. Idempotency claims apply per stage.

---

## Repo layout after pipeline runs

```
llmb_rts_notebook/
├── chat-export-2026-04-26T04-22-39.md   # source-of-truth, NEVER edited
├── pyproject.toml                       # pixi workspace (Python env)
├── pixi.lock
├── docs/                                # polished output (human-facing)
│   ├── README.md                        # top-level index
│   ├── dev-guide/
│   │   ├── 00-overview.md
│   │   ├── 01-vega-rendering-substrate.md
│   │   ├── …                            # one chapter per phase
│   │   └── 08-blockers-mediator-standards.md
│   └── decisions/
│       ├── README.md                    # ADR index
│       ├── 0001-…md                     # one ADR per decision
│       └── …
└── _ingest/                             # working artifacts (regenerable)
    ├── ARCHITECTURE.md                  # this file
    ├── PROCEDURE.md                     # persisted plan (Stage 5)
    ├── scripts/
    │   ├── build_turn_index.py          # Stage 0
    │   ├── split_into_phases.py         # Stage 2
    │   └── diag_alternation.py          # one-off diagnostic
    ├── manifests/
    │   ├── source.sha256                # immutable hash of the source
    │   ├── turns.json                   # 121 sub-turns + 105 merged turns
    │   ├── phases.json                  # 8 canonical phases
    │   ├── decisions.json               # 16 canonical decisions
    │   └── reconciliation.md            # how 14 raw → 8 canonical
    └── raw/                             # preserved source slices, traceable
        ├── phase-01-vega-rendering-substrate/
        │   ├── 00-overview.md
        │   ├── turn-001-user.md
        │   ├── turn-002-assistant.md
        │   └── …
        └── phase-…/
```

---

## The ground-truth model: turns and merged turns

The source uses `---` lines as turn delimiters and `## User` / `## Assistant`
H2 headings as role markers. Two facts surfaced during Stage 0 that shape
every later stage:

1. **The export emits one `## Role` block per text segment between tool
   calls.** A single conversational reply can therefore span multiple
   consecutive same-role blocks (e.g. one short "I'll search…" stub before
   a tool call, then the substantive answer after). 122 `---` delimiters
   produce **121 raw sub-turns**, but only **105 logical (merged) turns**
   when consecutive same-role blocks are collapsed.
2. **Sub-turns are the addressable unit; merged turns are the semantic
   unit.** Files in `_ingest/raw/` are one-per-sub-turn (so byte-level
   provenance is preserved). Phases reference *merged* turn IDs (so
   topical reasoning isn't fragmented by export artifacts).

Both views live in `manifests/turns.json`:

```json
{
  "source": { "sha256": "…", "byte_count": 1104064, "line_count": 14492 },
  "stats":  { "turn_count": 121, "merged_turn_count": 105, "merged_alternation_ok": true },
  "merged_turns": [ { "merged_id": "001", "role": "user", "sub_turn_ids": ["001"], … } ],
  "turns":        [ { "turn_id": "001", "role": "user", "merged_id": "001", "hash": "…", … } ],
  "extras":       [ { "kind": "preamble", … }, { "kind": "postamble", … } ]
}
```

`turns[*].hash` is sha256 of the raw byte body of that sub-turn. This is
the integrity anchor — Stage 5 verification re-hashes each `_ingest/raw/`
file body against this to prove no silent edits.

---

## Stage 0 — `build_turn_index.py` *(deterministic)*

**Run with:** `pixi run build-turn-index`

**Inputs:** `chat-export-2026-04-26T04-22-39.md`
**Outputs:** `manifests/source.sha256`, `manifests/turns.json`

What it does:

1. Hash the source (sha256) and pin it in `source.sha256`.
2. Find every `---` delimiter that is *not* inside a fenced code block
   (so horizontal rules in assistant prose don't split turns). Code-fence
   tracking is line-by-line, fence marker tracked as `^(?:```|~~~)`.
3. For each section between two delimiters, look for `## User` /
   `## Assistant` heading → that's a sub-turn with role and source-line
   range. Sections without a role heading (preamble before the first
   delimiter, postamble after the last) become `extras`, not turns.
4. Collapse consecutive same-role sub-turns into **merged turns** so
   downstream phase reasoning operates on logical conversation turns.
5. Write `turns.json`. Sanity check: merged turns must strictly alternate
   user/assistant — if not, there's a parsing bug to diagnose.

The script has zero LLM dependencies and is idempotent. Re-run it any
time the source changes (it currently won't change, but the structural
guarantee matters).

---

## Stage 1 — Phase clustering *(parallel agents + reconciliation)*

This stage produces the answer to "where are the topical seams in 105
turns of architectural conversation?"

### 1a — Three parallel `Explore` proposals

Three Explore subagents are dispatched concurrently, each covering a
contiguous third of the merged turns:

| Agent | Range          | Special instruction                                          |
|-------|----------------|--------------------------------------------------------------|
| A     | turns 001–035  | Identify topic shifts, propose phases, list decision moments |
| B     | turns 036–070  | …plus flag any back-references to A's range                  |
| C     | turns 071–105  | …plus tag scope-cut/lock-in decisions explicitly             |

Each returns a JSON proposal:
- 2–5 phases (turn range, slug, one-sentence why)
- candidate decision moments (turn refs + one-line description)

**Why parallel agents instead of one big agent?** Three independent reads
expose disagreement at the seams. A single agent would silently smooth
over discontinuities; the disagreement signal is what Stage 1b uses to
calibrate phase boundaries.

### 1b — Reconciliation `Plan` agent

A single Plan agent ingests all three proposals plus `turns.json` and
emits the canonical:

- `manifests/phases.json` — 8 phases, contiguous turn coverage 001–105
- `manifests/decisions.json` — 16 decisions, each tagged `PIVOT` /
  `LOCK-IN` / `SCOPE-CUT`
- `manifests/reconciliation.md` — narrative of merge decisions and
  dissolved seams

The reconciler decides:

- which agent-coverage seams (035→036, 070→071) are real topic boundaries
  vs. artifacts of where the agent ranges happened to fall
- which over-fragmented phases to merge (the four sub-phases of
  "VS Code as substrate" were collapsed into one phase)
- which decisions were named twice in different proposals and need
  deduplication

The 14-raw → 8-canonical merge is recorded in `reconciliation.md`. Each
phase has a `notes` field linking back to its `source_proposals`.

**Cross-reference validation** runs after this stage (inline Python):
every decision's phase_id matches a phase whose turn range contains the
decision's `merged_turn_refs`; every decision listed in a phase's
`decision_ids` exists in `decisions.json`. Three real bugs were caught
and fixed (decisions assigned to the wrong phase; turn refs spanning a
phase seam).

---

## Stage 2 — `split_into_phases.py` *(deterministic)*

**Run with:** `pixi run split-into-phases`

**Inputs:** `manifests/turns.json`, `manifests/phases.json`,
`manifests/decisions.json`, source file
**Outputs:** `_ingest/raw/phase-NN-<slug>/00-overview.md` plus one
`turn-NNN-<role>.md` per sub-turn

What it does:

1. Wipe `_ingest/raw/` (idempotent regeneration; no leftover files
   from a previous phase manifest).
2. For each phase, expand its merged turn range into the underlying
   sub-turn IDs via `turns.json`.
3. Slice the source by each sub-turn's `byte_start`/`byte_end` and
   write `turn-NNN-<role>.md` with a YAML frontmatter (turn_id,
   merged_id, role, phase, source_lines, source_sha256, char_count).
4. Write `00-overview.md` per phase with: phase header, summary,
   decisions-in-this-phase list (linked to ADR IDs), sub-turn
   table-of-contents (linked), and reconciliation notes from the
   manifest.

After this stage, every byte of the source is reachable through
`_ingest/raw/` with full provenance. The source file itself is still
untouched — `_ingest/raw/` is a read view, not a fork.

---

## Stage 3 — Dev-guide chapters *(parallel agents, semantic rewrite)*

**Goal:** rewrite each phase's raw turns as an imperative chapter under
`docs/dev-guide/NN-<slug>.md`.

The voice rule: **state the design as fact, not history**. The chat
shows reversals (early features get cut, models get replaced); the dev
guide takes the endpoint. Reversals only appear as short "Why not X"
subsections where the reversal is load-bearing.

Required chapter sections:
1. **Purpose** (1–2 sentences)
2. **Design** (current shape: components, interfaces, data, lifecycle)
3. **Why this shape** (rationales tied to constraints)
4. **Why not X** (alternatives that were tried and dropped — link to ADR)
5. **Open questions** (deferred / unresolved)
6. **Source turns** (footer linking back to `_ingest/raw/`)

**Agent type:** `general-purpose` (Plan agents are read-only and can't
Write; the first round of three Plan agents returned chapter content as
text and the orchestrator wrote it to disk manually. Subsequent rounds
use general-purpose agents that write directly).

Three chapters in parallel per round; 8 phases → 3 rounds.

---

## Stage 4 — Decision records *(parallel agents)*

**Goal:** convert each decision in `manifests/decisions.json` into an
ADR under `docs/decisions/NNNN-<slug>.md` in **MADR-lite** format:

```markdown
# NNNN. <Title>
- **Status:** Accepted | Superseded by NNNN | Proposed
- **Date:** 2026-04-26
- **Tag:** PIVOT | LOCK-IN | SCOPE-CUT

## Context — what forced the decision
## Decision — the chosen path, imperative
## Consequences — positive / negative / follow-ups
## Alternatives considered — option, why rejected
## Source — raw turns + dev-guide chapter
```

One agent per ADR (16 total, 3 in parallel per round). Then write
`docs/decisions/README.md` as the index table.

---

## Stage 5 — Top-level wiring *(manual)*

1. `docs/README.md` — two-paragraph project intro + links to dev guide
   and ADR index.
2. Root `README.md` — one-paragraph "what is this", license, footnote
   pointing to `_ingest/PROCEDURE.md`.
3. Persist the original plan as `_ingest/PROCEDURE.md` so the procedure
   is versioned alongside the artifacts it produced.

---

## Verification

End-to-end checks (Stage 5 onward):

| Check | What it proves | How |
|-------|----------------|-----|
| Coverage | every source line maps into some `_ingest/raw/turn-NNN-*.md` | sum of `(line_end-line_start+1)` over turns + extras = total_lines |
| No silent edits | no `_ingest/raw/` body has been hand-edited since Stage 2 | re-hash each turn body, compare against `turns.json[*].hash` |
| Link integrity | all relative links in `docs/` resolve | run a markdown link checker (or 30-line script) |
| ADR ↔ chapter cross-refs | every ADR's `Source` names an existing chapter; each chapter's `Why not X` links the relevant ADR | grep + manifest cross-walk |
| Idempotency | re-running Stage 0 + Stage 2 produces no diff | `git status` after re-run |

---

## Re-running

| Stage | Command | Notes |
|-------|---------|-------|
| 0 | `pixi run build-turn-index` | Always safe; byte-stable. |
| 1 | (manual: 3 Explore agents + 1 Plan reconciliation) | Re-running may produce slightly different phase boundaries because LLM output is non-deterministic. Inspect `phases.json` diff before committing. |
| 2 | `pixi run split-into-phases` | Always safe; wipes `_ingest/raw/` and rebuilds. |
| 3 | (manual: 8 general-purpose agents, one per chapter) | Each chapter is independent — re-run only the chapter you want to refresh. |
| 4 | (manual: 16 agents, one per ADR) | Same: per-ADR re-runs are independent. |
| 5 | (manual write of READMEs) | Trivial; do once. |

Stage 0 and Stage 2 should be re-run if the source ever changes (it
shouldn't). Stages 1, 3, and 4 should be re-run only if the *manifest*
or *raw turns* change beneath them.

---

## Why this split?

- **Scripts where bytes matter** (turn segmentation, phase splitting):
  the cost of a regex-vs-LLM disagreement is silent data loss. Use a
  script.
- **Agents where meaning matters** (phase clustering, chapter writing,
  ADR extraction): the cost of a script-vs-LLM disagreement is a wooden
  document that nobody reads. Use an agent.
- **Manifests as the contract between layers**: scripts and agents both
  read from / write to `manifests/`. The manifests are the project's
  schema; everything else is generated from them. Validate them
  aggressively (cross-reference checks, contiguity checks) because every
  downstream artifact depends on them.

The chat export itself is the only true source-of-truth, but the
manifests are the *operational* source-of-truth — they encode the
project's segmentation decisions in machine-readable form. If you ever
need to re-decompose the chat (different phase choices, different
chapter structure), edit the manifests and re-run from Stage 2.
