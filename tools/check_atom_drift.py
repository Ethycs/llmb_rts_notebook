"""Cross-atom schema drift detector.

Walks docs/atoms/**/*.md, extracts JSON/JSONC code blocks, and finds every
object literal containing `kind: "<op_name>"`. For each op_name, collects the
set of sibling keys at the same indentation. If one op_name appears with more
than one distinct field set across the atom corpus, drift is reported.

Catches the class of bug shipped in commit c8ed54c: split_cell payloads using
`at_turn_id` in apply-overlay-commit.md / overlay-commit.md examples while
split-cell.md defined the canonical shape `at: {kind: "span_boundary", ...}`.

Run:
    .pixi/envs/kernel/python.exe tools/check_atom_drift.py

Exit code 0 if clean, 1 if drift detected.
"""

from __future__ import annotations

import re
import sys
from collections import defaultdict
from pathlib import Path

ATOMS_ROOT = Path(__file__).resolve().parent.parent / "docs" / "atoms"

CODE_BLOCK = re.compile(r"```(?:jsonc?|js|javascript|typescript|ts)?\n(.*?)\n```", re.DOTALL)
KIND_LINE = re.compile(r'["\']?kind["\']?\s*:\s*["\']([\w.\-]+)["\']')
KEY_LINE = re.compile(r'^\s*["\']?(\w+)["\']?\s*:')


def sibling_keys(lines: list[str], kind_idx: int) -> set[str]:
    """Collect keys at the same indentation as `kind: "<op>"` in the same object.

    Walks forward and backward from the kind line, stopping when indentation
    drops below the kind line's level (i.e., we left the enclosing object).
    """
    kind_line = lines[kind_idx]
    indent = len(kind_line) - len(kind_line.lstrip())
    keys: set[str] = set()

    for delta in (1, -1):
        i = kind_idx + delta
        while 0 <= i < len(lines):
            line = lines[i]
            stripped = line.lstrip()
            if not stripped or stripped.startswith("//"):
                i += delta
                continue
            line_indent = len(line) - len(stripped)
            if line_indent < indent:
                break
            if line_indent == indent:
                m = KEY_LINE.match(line)
                if m:
                    keys.add(m.group(1))
            i += delta

    keys.discard("kind")
    return keys


def scan_atoms() -> dict[str, dict[frozenset[str], list[tuple[str, int]]]]:
    """For each `kind: "<op>"` site, collect its sibling key set.

    Returns: op_name -> {field_set -> [(file, line), ...]}
    """
    fields_by_op: dict[str, dict[frozenset[str], list[tuple[str, int]]]] = defaultdict(
        lambda: defaultdict(list)
    )

    for path in sorted(ATOMS_ROOT.rglob("*.md")):
        text = path.read_text(encoding="utf-8")
        rel = path.relative_to(ATOMS_ROOT.parent.parent).as_posix()
        for code_match in CODE_BLOCK.finditer(text):
            block = code_match.group(1)
            block_start = text[: code_match.start()].count("\n") + 2
            lines = block.splitlines()
            for i, line in enumerate(lines):
                m = KIND_LINE.search(line)
                if not m:
                    continue
                op = m.group(1)
                keys = frozenset(sibling_keys(lines, i))
                fields_by_op[op][keys].append((rel, block_start + i))

    return fields_by_op


def is_compatible(field_sets: list[frozenset[str]]) -> bool:
    """True if the sets form a totally-ordered chain by ⊆.

    When all sets are subsets of one maximal set, the variation is "showing
    different levels of detail" (pedagogy), not drift. When two sets each
    have keys the other lacks, that is real drift.
    """
    if len(field_sets) <= 1:
        return True
    largest = max(field_sets, key=len)
    return all(s <= largest for s in field_sets)


def main() -> int:
    fields_by_op = scan_atoms()

    if not fields_by_op:
        print(f"No `kind:` patterns found under {ATOMS_ROOT}. Nothing to check.")
        return 0

    multi = {op: sets for op, sets in fields_by_op.items() if len(sets) > 1}
    drift = {op: sets for op, sets in multi.items() if not is_compatible(list(sets.keys()))}
    pedagogy = {op: sets for op, sets in multi.items() if is_compatible(list(sets.keys()))}

    print("=== Cross-atom schema drift report ===\n")
    print(f"Atoms scanned: {len(list(ATOMS_ROOT.rglob('*.md')))}")
    print(f"Distinct `kind` values: {len(fields_by_op)}")
    print(f"  Single-shape:           {len(fields_by_op) - len(multi)}")
    print(f"  Multi-shape, compatible (subset chain — different views):  {len(pedagogy)}")
    print(f"  Multi-shape, conflicting (real drift):                     {len(drift)}")

    if pedagogy:
        print("\nCompatible multi-shape kinds (informational, not drift):")
        for op in sorted(pedagogy):
            sets = pedagogy[op]
            largest = max(sets.keys(), key=len)
            print(f"  {op!r}: maximal shape has {sorted(largest)}")
            for keys, locs in sorted(sets.items(), key=lambda kv: -len(kv[0])):
                tag = "full" if keys == largest else f"-{sorted(largest - keys)}"
                for path, line in locs:
                    print(f"      {path}:{line}  ({tag})")

    if not drift:
        print("\nNo drift detected.")
        return 0

    print("\nReal drift (conflicting field sets — neither is a subset of the other):")
    for op in sorted(drift):
        sets = drift[op]
        print(f"\n  {op!r}: {len(sets)} distinct field sets")
        for keys, locs in sorted(sets.items(), key=lambda kv: -len(kv[1])):
            shape = sorted(keys) if keys else ["(no siblings)"]
            print(f"    fields {shape}")
            for path, line in locs:
                print(f"      {path}:{line}")

    print(
        "\nReconcile by picking the canonical shape (per the source spec) and "
        "updating sibling examples to match."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
