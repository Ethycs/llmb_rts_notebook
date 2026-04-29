# Plan: docs/atoms/ refactor — atomic-doc deduplication

**Status**: Plan, ready for execution. 2026-04-28.
**Audience**: an LLM (or operator) picking this up cold. Self-contained.
**Goal**: replace prose duplication across BSPs / FSPs / KBs with a wiki-style atomic-doc layer. One concept = one atom. Originals link to atoms instead of restating definitions.
**Time budget**: ~8h wall-clock with three parallel agents in Phase 3, otherwise ~12h sequential.

---

## §1. Why this work exists

The `docs/notebook/` and `docs/rfcs/` tree has accumulated 25+ documents across:
- 8 BSPs (build sequence proposals)
- 3 FSPs (future spec proposals)
- 9 RFCs
- 2 KB docs (knowledge bases — `KB-cells-and-notebooks.md`, `KB-notebook-target.md`)
- 1 versioning doc, 1 session-log, this plan

The same concepts (Cell, Section, Turn, Overlay commit, etc.) appear in 3-5 docs each, with inconsistent phrasing and the constant risk of drift. When the operator amended `KB-notebook-target.md` with §0 V1 decisions, the existing docs immediately fell out of sync.

The refactor: extract every reusable concept / operation / discipline / decision / anti-pattern into a small atomic file under `docs/atoms/`. Existing docs link out instead of restating. **One canonical place per claim.** Updates happen in the atom; references propagate via the link.

This is the Zettelkasten / wiki approach. It works at this scale (~25 docs, ~50 atoms) because the link graph stays browseable and the atoms stay focused.

---

## §2. Goals and non-goals

### Goals
- Single canonical definition per concept under `docs/atoms/`.
- Originals (BSPs / FSPs / RFCs / KBs) become link-heavy navigation docs that stay valuable for *behavior* / *interaction* / *implementation* — not for definitions.
- The 24 V1 decisions (§4 below) land in `docs/atoms/decisions/` instead of being scattered.
- Future decisions get a new atom under `decisions/` rather than amendment sections in long specs.

### Non-goals
- Don't rewrite RFCs. They're external interfaces and should stay normative as-is. They CAN gain links to atoms, but don't restructure them.
- Don't delete originals. After atomization, the originals remain — they hold behavioral / interaction content that doesn't fit an atom.
- Don't touch code. Pure docs refactor.
- Don't change spec versioning conventions (BSPs still have Issues, RFCs still have versions).

---

## §3. Folder structure

```
docs/atoms/
  README.md                    # how atoms work; link-out conventions
  concepts/                    # what things ARE
    turn.md
    agent.md
    cell.md
    cell-kinds.md
    section.md
    sub-turn.md
    tool-call.md
    overlay-commit.md
    context-manifest.md
    run-frame.md
    artifact-ref.md
    span.md
    output-kind.md
    zone.md                    # kernel-side session id; distinct from section
    blob.md                    # content-addressed storage; references ArtifactRef
  operations/                  # what you can DO
    spawn-agent.md
    continue-turn.md
    branch-agent.md
    revert-agent.md
    stop-agent.md
    split-cell.md
    merge-cells.md
    move-cell.md
    pin-exclude-scratch-checkpoint.md       # collected; the 4 toggle ops are kin
    promote-span.md
    create-section.md
    delete-section.md
    rename-section.md
    apply-overlay-commit.md
    revert-overlay-commit.md
    create-overlay-ref.md
  discipline/                  # invariants / project rules
    zachtronics.md             # tiles not assembly; visible order
    one-cell-one-role.md
    tool-calls-atomic.md       # tool calls atomic, text IO not
    scratch-beats-config.md
    save-is-git-style.md
    immutability-vs-mutability.md   # turn DAG immutable; overlay mutable
    cell-manager-owns-structure.md  # split/merge through Cell Manager only
  decisions/                   # V1 vs V2 calls; pinned with rationale
    v1-flat-sections.md
    v1-no-nesting.md
    v1-runframe-minimal.md
    v1-contextpacker-walk.md
    v1-artifact-shape.md       # V1 inline body, V2 streaming
    v1-output-kind-tag.md
    capabilities-deferred-v2.md
    asgi-deferred.md
    legacy-main-dispatch.md
    no-rebind-popen.md         # respawn_from_config doesn't rebind to PIDs
  anti-patterns/               # already-hit traps; lessons
    rlock-logging.md           # Engineering Guide §11.7
    workspace-shadows-global.md  # Engineering Guide §11.8
    windows-fd-inheritance.md
    path-propagation.md        # extension → kernel boundary
    stub-kernel-race.md        # controller onRunComplete inflight delete
    secret-redaction.md
    bsp-004-retrospective.md   # V1 + V2 attempt failures
    mitmdump-discovery.md      # the lesson from the recent fix
```

