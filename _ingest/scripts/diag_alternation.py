"""Diagnostic: print pairs of consecutive turns that share a role."""
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
data = json.loads((REPO / "_ingest" / "manifests" / "turns.json").read_text(encoding="utf-8"))
turns = data["turns"]
print(f"total turns: {len(turns)}")
breaks = 0
for a, b in zip(turns, turns[1:]):
    if a["role"] == b["role"]:
        breaks += 1
        print(f"\n--- consecutive {a['role']} pair ---")
        print(f"  turn {a['turn_id']} (lines {a['line_start']}-{a['line_end']}, {a['char_count']} chars)")
        print(f"    head: {a['first_chars'][:100]!r}")
        print(f"  turn {b['turn_id']} (lines {b['line_start']}-{b['line_end']}, {b['char_count']} chars)")
        print(f"    head: {b['first_chars'][:100]!r}")
print(f"\ntotal alternation breaks: {breaks}")
