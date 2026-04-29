# Plan: Atom hygiene — pre-implementation cleanup

**Status**: ready
**Audience**: an LLM (or operator) picking this up cold. Self-contained.
**Goal**: clean up six Status-field updates, one protocol field-name fix, and four invented-default pin-downs in `docs/atoms/` so the implementation agents reading these atoms as briefs don't propagate drift into code. Verify with the orphan + drift detector run from [docs/atoms/README.md §"Verification"](../atoms/README.md).
**Time budget**: ≤1 day, single-agent. Pure-docs. Should run BEFORE the implementation agents start consuming atoms.

---

## §1. Why this work exists

`docs/atoms/` was built in [PLAN-atom-refactor.md](PLAN-atom-refactor.md) as the canonical layer over the longer specs. The refactor landed cleanly, but the V1 atom corpus has accumulated three categories of drift since the initial commit:

1. **Stale Status fields.** Several operation atoms carry `Status: V1 spec'd (lands with X slice)` even though the slice has not yet shipped — that's correct — but their wording also implies the operations are blocked on infrastructure that's listed elsewhere. The Status enum from [docs/atoms/README.md](../atoms/README.md) is `V1 shipped | V1 spec'd | V2 reserved | V3+ | discipline | anti-pattern | decision | protocol | contract`. Six atoms have inconsistent or stale Status lines that need normalization.

2. **Operator-action protocol field-name drift.** The `agent_continue` parameter shape uses `message` in [protocols/operator-action](../atoms/protocols/operator-action.md) and [operations/continue-turn](../atoms/operations/continue-turn.md), but per the original instruction this PLAN was briefed with, the `message` field name is the inconsistency target — the canonical spelling per the broader corpus is `text`. The hygiene fix is to flip the atom's wire-shape table from `message` to `text` and verify alignment with the kernel's existing `agent_continue` handler. **Operator confirmation required** — see §6 risk row.

3. **Four invented defaults that need pinning.** The atoms allude to but do not pin:
   - Default `runtime_status: "idle"` for hydrated agents whose process is not currently alive.
   - Default `provider: "claude-code"` when an agent envelope omits `provider`.
   - K24 (`--resume <session_id>` failed) 0.5-second probe window before declaring resume failure.
   - `supervisor_resume_failed_k24` marker stage name used in the supervisor's restart-window state machine.

   Each is a real V1 invariant; each currently lives only in implementation comments or test fixtures. Pinning them as atom-side text closes a "if it's not in an atom, it's not normative" gap.

This plan ratifies all three categories and runs the drift detector to verify.

## §2. Goals and non-goals

### Goals

- Six atom Status-field updates land consistently with the README's Status enum vocabulary.
- The `agent_continue` parameter field name is consistent across atoms (per operator confirmation in §6).
- The four invented defaults each get one explicit atom location.
- Drift-detector run from [docs/atoms/README.md §"Verification"](../atoms/README.md) reports clean.
- Orphan-atom check reports clean (no atom referenced fewer than twice).

### Non-goals

- This plan does NOT modify atom **content beyond** the Status / wire-shape / default-value lines. Behavioral, schema, or invariant changes go through [PLAN-atom-refactor.md](PLAN-atom-refactor.md) or a fresh atom PR.
- This plan does NOT touch code. The kernel's `agent_continue` handler already accepts the field; the question is purely which name the atom documents.
- This plan does NOT introduce new atoms.
- This plan does NOT amend BSPs or RFCs.

## §3. Concrete work

### §3.1 The 6 Status updates

Rationalize Status lines on these atoms. Each currently says `V1 spec'd (lands with ...)`; the goal is consistent wording per the README enum + a clear sibling-PLAN reference for when status will flip.

| Atom | Current Status | Updated Status |
|---|---|---|
| [operations/split-cell.md](../atoms/operations/split-cell.md) | `V1 spec'd (lands with overlay-commit infrastructure in BSP-005 S5.5+)` | `V1 spec'd (ships with [PLAN-S5.5-sections.md](../notebook/PLAN-S5.5-sections.md) + G10 from [PLAN-substrate-gap-closure.md](../notebook/PLAN-substrate-gap-closure.md))` |
| [operations/merge-cells.md](../atoms/operations/merge-cells.md) | same wording | same updated reference |
| [operations/promote-span.md](../atoms/operations/promote-span.md) | `V1 spec'd (lands with overlay-commit infrastructure)` | `V1 spec'd (ships with [PLAN-M-series.md](../notebook/PLAN-M-series.md) + G10)` |
| [operations/move-cell.md](../atoms/operations/move-cell.md) | `V1 spec'd (lands with BSP-005 S5.5)` | `V1 spec'd (ships with [PLAN-S5.5-sections.md](../notebook/PLAN-S5.5-sections.md))` |
| [operations/apply-overlay-commit.md](../atoms/operations/apply-overlay-commit.md) | `V1 spec'd (BSP-007 K-OVERLAY slice)` | `V1 spec'd (ships with G2 + G8 from [PLAN-substrate-gap-closure.md](../notebook/PLAN-substrate-gap-closure.md))` |
| [concepts/section.md](../atoms/concepts/section.md) | `V1 spec'd (S5.5 in BSP-005)` | `V1 spec'd (ships with [PLAN-S5.5-sections.md](../notebook/PLAN-S5.5-sections.md))` |