**~55 atom files.** Each 30-100 lines. Total ~3000 lines but tightly organized.

---

## §4. The 24 V1 decisions to land in decisions/ atoms

These came out of the 2026-04-28 deconfliction pass and need atom homes. Each row → one decision atom.

| # | Decision | Recommendation pinned during session |
|---|---|---|
| D1 | Section status enum values | Drop the enum in V1; ship `collapsed: bool` + `summary?: string` only. Add status enum in V2. |
| D2 | `tool` vs `tool_cell` naming | Bare `tool` matches enum convention. Update KB-target prose to match. |
| D3 | Section nesting depth | **CONFIRMED flat in V1.** `parent_section_id` field exists but rejected if non-null. V1.5+ unlocks. |
| D4 | Checkpoint cell schema | `{summary_text, covers_cell_ids[], created_at}` + `bound_agent_id: null` (operator-authored only in V1). AI-summarized → V2. |
| D5 | Cell-merge "compatible parent section" | Same section only. No nesting → no parent ambiguity. |
| D6 | Re-merge already-merged cell | **CONFIRMED forbidden** in V1. K94. Operator splits first if needed. |
| D7 | `promote_span` result cell kind | Inferred from span type. `propose_edit` → `artifact`; agent prose → `artifact`; `report_completion` → `checkpoint`. |
| D8 | Dual representation invariant `cells[].section_id` ↔ `sections[].cell_range[]` | Keep both; `MetadataWriter.submit_intent` enforces write-time consistency. |
| S1 | Split boundary | Span-aware. Split allowed (a) between spans, (b) inside text/prose spans at character offset (overlay records offset). Forbidden inside `tool_use` / `tool_result` / `system_message` / `result` spans. |
| S2 | Split single-turn cell | Forbidden. K94. Need ≥2 turns or ≥2 spans worth splitting. |
| S3 | Sub-turn renumbering after split | Reset to flat (no sub-index in either half). Underlying turn DAG is immutable; the split is overlay-only. |
| S4 | Flag propagation on split | Both halves inherit kind / section / pinned / excluded / scratch. Operator adjusts after. |
| S5 | RunFrames pointing at split-original cell | Keep pointing at original `cell_id`. RunFrames are immutable historical records. Inspect mode shows "this run was on cell c_5 (since split into c_5a + c_5b)." |
| S6 | New cell position after split | Immediately after original, same section. |
| M1 | `move_cell` cross-section | Allowed. |
| M2 | `move_cell` cross-checkpoint | Forbidden. K-class error. Checkpoints are unmergeable boundaries per KB-target §22.1. |
| M3 | `move_cell` destination position | Explicit `(target_section_id, position_index)` required. No auto-tail. |
| SD1 | Delete non-empty section | Forbidden. K-class error. Empty first via move/delete. |
| SD2 | Rename section | `id` immutable. `title` mutable. |
| SD3 | Create section position | Operator specifies parent + position. Default = root section, end of notebook. |
| CK1 | Checkpoint authorship | Operator-only in V1. AI-authored → V2 (KB-target §22.6 trust model). |
| CK2 | Post-checkpoint cell state | Overlay-frozen. Read-only via overlay layer. Underlying turns valid. |
| CK3 | Checkpoint reversibility | Yes via `revert_to_commit` (BSP-007). Or explicit `uncheckpoint_section`. |
| F1 | Flag-toggle effect on existing RunFrames | None. RunFrames are immutable. New runs see new flag state. |

