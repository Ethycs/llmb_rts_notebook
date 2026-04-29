# `docs/atoms/` — atomic concept layer

**Status**: V1 shipped (this directory is itself an atom of the docs system).

This directory holds the canonical, single-place definition for every reusable noun, verb, rule, decision, and anti-pattern in the project. The wiki / Zettelkasten layer over the longer specs in [docs/notebook/](../notebook/) and [docs/rfcs/](../rfcs/).

## Why atoms

The same concept (Cell, Section, Turn, Overlay commit, RunFrame, ArtifactRef) was being restated in 3-5 specs each, with phrasing drift on every amendment. The cure: one canonical file per claim. Specs link out instead of restating; updates happen in the atom and propagate via the link graph.

## Layout — five subdirectories

| Folder | Holds | Status enum value |
|---|---|---|
| [concepts/](concepts/) | What things ARE — data shapes, definitions | `V1 shipped` / `V1 spec'd` / `V2 reserved` |
| [operations/](operations/) | What you can DO — overlay commits, agent ops | `V1 shipped` / `V2 reserved` |
| [discipline/](discipline/) | Project rules / invariants the design enforces | `discipline` |
| [decisions/](decisions/) | V1 vs V2+ calls; pinned with rationale | `decision` |
| [anti-patterns/](anti-patterns/) | Already-hit traps with the lesson recorded | `anti-pattern` |

Roughly 50-55 atoms total. Each 30-100 lines. Total corpus ~3000 lines.

## Atom rules

1. **Each atom is ≤120 lines.** If it grows past that, split or fold sections back into the consumer doc.
2. **Atoms are NORMATIVE for definitions.** When an atom and a longer spec disagree on what a thing IS, the atom wins. Specs remain normative for *behavior*, *wire format*, and *interaction*.
3. **Cross-references use stable section anchors** — from inside an atom (e.g., `concepts/cell.md`), write `[BSP-002 §13.1](../../notebook/BSP-002-conversation-graph.md#131-section-as-overlay-graph-concept)` — not floating links.
4. **Each atom is referenced by ≥2 other docs.** If only one consumer cites it, fold it back. No orphan atoms.
5. **No emojis. No backwards-compat shims for hypothetical past states.**
6. **Atoms never move once shipped.** Stable relative paths under `docs/atoms/`. A rename creates a stub atom forwarding to the new path.

## Atom template

```markdown
# {Concept name}

**Status**: `V1 shipped | V1 spec'd | V2 reserved | V3+ | discipline | anti-pattern | decision`
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
5. If the atom records a decision, also add a row to the relevant amendment table in the source spec (e.g., [KB-notebook-target.md §0](../notebook/KB-notebook-target.md#0-v1-decisions-and-amendments-2026-04-28)).

## Verification

Periodically run from repo root:

```bash
# Orphan check
for atom in docs/atoms/**/*.md; do
  refs=$(grep -rl --include='*.md' "$(basename $atom)" docs/ | grep -v "^$atom$" | wc -l)
  [[ $refs -lt 2 ]] && echo "ORPHAN: $atom ($refs refs)"
done

# Drift check — Definition headings should only live in atoms
grep -rn "^## Definition" docs/notebook/ docs/rfcs/   # expect empty
```

## Related

- [PLAN-atom-refactor.md](../notebook/PLAN-atom-refactor.md) — the refactor that established this layer.
- [KB-notebook-target.md §0](../notebook/KB-notebook-target.md#0-v1-decisions-and-amendments-2026-04-28) — the V1 amendments these atoms pin into the corpus.
