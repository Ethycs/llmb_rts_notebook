# `docs/atoms/` — atomic concept layer

**Status**: V1 shipped (this directory is itself an atom of the docs system).

This directory holds the canonical, single-place definition for every reusable noun, verb, rule, decision, and anti-pattern in the project. The wiki / Zettelkasten layer over the longer specs in [docs/notebook/](../../03%20-%20Blueprint/) and [docs/rfcs/](../../05%20-%20Standards/rfcs/).

## Why atoms

The same concept (Cell, Section, Turn, Overlay commit, RunFrame, ArtifactRef) was being restated in 3-5 specs each, with phrasing drift on every amendment. The cure: one canonical file per claim. Specs link out instead of restating; updates happen in the atom and propagate via the link graph.

## Layout — seven subdirectories

| Folder | Holds | Status enum value |
|---|---|---|
| [concepts/](concepts/) | What things ARE — data shapes, definitions | `V1 shipped` / `V1 spec'd` / `V2 reserved` |
| [operations/](operations/) | What you can DO — overlay commits, agent ops | `V1 shipped` / `V2 reserved` |
| [discipline/](discipline/) | Project rules / invariants the design enforces | `discipline` |
| [decisions/](decisions/) | V1 vs V2+ calls; pinned with rationale | `decision` |
| [anti-patterns/](anti-patterns/) | Already-hit traps with the lesson recorded | `anti-pattern` |
| [protocols/](protocols/) | Wire formats — direction, schema, error envelope, version handshake | `protocol` |
| [contracts/](contracts/) | Code-internal interfaces — module location, signatures, invariants, K-class errors | `contract` |

~91 atoms across 7 subdirectories (as of 2026-05-02). Each 30-120 lines (avg ~74). Total corpus ~6,700 lines.

## Atom rules

1. **Each atom is ≤120 lines.** If it grows past that, split or fold sections back into the consumer doc.
2. **Atoms are NORMATIVE for definitions.** When an atom and a longer spec disagree on what a thing IS, the atom wins. Specs remain normative for *behavior*, *wire format*, and *interaction*.
3. **Cross-references use stable section anchors** — from inside an atom (e.g., `concepts/cell.md`), write `[BSP-002 §13.1](../../../03%20-%20Blueprint/BSP-002-conversation-graph.md#131-section-as-overlay-graph-concept)` — not floating links.
4. **Each atom is referenced by ≥2 other docs.** If only one consumer cites it, fold it back. No orphan atoms.
5. **No emojis. No backwards-compat shims for hypothetical past states.**
6. **Atoms never move once shipped.** Stable relative paths under `docs/04 - Reference/atoms/` (the atoms layer was relocated under the numbered `04 - Reference/` taxonomy on 2026-05-30; the whole subtree moved as a unit so intra-atom links were preserved). A rename creates a stub atom forwarding to the new path.

## Atom template

```markdown
# {Concept name}

**Status**: `V1 shipped | V1 spec'd | V2 reserved | V3+ | discipline | anti-pattern | decision | protocol | contract`
**Source specs**: links to the BSP / RFC / KB sections that originally defined this
**Related atoms**: links to peers in this graph

## Definition
ONE paragraph. The canonical claim about this thing.

## Schema (if applicable)
Code block with the JSON / type shape.

## Invariants (bullet list, each testable)
- ...

## V1 vs V2+ (when applicable)
- **V1**: what ships now
- **V2+**: how it expands

## See also
- [op-x](../operations/op-x.md)
- [discipline-y](../discipline/discipline-y.md)
```

## Writing a new atom

1. Pick the right subdirectory by the type (concept / operation / discipline / decision / anti-pattern).
2. Use kebab-case filenames matching the concept's canonical name.
3. Follow the template. Status string from the enum. ≥2 outbound links.
4. Edit at least one consumer doc to add an inbound link, so the atom isn't an orphan from day one.
5. If the atom records a decision, also add a row to the relevant amendment table in the source spec (e.g., [KB-notebook-target.md §0](../../03%20-%20Blueprint/KB-notebook-target.md#0-v1-decisions-and-amendments-2026-04-28)).

## Verification

Periodically run from repo root:

```bash
# Orphan check (note the quoting — the atoms root now contains spaces)
for atom in "docs/04 - Reference/atoms"/**/*.md; do
  refs=$(grep -rl --include='*.md' "$(basename "$atom")" docs/ | grep -v "^$atom$" | wc -l)
  [[ $refs -lt 2 ]] && echo "ORPHAN: $atom ($refs refs)"
done

# Drift check — Definition headings should only live in atoms
grep -rn "^## Definition" "docs/03 - Blueprint" "docs/05 - Standards/rfcs"   # expect empty
```

## Related

- [PLAN-atom-refactor.md](../../06%20-%20Roadmaps/PLAN-atom-refactor.md) — the refactor that established this layer.
- [KB-notebook-target.md §0](../../03%20-%20Blueprint/KB-notebook-target.md#0-v1-decisions-and-amendments-2026-04-28) — the V1 amendments these atoms pin into the corpus.
