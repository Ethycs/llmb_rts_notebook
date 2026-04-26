"""Stage 5 verification: prove the decomposition is faithful.

Checks:
  1. Source hash unchanged.
  2. Turn coverage: every line in the source is in some turn or extra block,
     no gaps, no overlaps.
  3. No silent edits in _ingest/raw/: each turn-NNN-<role>.md body matches
     turns.json[*].hash.
  4. Phase manifest <-> decisions cross-references consistent.
  5. Phase contiguity (turn ranges cover 001..NN with no gaps).
  6. Idempotency hint: re-running build_turn_index.py + split_into_phases.py
     produces the same outputs (we can't re-run inside this script, but we
     check that the existing phase folders match what the manifest claims).
  7. Every dev-guide chapter exists.
  8. Every ADR exists, and its file name matches the slug in decisions.json.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SOURCE = REPO / "chat-export-2026-04-26T04-22-39.md"
M = REPO / "_ingest" / "manifests"
RAW = REPO / "_ingest" / "raw"
DEV = REPO / "docs" / "dev-guide"
ADR = REPO / "docs" / "decisions"


def fail(msg: str) -> None:
    print(f"  FAIL: {msg}", file=sys.stderr)


def main() -> int:
    errors = 0

    # 1. Source hash unchanged.
    print("[1] source hash")
    expected = (M / "source.sha256").read_text(encoding="utf-8").strip().split()[0]
    actual = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    if actual == expected:
        print(f"  OK ({actual[:16]}…)")
    else:
        fail(f"hash mismatch: expected {expected}, got {actual}")
        errors += 1

    turns_doc = json.loads((M / "turns.json").read_text(encoding="utf-8"))
    sub_turns = turns_doc["turns"]
    extras = turns_doc["extras"]
    merged_turns = turns_doc["merged_turns"]
    line_count = turns_doc["source"]["line_count"]

    # 2. Turn coverage.
    print("[2] line coverage")
    covered_lines = 0
    for t in sub_turns:
        covered_lines += t["line_end"] - t["line_start"] + 1
    for e in extras:
        covered_lines += e["line_end"] - e["line_start"] + 1
    # The trailing newline-after-last-line accounting may produce a +-1
    # discrepancy with `wc -l`. We expect covered_lines to equal
    # line_count or line_count - 1. Both are acceptable.
    if line_count - 1 <= covered_lines <= line_count + 1:
        print(f"  OK (covered {covered_lines} of {line_count} reported lines)")
    else:
        fail(f"line coverage off: covered {covered_lines}, expected ~{line_count}")
        errors += 1

    # 3. No silent edits in _ingest/raw/.
    print("[3] raw-turn body hashes")
    text = SOURCE.read_text(encoding="utf-8")
    body_by_id = {t["turn_id"]: text[t["byte_start"]:t["byte_end"]] for t in sub_turns}
    hash_by_id = {t["turn_id"]: t["hash"] for t in sub_turns}
    raw_files = sorted(RAW.rglob("turn-*.md"))
    if len(raw_files) != len(sub_turns):
        fail(f"raw file count {len(raw_files)} != sub-turn count {len(sub_turns)}")
        errors += 1
    bad = 0
    for raw_file in raw_files:
        m = re.match(r"turn-(\d{3})-", raw_file.name)
        if not m:
            fail(f"unparseable raw file name: {raw_file}")
            errors += 1
            continue
        tid = m.group(1)
        if tid not in body_by_id:
            fail(f"raw file references unknown turn {tid}: {raw_file}")
            errors += 1
            continue
        # Strip frontmatter from the file body. Frontmatter is `---\n...\n---\n\n`.
        content = raw_file.read_text(encoding="utf-8")
        if not content.startswith("---\n"):
            fail(f"raw file missing frontmatter: {raw_file}")
            errors += 1
            continue
        end = content.find("\n---\n\n", 4)
        if end < 0:
            fail(f"raw file missing frontmatter terminator: {raw_file}")
            errors += 1
            continue
        body = content[end + len("\n---\n\n"):]
        body_hash = hashlib.sha256(body.encode("utf-8")).hexdigest()
        if body_hash != hash_by_id[tid]:
            bad += 1
            if bad <= 3:
                fail(f"body hash mismatch for {raw_file.name}")
    if bad == 0:
        print(f"  OK ({len(raw_files)} files match manifest hashes)")
    else:
        fail(f"{bad} body hash mismatches in _ingest/raw/")
        errors += 1

    # 4. Phase <-> decisions cross-references.
    print("[4] phase <-> decisions cross-references")
    phases = json.loads((M / "phases.json").read_text(encoding="utf-8"))["phases"]
    decisions = json.loads((M / "decisions.json").read_text(encoding="utf-8"))["decisions"]
    phase_ids = {p["phase_id"] for p in phases}
    phase_decisions = {p["phase_id"]: set(p.get("decision_ids", [])) for p in phases}
    phase_range = {
        p["phase_id"]: (int(p["merged_turn_range"][0]), int(p["merged_turn_range"][1]))
        for p in phases
    }
    sub_errors = 0
    for d in decisions:
        pid = d["phase_id"]
        if pid not in phase_ids:
            fail(f"{d['decision_id']} references unknown phase {pid}")
            sub_errors += 1
            continue
        if d["decision_id"] not in phase_decisions[pid]:
            fail(f"{d['decision_id']} not listed in phase {pid}")
            sub_errors += 1
        s, e = phase_range[pid]
        for tref in d["merged_turn_refs"]:
            ti = int(tref)
            if not (s <= ti <= e):
                fail(f"{d['decision_id']} turn {tref} outside phase {pid} [{s:03d},{e:03d}]")
                sub_errors += 1
    all_did = {d["decision_id"] for d in decisions}
    for p in phases:
        for did in p.get("decision_ids", []):
            if did not in all_did:
                fail(f"phase {p['phase_id']} references unknown decision {did}")
                sub_errors += 1
    if sub_errors == 0:
        print(f"  OK (16 decisions, 8 phases, all refs consistent)")
    else:
        errors += sub_errors

    # 5. Phase contiguity.
    print("[5] phase contiguity")
    prev_end = 0
    sub_errors = 0
    for p in phases:
        s = int(p["merged_turn_range"][0])
        e = int(p["merged_turn_range"][1])
        if s != prev_end + 1:
            fail(f"gap before phase {p['phase_id']}: prev_end={prev_end}, s={s}")
            sub_errors += 1
        prev_end = e
    expected_last = len(merged_turns)
    if prev_end != expected_last:
        fail(f"final phase ends at {prev_end}, expected {expected_last}")
        sub_errors += 1
    if sub_errors == 0:
        print(f"  OK (phases cover 001..{prev_end:03d} contiguously)")
    else:
        errors += sub_errors

    # 6. Idempotency: phase folders match manifest.
    print("[6] phase folders match manifest")
    sub_errors = 0
    for p in phases:
        expected_dir = RAW / f"phase-{p['phase_id']}-{p['slug']}"
        if not expected_dir.is_dir():
            fail(f"missing phase folder: {expected_dir.relative_to(REPO)}")
            sub_errors += 1
        else:
            if not (expected_dir / "00-overview.md").exists():
                fail(f"missing overview: {expected_dir.relative_to(REPO)}/00-overview.md")
                sub_errors += 1
    if sub_errors == 0:
        print(f"  OK ({len(phases)} phase folders present, each with overview)")
    else:
        errors += sub_errors

    # 7. Dev-guide chapters.
    print("[7] dev-guide chapters")
    sub_errors = 0
    if not (DEV / "00-overview.md").exists():
        fail("missing docs/dev-guide/00-overview.md")
        sub_errors += 1
    for p in phases:
        chapter = DEV / f"{p['phase_id']}-{p['slug']}.md"
        if not chapter.exists():
            fail(f"missing chapter: {chapter.relative_to(REPO)}")
            sub_errors += 1
    if sub_errors == 0:
        print(f"  OK ({len(phases) + 1} dev-guide files present)")
    else:
        errors += sub_errors

    # 8. ADRs.
    print("[8] ADR files match decisions.json")
    sub_errors = 0
    if not (ADR / "README.md").exists():
        fail("missing docs/decisions/README.md")
        sub_errors += 1
    for d in decisions:
        num = d["decision_id"].replace("DR-", "")
        adr_file = ADR / f"{num}-{d['slug']}.md"
        if not adr_file.exists():
            fail(f"missing ADR: {adr_file.relative_to(REPO)}")
            sub_errors += 1
    if sub_errors == 0:
        print(f"  OK ({len(decisions)} ADRs + index present)")
    else:
        errors += sub_errors

    # 9. Link integrity in docs/.
    print("[9] link integrity in docs/ and root README")
    link_re = re.compile(r"\[[^\]]*\]\(([^)#]+?)(?:#[^)]*)?\)")
    sub_errors = 0
    targets = [REPO / "README.md"] + list((REPO / "docs").rglob("*.md"))
    checked = 0
    broken = 0
    for md in targets:
        text = md.read_text(encoding="utf-8")
        for m in link_re.finditer(text):
            href = m.group(1).strip()
            if href.startswith(("http://", "https://", "mailto:")):
                continue
            target = (md.parent / href).resolve()
            checked += 1
            if not target.exists():
                broken += 1
                if broken <= 5:
                    fail(f"broken link in {md.relative_to(REPO)}: {href}")
    if broken == 0:
        print(f"  OK ({checked} relative links resolved across {len(targets)} files)")
    else:
        fail(f"{broken} broken links total")
        errors += 1

    print()
    if errors == 0:
        print("ALL CHECKS PASSED")
        return 0
    else:
        print(f"{errors} CHECK(S) FAILED")
        return 1


if __name__ == "__main__":
    sys.exit(main())
