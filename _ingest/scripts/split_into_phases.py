"""Stage 2: Split the chat export into per-phase folders of per-sub-turn files.

Reads:
  _ingest/manifests/turns.json      (sub-turns + merged-turn map)
  _ingest/manifests/phases.json     (canonical phase manifest)
  _ingest/manifests/decisions.json  (canonical decision manifest)
  chat-export-2026-04-26T04-22-39.md (source-of-truth, never mutated)

Writes:
  _ingest/raw/phase-NN-<slug>/00-overview.md
  _ingest/raw/phase-NN-<slug>/turn-NNN-<role>.md   (one per *sub*-turn)

Each turn file gets a small YAML frontmatter for traceability. Body is a
verbatim slice of the source (the bytes between two `---` delimiters).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE = REPO_ROOT / "chat-export-2026-04-26T04-22-39.md"
MANIFEST_DIR = REPO_ROOT / "_ingest" / "manifests"
RAW_DIR = REPO_ROOT / "_ingest" / "raw"


def main() -> int:
    if not SOURCE.exists():
        print(f"FATAL: source not found at {SOURCE}", file=sys.stderr)
        return 2

    text = SOURCE.read_text(encoding="utf-8")

    turns_doc = json.loads((MANIFEST_DIR / "turns.json").read_text(encoding="utf-8"))
    phases_doc = json.loads((MANIFEST_DIR / "phases.json").read_text(encoding="utf-8"))
    decisions_doc = json.loads((MANIFEST_DIR / "decisions.json").read_text(encoding="utf-8"))

    sub_turns = {t["turn_id"]: t for t in turns_doc["turns"]}
    merged_turns = {m["merged_id"]: m for m in turns_doc["merged_turns"]}
    phases = phases_doc["phases"]
    decisions_by_id = {d["decision_id"]: d for d in decisions_doc["decisions"]}

    # Wipe existing raw/* before regenerating so this stage is idempotent.
    if RAW_DIR.exists():
        for p in RAW_DIR.rglob("*"):
            if p.is_file():
                p.unlink()
        for p in sorted(RAW_DIR.rglob("*"), reverse=True):
            if p.is_dir():
                p.rmdir()
    RAW_DIR.mkdir(parents=True, exist_ok=True)

    written = 0
    overview_count = 0

    for phase in phases:
        phase_dir = RAW_DIR / f"phase-{phase['phase_id']}-{phase['slug']}"
        phase_dir.mkdir(parents=True, exist_ok=True)

        # Resolve the sub-turn IDs that fall in this phase. The phase
        # references *merged* turn IDs; expand them to their sub-turns.
        m_start = int(phase["merged_turn_range"][0])
        m_end = int(phase["merged_turn_range"][1])
        sub_ids: list[str] = []
        for mid in range(m_start, m_end + 1):
            mkey = f"{mid:03d}"
            if mkey not in merged_turns:
                print(f"FATAL: merged turn {mkey} missing in turns.json", file=sys.stderr)
                return 4
            sub_ids.extend(merged_turns[mkey]["sub_turn_ids"])

        # Write each sub-turn as turn-NNN-<role>.md.
        toc_rows: list[tuple[str, str, int, int, int]] = []
        for sub_id in sub_ids:
            t = sub_turns[sub_id]
            body = text[t["byte_start"]:t["byte_end"]]
            frontmatter = (
                "---\n"
                f"turn_id: {t['turn_id']}\n"
                f"merged_turn_id: {t['merged_id']}\n"
                f"role: {t['role']}\n"
                f"phase: {phase['phase_id']}-{phase['slug']}\n"
                f"source_lines: [{t['line_start']}, {t['line_end']}]\n"
                f"source_sha256: {t['hash']}\n"
                f"char_count: {t['char_count']}\n"
                "---\n\n"
            )
            out_file = phase_dir / f"turn-{t['turn_id']}-{t['role']}.md"
            out_file.write_text(frontmatter + body, encoding="utf-8")
            written += 1
            toc_rows.append(
                (t["turn_id"], t["role"], t["line_start"], t["line_end"], t["char_count"])
            )

        # Write the phase 00-overview.md.
        overview_lines = [
            f"# Phase {phase['phase_id']}: {phase['name']}",
            "",
            f"**Merged turn range:** {phase['merged_turn_range'][0]}–{phase['merged_turn_range'][1]}  ",
            f"**Sub-turns:** {len(sub_ids)}  ",
            f"**Slug:** `{phase['slug']}`",
            "",
            "## Summary",
            "",
            phase["summary"],
            "",
        ]
        if phase.get("decision_ids"):
            overview_lines.append("## Decisions in this phase")
            overview_lines.append("")
            for did in phase["decision_ids"]:
                d = decisions_by_id.get(did)
                if d is None:
                    overview_lines.append(f"- `{did}` (missing in decisions.json)")
                else:
                    overview_lines.append(
                        f"- **{did}** [{d['tag']}] — {d['title']} "
                        f"(turns {', '.join(d['merged_turn_refs'])})"
                    )
            overview_lines.append("")

        overview_lines.append("## Sub-turn table of contents")
        overview_lines.append("")
        overview_lines.append("| Turn | Role | Source lines | Chars | File |")
        overview_lines.append("| ---- | ---- | ------------ | ----- | ---- |")
        for tid, role, ls, le, cc in toc_rows:
            overview_lines.append(
                f"| {tid} | {role} | {ls}–{le} | {cc} | "
                f"[turn-{tid}-{role}.md](turn-{tid}-{role}.md) |"
            )
        overview_lines.append("")

        if phase.get("notes"):
            overview_lines.append("## Reconciliation notes")
            overview_lines.append("")
            overview_lines.append(phase["notes"])
            overview_lines.append("")

        (phase_dir / "00-overview.md").write_text(
            "\n".join(overview_lines), encoding="utf-8"
        )
        overview_count += 1

    print(f"phases written:    {overview_count}")
    print(f"sub-turn files:    {written}")
    print(f"raw root:          {RAW_DIR.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