The wording template:

```
**Status**: V1 spec'd (ships with [PLAN-X.md](../notebook/PLAN-X.md))
```

When the slice ships, the Status flips to `V1 shipped` and the parenthetical is removed (or replaced with the commit SHA).

### §3.2 The `operator-action.md` field-name fix

In [protocols/operator-action.md](../atoms/protocols/operator-action.md), the action-type catalogue table currently has:

```
| `agent_continue` | `{agent_id, message, cell_id}` | BSP-002 §3 |
```

The fix per this plan's brief: rename `message` → `text` in the catalogue row AND in [operations/continue-turn.md](../atoms/operations/continue-turn.md) §"Operation signature" Kernel envelope.

**However**: the kernel implementation today uses `message` per `vendor/LLMKernel/llm_kernel/custom_messages.py` (verify before flipping). If the implementation also says `message`, the atom is correct and the fix is the OTHER way — flag as an open item for the operator. See §6 risk row "field-name direction".

### §3.3 The 4 invented defaults to pin

Pin each into one atom location so future agents can reference them by atom path.

1. **Default `runtime_status="idle"` for hydrated agents.** Add to [concepts/agent.md](../atoms/concepts/agent.md) §"Invariants":
   ```
   - **Hydrated agents default to `runtime_status: "idle"`.** When `MetadataWriter.hydrate(...)` restores an agent record, the runtime status is forced to `idle` regardless of what was persisted; the supervisor's post-hydrate respawn discipline (see [no-rebind-popen](../decisions/no-rebind-popen.md)) decides whether to resume or leave dormant.
   ```

2. **Default `provider="claude-code"`.** Add to [concepts/agent.md](../atoms/concepts/agent.md) §"Invariants":
   ```
   - **`provider` defaults to `"claude-code"` when omitted.** V1 supports only `claude-code`; envelope omission is treated as the default rather than a wire failure.
   ```

3. **K24 0.5-second probe window.** Add to [contracts/agent-supervisor.md](../atoms/contracts/agent-supervisor.md) §"Invariants":
   ```
   - **K24 0.5-second probe window.** A `claude --resume <session_id>` invocation that exits within 500ms of spawn raises K24 (`resume_failed`); successful resumes always survive the probe window.
   ```

4. **`supervisor_resume_failed_k24` marker stage name.** Add to [contracts/agent-supervisor.md](../atoms/contracts/agent-supervisor.md) §"Invariants":
   ```
   - **`supervisor_resume_failed_k24` is the canonical stage name** used in the supervisor's restart-window state machine to mark a probe-window resume failure. Test fixtures and log-grep queries depend on this exact spelling.
   ```

Each addition is one bullet. None changes the atom's schema or invariants count materially; the bullets clarify behavior already in the implementation.

## §4. Interface contracts

This plan modifies docs only — no wire or code interfaces. The only "interface" is the [docs/atoms/README.md §"Atom rules"](../atoms/README.md) shape:

- Atom Status field uses one value from the enum.
- Cross-references use stable section anchors.
- Each atom referenced ≥2 times.

The hygiene work preserves all three.

## §5. Test surface

No code tests. Verification is the drift-detector and orphan-check pair from [docs/atoms/README.md §"Verification"](../atoms/README.md):

```bash
# Orphan check
for atom in docs/atoms/**/*.md; do
  refs=$(grep -rl --include='*.md' "$(basename $atom)" docs/ | grep -v "^$atom$" | wc -l)
  [[ $refs -lt 2 ]] && echo "ORPHAN: $atom ($refs refs)"
done

# Drift check — Definition headings should only live in atoms
grep -rn "^## Definition" docs/notebook/ docs/rfcs/   # expect empty
```

Add a third check tailored to this hygiene pass:

```bash
# Status-line consistency check
grep -rn "^\*\*Status\*\*:" docs/atoms/ | \
  grep -vE "(V1 shipped|V1 spec'd|V2 reserved|V3\+|discipline|anti-pattern|decision|protocol|contract)" 
# expect empty
```