Plus three architectural decisions surfaced late in the session:
- **Cell Manager owns split/merge** → `discipline/cell-manager-owns-structure.md` atom + atom in `concepts/` for the Cell Manager itself? Decide during execution.
- **No nesting** → already in D3 + D6 atoms.
- **Tool calls atomic, text IO not** → `discipline/tool-calls-atomic.md` atom + S1 decision atom.

---

## §5. Atom template

```markdown
# {Concept name}

**Status**: `V1 shipped` | `V1 spec'd` | `V2 reserved` | `V3+` | `discipline` | `anti-pattern` | `decision`
**Source specs**: links to the BSP / RFC / KB sections that originally defined or use this concept
**Related atoms**: links to other atoms in this graph

## Definition
ONE paragraph. The canonical claim about this thing.

## Schema (if applicable)
```jsonc
{
  field: type,
  ...
}
```

## Invariants (bullet list, each testable)
- ...
- ...

## V1 vs V2+ (when applicable)
- **V1**: what ships now
- **V2+**: how it expands

## See also (link-out to ops / disciplines / anti-patterns that touch this atom)
- [op-x](../operations/op-x.md)
- [discipline-y](../discipline/discipline-y.md)
```

**Atom rules:**
1. Each atom is ≤120 lines.
2. Atoms are NORMATIVE for definitions. Originals are NORMATIVE for behaviors / wire formats / interactions.
3. Cross-references to specs use stable section anchors: `[BSP-002 §13.1](../BSP-002-conversation-graph.md#131-section-as-overlay-graph-concept)`.
4. Each atom is referenced by ≥2 other docs (atoms or originals). If only one doc cites it, fold it back; don't ship orphan atoms.
5. No emojis. No backwards-compat shims.

---

## §6. Phase-by-phase plan

### Phase 1 — Proof of concept (operator does this; ~1.5h)

Write **8 representative atoms** covering all 5 categories so the pattern is concrete:

1. `concepts/cell.md`
2. `concepts/cell-kinds.md`
3. `concepts/section.md`
4. `operations/split-cell.md`
5. `discipline/tool-calls-atomic.md`
6. `decisions/v1-flat-sections.md`
7. `anti-patterns/rlock-logging.md`
8. `concepts/turn.md`

Plus a `docs/atoms/README.md` that explains the pattern, the atom rules from §5, and the link-out convention.

Goal: see the shape. Refine if needed.

### Phase 2 — Review + refine (~30min)

Read the 8 atoms together. Are they too short? Too long? Are the link patterns useful? Is the atom rule "≥2 references" sustainable?

If the pattern works → Phase 3. If not → adjust the atom shape and re-do Phase 1.

### Phase 3 — Parallel atom authoring (3 sub-agents, ~3-4h wall clock)

Dispatch three sub-agents IN PARALLEL, each owning ~15 atoms. File-disjoint by category.

**Agent A — concepts + zone:** writes `concepts/*.md` (15 atoms) plus the `concepts/zone.md` clarifier and `concepts/blob.md`. Source content: KB-target §3-§17, BSP-002 §2-§3, BSP-007 §2, BSP-008 §4-§7.

**Agent B — operations + discipline:** writes `operations/*.md` (15 atoms) and `discipline/*.md` (7 atoms). Source: BSP-002 §3-§5, BSP-007 §3-§6, KB-target §13. Cross-reference D1-D8 / S1-S6 / M1-M3 / SD1-SD3 / CK1-CK3 from §4 of this plan.

**Agent C — decisions + anti-patterns:** writes `decisions/*.md` (10 atoms) and `anti-patterns/*.md` (8 atoms). Source: §4 of this plan for decisions; Engineering Guide §11 for anti-patterns; BSP-004 v2.0.1 retrospective for the BSP-004 anti-pattern; this session's commit history for `mitmdump-discovery.md` and `bsp-004-retrospective.md`.

Each sub-agent has a strict brief:
- Read this plan in full.
- Read the source specs for their category.
- Write the assigned atoms following §5 template.
- Don't touch other categories.
- Don't touch originals (KB-target, BSPs, FSPs, RFCs).
- Don't touch code.
- Each atom ≤120 lines.
- Verify ≥2 cross-references per atom.
- Report file count + line totals + any source-content ambiguities.

### Phase 4 — Refactor originals to link to atoms (~2h)

Six docs need link-out refactoring:

1. `docs/notebook/KB-notebook-target.md` — body still has prose definitions of Section, Cell, Sub-turn, RunFrame, etc. Replace with atom links: `See [Cell](atoms/concepts/cell.md), [Section](atoms/concepts/section.md).` Keep the architectural narrative. **§0 V1 amendments collapse — they're now in `decisions/v1-*.md` atoms.**
2. `docs/notebook/KB-cells-and-notebooks.md` — fully delete. Its content is now spread across atoms + the spec navigation can rebuild from KB-target's body.
3. `docs/notebook/BSP-002-conversation-graph.md` — Issue 1 stays prose-heavy (it's the original spec). Issue 2 §13 collapses to "see atoms: [...]." Behavior + wire-format content stays in BSP-002.
4. `docs/notebook/BSP-005-cell-roadmap.md` — slice ladder stays. Each slice cell links its dependent atoms.
5. `docs/notebook/BSP-007-overlay-git-semantics.md` — operations §3 collapses to "see atoms/operations/*.md." Behavior (apply_commit, revert_to_commit) stays in BSP-007.
6. `docs/notebook/BSP-008-contextpacker-runframes.md` — schema sections collapse to atom links. Algorithm + module placement stays.

After Phase 4, every concept appears in EXACTLY ONE place (the atom). Behavioral content (how the kernel orchestrates the concept) lives in the relevant BSP, with atom links.

### Phase 5 — Verification + commit (~30min)

1. **Reference graph check**: every atom referenced by ≥2 other docs. Use grep:
   ```bash
   for atom in docs/atoms/**/*.md; do
     refs=$(grep -rl "$atom" docs/ | grep -v "^$atom$" | wc -l)
     [[ $refs -lt 2 ]] && echo "ORPHAN: $atom"
   done
   ```
2. **Drift check**: search for definition-style prose in originals that should have been replaced. Heuristic: any heading "## Definition" in BSPs / KBs — should not exist in originals after Phase 4.
3. **Link integrity**: every link resolves. Use markdown-link-check or a simple grep for `[*](atoms/*)` patterns.
4. **Git diff review**: scope correct (originals shrank or got linkier; atoms appeared; KB-cells deleted).
5. **One atomic commit** per phase, or one bigger commit for Phases 3+4+5 if the atom set is stable.

---

## §7. Operator follow-ups landing in this refactor

Five items from the prior session's deconfliction commit message land naturally as part of Phase 4:

- **Op-1**: BSP-005 Issue 2 — slice ladder updates (S0.5 cell kinds, S5.5 sections). Land in BSP-005 amendment + each new slice gets atom links.
- **Op-2**: KB-cells-and-notebooks.md §3 — moot once KB-cells is deleted. Cell-types content lives in `atoms/concepts/cell-kinds.md`.
- **Op-3**: RFC-005 mirror ArtifactRef shape. Land as RFC-005 minor bump; RFC-005 §"Blobs" subsection links to `atoms/concepts/artifact-ref.md`.
- **Op-4**: RFC-006 v2.0.4 register `llmnb.section_id` + `llmnb.output.kind` situational attributes. Land as RFC-006 minor amendment; subsections link to `atoms/concepts/section.md` and `atoms/concepts/output-kind.md`.
- **Op-5**: BSP-003 §5 registry — add 5 new intent_kinds (`apply_overlay_commit`, `revert_overlay_to_commit`, `create_overlay_ref`, `record_context_manifest`, `record_run_frame`). Land as BSP-003 amendment; each entry links to its operation atom.

These can fold into Phase 4 or be a Phase 4.5 — either way ~30min total.

---

## §8. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Atom abstraction creep — every noun becomes an atom doc | Medium | Hard rule: each atom must be referenced by ≥2 other docs. Fail Phase 5 verification → fold orphans back into the consumer doc. |
| Reference rot — markdown links break on file moves | Low | Stable relative paths under `docs/atoms/`. Never rename or move atom files once shipped. Renames go through deprecation (atom file becomes a stub with a forward link). |
| Phase 3 agents drift — different agents pick different conventions | Medium | Each agent's brief includes the §5 template verbatim. Phase 5 verification catches drift via grep. |
| Phase 4 misses prose-replacement opportunities | Medium | Phase 5 §"Drift check" greps for "## Definition" headings; flag any in non-atoms. Operator scans the diff for prose that should have linked out. |
| Atom doc becomes a bottleneck — single source of truth means single point of failure | Low at this scale | If an atom needs to express ambiguity, it has a dedicated `## Open questions` section with TODO links to GitHub issues or a specific decision atom. |
| Originals (BSPs / RFCs) lose context when prose is moved out | Low | Originals keep their introductions / motivations / behaviors. Only the *definitional* parts move out. Behavioral / interaction prose stays in the original. |

---

## §9. Cross-references — what the executing LLM should read first

Before starting Phase 1, the executing LLM should read:

1. **This plan** in full.
2. `docs/notebook/KB-notebook-target.md` — especially §0 (V1 amendments) and §3-§17.
3. `docs/notebook/BSP-002-conversation-graph.md` — Issue 1 §1-§3 + Issue 2 §13.
4. `docs/notebook/BSP-005-cell-roadmap.md` — slice ladder.
5. `docs/notebook/BSP-007-overlay-git-semantics.md` — overlay commit model.
6. `docs/notebook/BSP-008-contextpacker-runframes.md` — ContextPacker + RunFrames.
7. `Engineering_Guide.md` §11 — anti-patterns.

Optional but useful:
- `docs/notebook/KB-cells-and-notebooks.md` — will be deleted in Phase 4 but is the closest existing model of "agent-ready single reference doc."
- `docs/rfcs/RFC-009-zone-control-and-config.md` — for `decisions/path-propagation.md` and `anti-patterns/path-propagation.md` content.

---

## §10. Success criteria

The refactor is done when:

1. `docs/atoms/` exists with ~50 atoms across 5 subdirectories.
2. Every concept / operation / discipline / decision / anti-pattern from this session has a dedicated atom.
3. KB-cells-and-notebooks.md is deleted.
4. KB-notebook-target.md, BSP-002, BSP-005, BSP-007, BSP-008 contain ≥80% link-outs (vs ≤20% prose definitions).
5. Phase 5 verification passes:
   - No orphan atoms.
   - No "## Definition" headings remain in non-atoms.
   - Every markdown link resolves.
6. The 5 operator follow-ups (§7 above) land as part of the work.
7. The 24 V1 decisions (§4) each have a dedicated `decisions/*.md` atom with the rationale.
8. Engineering Guide stays as-is — anti-patterns there can be cross-referenced FROM atoms but the Guide doesn't shrink.

---

## §11. What this plan deliberately does NOT include

- Any code changes. The kernel and extension stay unchanged.
- Any wire format changes. RFC-006 / RFC-008 stay normative as-is (with link-outs added in Op-4).
- Any spec amendments to the *behavioral* content of BSPs. Only definitional prose moves to atoms.
- Any tests. Atoms are docs, not code.
- Implementation of any of the 24 V1 decisions. Decisions are *recorded* in atoms; implementation is separate slices in BSP-005.

---

## §12. Hand-off

After Phase 5 commits, the next operator (or LLM session) inherits:
- A clean `docs/atoms/` directory with ~50 reusable atoms.
- Originals that link out instead of restating.
- A pending implementation roadmap (BSP-005 slices) that references the atoms it implements.
- The 24 V1 decisions pinned with rationale; future decisions get a new `decisions/*.md` atom rather than amending an existing spec.

Future work that becomes easier:
- Adding new V1 / V2 decisions: write a new atom under `decisions/`. Done.
- Adding new operations: one atom under `operations/`. Spec amendments link to it.
- Onboarding a new operator or agent: read `docs/atoms/README.md` + browse atoms relevant to their slice. Faster than reading 5 specs.
- Catching drift: Phase 5 verification can be re-run periodically.

---

## Changelog

- **2026-04-28**: initial plan. ~55 atoms across 5 categories. 5-phase execution. ~8h wall clock with parallel agents in Phase 3.
