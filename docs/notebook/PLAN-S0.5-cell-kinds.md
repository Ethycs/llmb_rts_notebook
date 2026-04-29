# Plan: S0.5 — Cell kinds typed enum

**Status**: ready
**Audience**: an LLM (or operator) picking this up cold. Self-contained.
**Goal**: add a required `metadata.rts.cells[<id>].kind` enum field to the writer so V1 cells carry one of `agent | markdown | scratch | checkpoint` (with `tool | artifact | control | native` reserved as forward-compat slots), unblocking every downstream slice that branches on cell kind.
**Time budget**: 0.5 days. Single-agent. Not parallelizable internally; blocks S5 / S5.5 / S6 / S3.5's checkpoint-handling.

---

## §1. Why this work exists

Today the writer has no notion of "kind" on a cell — every cell is implicitly an `agent` cell that ran a `/spawn` directive. The downstream slices need structural branching on kind:

- **Merge correctness ([S5.5 / S6](BSP-005-cell-roadmap.md))** requires `c_a.kind == c_b.kind` as a precondition. Without an enum it is content-heuristic.
- **ContextPacker ([S3.5](PLAN-S3.5-context-packer.md))** must filter `scratch` and `checkpoint` cells differently from `agent`/`markdown`.
- **Render dispatch ([S1 — already shipped](BSP-005-cell-roadmap.md#s1--cell-as-agent-identity-bsp-002-6--extension-only))** wants the kind label alongside the agent badge.
- **V2+ kinds** (`tool | artifact | control | native`) need a reserved slot from V1 forward, otherwise every V2 producer ships unknown values that V1 consumers reject.

S0.5 lands the slot. Driver: [KB-notebook-target.md §0.4](KB-notebook-target.md), ratified into the slice ladder via [BSP-005 §6.1](BSP-005-cell-roadmap.md#61-s05--cell-kinds-typed-enum-new).

## §2. Goals and non-goals

### Goals

- `metadata.rts.cells[<cell_id>].kind` is a required field on every cell going forward.
- Pre-S0.5 cells with no `kind` field default to `agent` at load time; the writer back-fills on the next snapshot.
- The 4 reserved kinds (`tool`, `artifact`, `control`, `native`) are accepted by the validator but render inert in V1 with the kind label visible.
- Per-kind slot rules enforced: `markdown` MUST NOT carry `bound_agent_id`; `scratch` / `checkpoint` SHOULD have `bound_agent_id: null`.

### Non-goals

- This slice does NOT implement the V2 reserved kinds' behavior. They remain inert in V1 (validate-and-store, no dispatch).
- This slice does NOT alter the directive grammar. `/spawn` still produces `kind: "agent"` implicitly; the operator does not pick a kind manually in V1.
- This slice does NOT modify ContextPacker, RunFrames, or merge invariants — it only lands the field they will read.

## §3. Concrete work

1. **Schema land — atom is the source of truth.** Read [docs/atoms/concepts/cell-kinds.md](../atoms/concepts/cell-kinds.md) verbatim. The eight enum values + per-kind constraints live there; do not re-define them in code comments — link.

2. **Writer field.** In `vendor/LLMKernel/llm_kernel/metadata_writer.py`:
   - Extend the `set_cell_metadata` intent handler to accept and persist `kind` per the atom's schema (the field lives at `metadata.rts.cells[<cell_id>].kind`).
   - Reject unknown values with K42 (`unknown_cell_kind`); reject `markdown` with non-null `bound_agent_id` with K42 (`markdown_must_have_no_agent`).
   - Emit a Family F snapshot delta carrying the new field. See [protocols/family-f-notebook-metadata](../atoms/protocols/family-f-notebook-metadata.md).

3. **Hydrate path back-fill.** In `MetadataWriter.hydrate(snapshot)`, walk the cells map and set `kind = "agent"` on any entry missing the field, marking `_kind_back_filled: true` on the in-memory record so the next snapshot writes it persistently. Pre-Issue-2 notebooks transparently upgrade.

4. **Extension-side set.** `extension/src/notebook/cell-directive.ts` parses `/spawn` → emit `set_cell_metadata` with `kind: "agent"`. For markdown cells (VS Code's native markdown cell), submit `kind: "markdown"` and `bound_agent_id: null`. For now, no operator UI to pick `scratch` / `checkpoint`; those land via overlay-commit ops in S5 / S5.5.

5. **Type definition.** In the extension, declare a TypeScript union literal type matching the atom's eight values. Place it in `extension/src/types/cell-kind.ts`; export from there for both renderer and directive parser.

6. **Decoration tie-in.** The S1 status-bar item (already shipped) reads `cell.metadata.rts.cells[<id>].kind` and renders the label. This slice exposes the field; no rendering work re-required, just confirm the existing decoration sees the new value.

## §4. Interface contracts

There is one new wire change: `set_cell_metadata` accepts the `kind` field. The wider intent envelope is unchanged (see [protocols/submit-intent-envelope](../atoms/protocols/submit-intent-envelope.md)).

```jsonc
// New parameter shape for intent_kind: "set_cell_metadata"
{
  cell_id: "vscode-notebook-cell:.../#abc",
  kind: "agent" | "markdown" | "scratch" | "checkpoint"
      | "tool" | "artifact" | "control" | "native",   // required from S0.5 forward
  bound_agent_id: string | null,                       // markdown: MUST be null
  // existing flags ...
  pinned?: boolean,
  excluded?: boolean,
  scratch?: boolean,
  checkpoint?: boolean,
  read_only?: boolean
}
```

K-class additions: K42 sub-reasons `unknown_cell_kind`, `markdown_must_have_no_agent`, `kind_required` (when an explicit `set_cell_metadata` omits the field on a non-back-filled write). No new K codes — these reuse K42 with structured `reason`.

## §5. Test surface

New tests in `vendor/LLMKernel/tests/test_metadata_writer.py`:

- `test_set_cell_metadata_persists_kind` — basic round-trip of `kind: "agent"`.
- `test_set_cell_metadata_rejects_unknown_kind` — K42 with reason `unknown_cell_kind`.
- `test_set_cell_metadata_rejects_markdown_with_agent` — K42 with reason `markdown_must_have_no_agent`.
- `test_hydrate_back_fills_kind_on_legacy_snapshot` — old snapshot with no `kind` loads, defaults to `agent`, writes back on next snapshot.
- `test_set_cell_metadata_accepts_reserved_kinds` — `tool` / `artifact` / `control` / `native` round-trip without dispatch.

Extension tests in `extension/test/notebook/`:
- `cell-kind.test.ts` — directive parser sets `kind: "agent"` for `/spawn`; markdown cell controller sets `kind: "markdown"`.

Expected count: 5 kernel tests + 1 extension test = 6 new tests. Existing `test_metadata_writer.py` count rises by 5.

## §6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Pre-Issue-2 notebooks crash on hydrate when kind is missing | Hydrate-path back-fill in §3 step 3; covered by `test_hydrate_back_fills_kind_on_legacy_snapshot`. |
| Extension and kernel disagree on the enum | Single source of truth = the [cell-kinds atom](../atoms/concepts/cell-kinds.md). TypeScript and Python both reference the atom's eight values literally; PR review verifies. |
| Operator types `/spawn` and the writer fails because the cell lacks `kind` on first set | Directive parser explicitly sets `kind: "agent"` in §3 step 4; covered by extension test. |
| Reserved kinds get accidentally dispatched | The reserved kinds have NO handler in S0.5; the renderer falls through to a "kind-label only" view per [cell-kinds atom invariants](../atoms/concepts/cell-kinds.md). |

## §7. Atoms touched + Atom Status fields needing update

- [concepts/cell-kinds.md](../atoms/concepts/cell-kinds.md) — already says "V1 shipped (4 kinds active, 4 reserved)" but the field is not yet implemented. After this slice, the status remains correct; verify the atom's Status line after merge.
- [concepts/cell.md](../atoms/concepts/cell.md) — Status `V1 shipped`; should call out S0.5 as the slice that lands the `kind` field. Update its `## V1 vs V2+` line if it claims V1 already has kind enforcement.
- [decisions/v1-flat-sections.md](../atoms/decisions/v1-flat-sections.md) — referenced by cell-kinds; no change.
- [contracts/metadata-writer.md](../atoms/contracts/metadata-writer.md) — Code drift section: add a line clearing the `set_cell_metadata.kind` drift after this slice lands.
- [protocols/submit-intent-envelope.md](../atoms/protocols/submit-intent-envelope.md) — `set_cell_metadata` row's "atom" link now reaches a real-implementation path.

## §8. Cross-references (sibling PLANs)

- [PLAN-v1-roadmap.md](PLAN-v1-roadmap.md) §5 row 1 — the conductor's first ship-ready bullet depends on this.
- [PLAN-S3.5-context-packer.md](PLAN-S3.5-context-packer.md) — consumes `kind` for `scratch` / `checkpoint` filtering.
- [PLAN-S5-branch-revert-stop.md](PLAN-S5-branch-revert-stop.md) — overlay-commit operations branch on `kind`.
- [PLAN-S5.5-sections.md](PLAN-S5.5-sections.md) — section membership rules check `kind`.
- [PLAN-S6-cell-binding-runframes.md](PLAN-S6-cell-binding-runframes.md) — RunFrame's `cell_id` resolves to a cell carrying a kind label.
- [PLAN-substrate-gap-closure.md](PLAN-substrate-gap-closure.md) — overlapping if any of the gap items reach into `set_cell_metadata`.

## §9. Definition of done

- [ ] All 6 new tests pass.
- [ ] Existing kernel test suite stays green.
- [ ] One operator round-trip: open a fresh notebook, `/spawn alpha task:"hi"`, close, reopen — the cell loads with `kind: "agent"` and the badge renders.
- [ ] One legacy round-trip: open a pre-S0.5 notebook (a saved fixture), confirm it hydrates with back-filled `kind: "agent"` and writes back the field on first snapshot.
- [ ] [docs/atoms/concepts/cell-kinds.md](../atoms/concepts/cell-kinds.md) Status line is verified consistent with implementation.
- [ ] BSP-005 §6.1 changelog updated with the slice's commit SHA.
- [ ] This plan flips to `**Status**: shipped (commit <SHA>)`.