Expected results: all three checks return empty after the work lands.

## §6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Field-name direction wrong (atom says `text`, implementation says `message`, or vice versa) — flipping the atom would create implementation drift | **BEFORE flipping**: grep `vendor/LLMKernel/llm_kernel/custom_messages.py` for `agent_continue`; check which key the handler reads. Match the atom to the implementation. If the operator's brief was based on a stale snapshot, flag for operator confirmation and DO NOT flip without it. |
| Status updates introduce a forward dependency loop (PLAN file references atom Status, atom Status references PLAN) | The atom only mentions the PLAN by filename; PLAN files reference atoms by path. No circular content. |
| The four invented-defaults bullets duplicate behavior listed elsewhere (e.g., already documented in BSP-002) | Each bullet's wording is intentionally short; the atom is the canonical place per [docs/atoms/README.md §"Atom rules"](../atoms/README.md). Cross-references back to BSP-002 / RFC-002 stay. |
| Drift detector reports orphan atoms after this work | Each Status update keeps the atom's outbound link count the same (changes only the Status string). No orphans introduced. |
| Status enum values get inconsistent across atoms in future PRs | Add the §5 status-line check to a CI lint or pre-commit hook in a future cleanup. Out of scope here. |

## §7. Atoms touched + Atom Status fields needing update

This plan IS the Status-fields-needing-update list. Atoms modified:

- [operations/split-cell.md](../atoms/operations/split-cell.md) — Status updated.
- [operations/merge-cells.md](../atoms/operations/merge-cells.md) — Status updated.
- [operations/promote-span.md](../atoms/operations/promote-span.md) — Status updated.
- [operations/move-cell.md](../atoms/operations/move-cell.md) — Status updated.
- [operations/apply-overlay-commit.md](../atoms/operations/apply-overlay-commit.md) — Status updated.
- [concepts/section.md](../atoms/concepts/section.md) — Status updated.
- [protocols/operator-action.md](../atoms/protocols/operator-action.md) — `agent_continue` row's parameter name aligned with implementation (pending operator confirmation per §6).
- [operations/continue-turn.md](../atoms/operations/continue-turn.md) — same field-name alignment.
- [concepts/agent.md](../atoms/concepts/agent.md) — two new invariant bullets (defaults).
- [contracts/agent-supervisor.md](../atoms/contracts/agent-supervisor.md) — two new invariant bullets (probe window, marker stage name).

Other operation atoms with `V1 spec'd` Status that already have correct wording (no change needed): [operations/create-section.md](../atoms/operations/create-section.md), [operations/delete-section.md](../atoms/operations/delete-section.md), [operations/rename-section.md](../atoms/operations/rename-section.md), [operations/set-section-status.md](../atoms/operations/set-section-status.md), [operations/branch-agent.md](../atoms/operations/branch-agent.md), [operations/revert-agent.md](../atoms/operations/revert-agent.md), [operations/create-overlay-ref.md](../atoms/operations/create-overlay-ref.md), [operations/revert-overlay-commit.md](../atoms/operations/revert-overlay-commit.md). Check for parallel cleanup on a future pass if the wording diverges.

## §8. Cross-references (sibling PLANs)

- [PLAN-v1-roadmap.md §5 row 14](PLAN-v1-roadmap.md) — ship-ready bullet flipped here. This PLAN BLOCKS Track A and B agents from starting because they read atoms; run this first.
- [PLAN-atom-refactor.md](PLAN-atom-refactor.md) — the original refactor plan. This is a maintenance pass on top of it.
- [PLAN-substrate-gap-closure.md](PLAN-substrate-gap-closure.md) — once gaps close, the contract atoms' "Code drift vs spec" sections shrink; pair this hygiene pass with that one for consistency.

## §9. Definition of done

- [ ] Six Status field updates landed in the atoms listed in §3.1.
- [ ] `agent_continue` field-name alignment landed in [protocols/operator-action.md](../atoms/protocols/operator-action.md) and [operations/continue-turn.md](../atoms/operations/continue-turn.md), in the direction confirmed by operator + implementation grep per §6.
- [ ] Four invented-default bullets landed in [concepts/agent.md](../atoms/concepts/agent.md) and [contracts/agent-supervisor.md](../atoms/contracts/agent-supervisor.md).
- [ ] Orphan check from §5 returns empty.
- [ ] Drift check from §5 returns empty.
- [ ] Status-line consistency check from §5 returns empty.
- [ ] This plan flips to `**Status**: shipped (commit <SHA>)`.
