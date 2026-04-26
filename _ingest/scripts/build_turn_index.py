"""Stage 0: Build turn index for the chat export.

Reads chat-export-2026-04-26T04-22-39.md from the repo root and emits:
  - _ingest/manifests/source.sha256
  - _ingest/manifests/turns.json

A "turn" is the content between two `---` delimiter lines whose body
opens with `## User` or `## Assistant`. Anything else (preamble before
the first delimiter, trailing content after the last) is captured as a
non-turn block in `extras` for traceability but does not get a turn_id.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE = REPO_ROOT / "chat-export-2026-04-26T04-22-39.md"
MANIFEST_DIR = REPO_ROOT / "_ingest" / "manifests"

DELIM_RE = re.compile(r"^---\s*$", re.MULTILINE)
ROLE_HEADING_RE = re.compile(r"^##\s+(User|Assistant)\s*$", re.MULTILINE)
FENCE_RE = re.compile(r"^(?:```|~~~)")


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def find_real_delimiters(text: str) -> list[tuple[int, int]]:
    """Return (byte_start, byte_end) spans for every `---` line that is
    outside a fenced code block. Matches inside ```/~~~ fences are skipped
    so horizontal-rule-style `---` inside assistant messages don't split
    turns."""
    result: list[tuple[int, int]] = []
    in_fence = False
    fence_marker: str | None = None
    line_start = 0
    for i, ch in enumerate(text):
        if ch != "\n" and i != len(text) - 1:
            continue
        # End-of-line reached; the line is text[line_start : i] (excluding
        # the newline if ch is "\n", or text[line_start : i+1] at EOF).
        line_end = i if ch == "\n" else i + 1
        line = text[line_start:line_end]
        stripped = line.rstrip("\r")
        # Track fence state.
        m = FENCE_RE.match(stripped)
        if m:
            marker = stripped[:3]
            if not in_fence:
                in_fence = True
                fence_marker = marker
            elif fence_marker is not None and stripped.startswith(fence_marker):
                in_fence = False
                fence_marker = None
        elif not in_fence and stripped.strip() == "---":
            # Real delimiter (outside any code fence).
            result.append((line_start, line_end))
        line_start = i + 1
    return result


def main() -> int:
    if not SOURCE.exists():
        print(f"FATAL: source not found at {SOURCE}", file=sys.stderr)
        return 2

    text = SOURCE.read_text(encoding="utf-8")
    text_bytes = SOURCE.read_bytes()
    source_hash = sha256_bytes(text_bytes)

    MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
    (MANIFEST_DIR / "source.sha256").write_text(
        f"{source_hash}  {SOURCE.name}\n", encoding="utf-8"
    )

    # Build a line-offset table: line N (1-indexed) starts at byte offset
    # line_starts[N-1]. Used to convert byte spans to line numbers.
    line_starts: list[int] = [0]
    for i, ch in enumerate(text):
        if ch == "\n":
            line_starts.append(i + 1)
    total_lines = len(line_starts)  # last index is one past final char

    def line_of(offset: int) -> int:
        # Binary-search by hand; bisect would also work.
        lo, hi = 0, len(line_starts) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if line_starts[mid] <= offset:
                lo = mid
            else:
                hi = mid - 1
        return lo + 1  # 1-indexed line

    # Find every `---` delimiter on its own line, skipping any that are
    # inside fenced code blocks (so horizontal rules in assistant messages
    # aren't mistaken for turn boundaries).
    raw_delims = [(m.start(), m.end()) for m in DELIM_RE.finditer(text)]
    delims = find_real_delimiters(text)
    if not delims:
        print("FATAL: no `---` delimiters found", file=sys.stderr)
        return 3
    skipped = len(raw_delims) - len(delims)

    # Sections between delimiters: section i is text[delims[i].end : delims[i+1].start]
    # We also have a preamble (text[0:delims[0].start]) and possibly a postamble.
    sections: list[dict] = []
    preamble_end = delims[0][0]
    if preamble_end > 0:
        body = text[:preamble_end].rstrip("\n")
        sections.append({
            "kind": "preamble",
            "byte_start": 0,
            "byte_end": preamble_end,
            "body": body,
        })

    for i in range(len(delims) - 1):
        body_start = delims[i][1]
        body_end = delims[i + 1][0]
        body = text[body_start:body_end]
        sections.append({
            "kind": "between",
            "byte_start": body_start,
            "byte_end": body_end,
            "body": body,
        })

    # Postamble (after final delimiter)
    final_end = delims[-1][1]
    if final_end < len(text):
        post = text[final_end:].rstrip("\n")
        if post:
            sections.append({
                "kind": "postamble",
                "byte_start": final_end,
                "byte_end": len(text),
                "body": post,
            })

    # Identify role for each "between" section by scanning for the first
    # `## User` / `## Assistant` heading.
    turns: list[dict] = []
    extras: list[dict] = []
    turn_counter = 0

    for sec in sections:
        body = sec["body"]
        body_stripped = body.strip("\n")
        match = ROLE_HEADING_RE.search(body)
        if sec["kind"] == "between" and match:
            role = match.group(1).lower()
            turn_counter += 1
            # Body, with the heading line removed, becomes the "turn body" for
            # hashing purposes. We hash the raw body (everything between the
            # delimiters) so re-extraction is byte-stable.
            byte_start = sec["byte_start"]
            byte_end = sec["byte_end"]
            line_start = line_of(byte_start)
            # line_of(byte_end) points to the start line of the *next* delim;
            # we want the last content line, so step back one if possible.
            line_end = line_of(byte_end - 1) if byte_end > byte_start else line_start
            body_hash = sha256_bytes(body.encode("utf-8"))
            turns.append({
                "turn_id": f"{turn_counter:03d}",
                "role": role,
                "line_start": line_start,
                "line_end": line_end,
                "byte_start": byte_start,
                "byte_end": byte_end,
                "char_count": len(body),
                "hash": body_hash,
                "first_chars": body_stripped[:120].replace("\n", " "),
            })
        else:
            extras.append({
                "kind": sec["kind"],
                "byte_start": sec["byte_start"],
                "byte_end": sec["byte_end"],
                "line_start": line_of(sec["byte_start"]) if sec["byte_end"] > sec["byte_start"] else 1,
                "line_end": line_of(max(sec["byte_start"], sec["byte_end"] - 1)),
                "char_count": len(body),
                "first_chars": body_stripped[:120].replace("\n", " "),
            })

    # The export emits one `## Role` block per text segment between tool
    # calls, so a single conversational reply can span multiple consecutive
    # same-role sub-turns. Build a "merged turn" view that collapses runs
    # of same-role sub-turns into one logical turn — that's the granularity
    # phase clustering operates on.
    merged_turns: list[dict] = []
    for t in turns:
        if merged_turns and merged_turns[-1]["role"] == t["role"]:
            m = merged_turns[-1]
            m["sub_turn_ids"].append(t["turn_id"])
            m["line_end"] = t["line_end"]
            m["byte_end"] = t["byte_end"]
            m["char_count"] += t["char_count"]
        else:
            merged_turns.append({
                "merged_id": f"{len(merged_turns) + 1:03d}",
                "role": t["role"],
                "sub_turn_ids": [t["turn_id"]],
                "line_start": t["line_start"],
                "line_end": t["line_end"],
                "byte_start": t["byte_start"],
                "byte_end": t["byte_end"],
                "char_count": t["char_count"],
                "first_chars": t["first_chars"],
            })

    # Tag each sub-turn with the merged_id it belongs to.
    sub_to_merged = {
        sub_id: m["merged_id"]
        for m in merged_turns
        for sub_id in m["sub_turn_ids"]
    }
    for t in turns:
        t["merged_id"] = sub_to_merged[t["turn_id"]]

    # Sanity checks.
    role_sequence = [m["role"] for m in merged_turns]
    alternation_ok = all(
        role_sequence[i] != role_sequence[i + 1] for i in range(len(role_sequence) - 1)
    )

    manifest = {
        "source": {
            "path": SOURCE.name,
            "sha256": source_hash,
            "byte_count": len(text_bytes),
            "char_count": len(text),
            "line_count": total_lines,
        },
        "stats": {
            "delimiter_count": len(delims),
            "turn_count": len(turns),
            "user_turns": sum(1 for t in turns if t["role"] == "user"),
            "assistant_turns": sum(1 for t in turns if t["role"] == "assistant"),
            "merged_turn_count": len(merged_turns),
            "merged_user_turns": sum(1 for m in merged_turns if m["role"] == "user"),
            "merged_assistant_turns": sum(1 for m in merged_turns if m["role"] == "assistant"),
            "extras_count": len(extras),
            "merged_alternation_ok": alternation_ok,
        },
        "merged_turns": merged_turns,
        "turns": turns,
        "extras": extras,
    }

    out = MANIFEST_DIR / "turns.json"
    out.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    print(f"source sha256:    {source_hash}")
    print(f"line count:       {total_lines}")
    print(f"raw `---` lines:  {len(raw_delims)} (skipped {skipped} inside code fences)")
    print(f"real delimiters:  {len(delims)}")
    print(f"sub-turn count:   {len(turns)} "
          f"(user={manifest['stats']['user_turns']}, "
          f"assistant={manifest['stats']['assistant_turns']})")
    print(f"merged turns:     {len(merged_turns)} "
          f"(user={manifest['stats']['merged_user_turns']}, "
          f"assistant={manifest['stats']['merged_assistant_turns']})")
    print(f"extras:           {len(extras)} block(s)")
    print(f"merged alt ok:    {alternation_ok}")
    print(f"wrote:            {out.relative_to(REPO_ROOT)}")
    print(f"wrote:            {(MANIFEST_DIR / 'source.sha256').relative_to(REPO_ROOT)}")

    if not alternation_ok:
        print("WARNING: turns do not strictly alternate User/Assistant", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
