#!/usr/bin/env python3
"""Reorganize docs/ into the 00-07 numbered folders.

One deterministic pass: compute a move map for every file under docs/, move
them with `git mv` (preserving history), then rewrite every relative markdown
link repo-wide so nothing breaks.

Usage (run under pixi, see pixi_guide.md):
    pixi run python scripts/reorg_docs.py --check      # report broken md links
    pixi run python scripts/reorg_docs.py --plan       # print the move map
    pixi run python scripts/reorg_docs.py --apply      # do moves + link rewrite

Destination folders contain spaces ("04 - Reference"); generated link targets
URL-encode spaces as %20 (raw spaces break markdown rendering on GitHub).
"""
from __future__ import annotations

import argparse
import posixpath
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath

REPO = Path(__file__).resolve().parent.parent

# Dirs we never touch when rewriting links (third-party / build output).
EXCLUDE_PARTS = (".pixi", "node_modules", ".vscode-test", ".git", "vendor")

# Intact-directory moves (longest-prefix match). Files inside keep their
# sub-path so intra-directory links survive untouched.
DIR_MOVES = {
    "docs/dev-guide": "docs/01 - Design/dev-guide",
    "docs/decisions": "docs/02 - Implementation/decisions",
    "docs/ops": "docs/02 - Implementation/ops",
    "docs/atoms": "docs/04 - Reference/atoms",
    "docs/kernel": "docs/04 - Reference/kernel",  # PLAN-* overridden below
    "docs/rfcs": "docs/05 - Standards/rfcs",
    # Dispersed dirs: a *directory* link falls back to its dominant home.
    "docs/bsps": "docs/03 - Blueprint",
    "docs/notebook": "docs/03 - Blueprint",
}


def map_file(rel: str) -> str | None:
    """Return the new repo-relative path for a docs file, or None if unmoved."""
    if not rel.startswith("docs/"):
        return None
    name = posixpath.basename(rel)

    # docs/README.md stays put (rewritten by hand, not moved).
    if rel == "docs/README.md":
        return None

    # notebook/ is split by filename.
    if rel.startswith("docs/notebook/"):
        if name.startswith(("BSP-", "FSP-", "KB-")):
            return f"docs/03 - Blueprint/{name}"
        if name == "VERSIONING.md":
            return f"docs/05 - Standards/{name}"
        if name.startswith("PLAN-") or name.startswith("SESSION-"):
            return f"docs/07 - Status Reports/{name}"
        # any other loose notebook file -> Blueprint
        return f"docs/03 - Blueprint/{name}"

    # kernel/: PLAN-* are status reports, everything else is reference.
    if rel.startswith("docs/kernel/"):
        if name.startswith("PLAN-"):
            return f"docs/07 - Status Reports/{name}"
        sub = rel[len("docs/kernel/"):]
        return f"docs/04 - Reference/kernel/{sub}"

    # bsps/ -> Blueprint (flat).
    if rel.startswith("docs/bsps/"):
        return f"docs/03 - Blueprint/{name}"

    # Remaining intact-dir moves (atoms, decisions, dev-guide, ops, rfcs).
    for src, dst in DIR_MOVES.items():
        if rel == src or rel.startswith(src + "/"):
            if src in ("docs/bsps", "docs/notebook"):
                continue  # handled above
            return dst + rel[len(src):]

    return None


def map_dir(target: str) -> str:
    """Map a directory-link target via longest-prefix DIR_MOVES match."""
    best = None
    for src in DIR_MOVES:
        if target == src or target.startswith(src + "/"):
            if best is None or len(src) > len(best):
                best = src
    if best is None:
        return target
    return DIR_MOVES[best] + target[len(best):]


def build_file_moves() -> dict[str, str]:
    out = subprocess.run(
        ["git", "ls-files", "docs/"], cwd=REPO, capture_output=True, text=True, check=True
    ).stdout.splitlines()
    moves: dict[str, str] = {}
    for rel in out:
        rel = rel.strip()
        if not rel:
            continue
        new = map_file(rel)
        if new and new != rel:
            moves[rel] = new
    return moves


# ---- link rewriting -------------------------------------------------------

# inline links/images: ](url)   and reference defs:  [id]: url
INLINE_LINK = re.compile(r"(?<=\])\(([^)\s]+)\)")
REF_DEF = re.compile(r"^(\s*\[[^\]]+\]:\s*)(\S+)", re.MULTILINE)


def is_relative_link(url: str) -> bool:
    if url.startswith(("#", "/", "http://", "https://", "mailto:", "tel:", "ftp://")):
        return False
    if "://" in url:
        return False
    return True


def split_anchor(url: str) -> tuple[str, str]:
    if "#" in url:
        path, anchor = url.split("#", 1)
        return path, "#" + anchor
    return url, ""


def encode_spaces(path: str) -> str:
    return path.replace(" ", "%20").replace("%2520", "%20")


def resolve_target(src_old: str, link_path: str) -> str:
    """Resolve a link to a repo-relative posix path (decoding %20)."""
    decoded = link_path.replace("%20", " ")
    base = posixpath.dirname(src_old)
    joined = posixpath.normpath(posixpath.join(base, decoded))
    return joined


def remap_target(target_rel: str, file_moves: dict[str, str]) -> str:
    if target_rel in file_moves:
        return file_moves[target_rel]
    return map_dir(target_rel)


def rewrite_url(url: str, src_old: str, src_new: str, file_moves: dict[str, str]) -> str:
    if not is_relative_link(url):
        return url
    path, anchor = split_anchor(url)
    if path == "":
        return url  # pure anchor (shouldn't reach here)
    trailing_slash = path.endswith("/")
    target_old = resolve_target(src_old, path)
    target_new = remap_target(target_old, file_moves)
    new_base = posixpath.dirname(src_new)
    rel = posixpath.relpath(target_new, new_base or ".")
    if trailing_slash and not rel.endswith("/"):
        rel += "/"
    return encode_spaces(rel) + anchor


def rewrite_file(path: Path, src_old: str, src_new: str, file_moves: dict[str, str]) -> bool:
    text = path.read_text(encoding="utf-8")
    original = text

    def _inline(m: re.Match) -> str:
        return "(" + rewrite_url(m.group(1), src_old, src_new, file_moves) + ")"

    def _ref(m: re.Match) -> str:
        return m.group(1) + rewrite_url(m.group(2), src_old, src_new, file_moves)

    text = INLINE_LINK.sub(_inline, text)
    text = REF_DEF.sub(_ref, text)
    if text != original:
        path.write_text(text, encoding="utf-8")
        return True
    return False


def all_markdown_files() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "*.md"], cwd=REPO, capture_output=True, text=True, check=True
    ).stdout.splitlines()
    files = []
    for rel in out:
        rel = rel.strip()
        if not rel:
            continue
        parts = PurePosixPath(rel).parts
        if any(p in EXCLUDE_PARTS for p in parts):
            continue
        files.append(rel)
    return files


# ---- commands -------------------------------------------------------------

def cmd_plan() -> int:
    moves = build_file_moves()
    for old in sorted(moves):
        print(f"{old}\n    -> {moves[old]}")
    print(f"\n{len(moves)} files move.")
    return 0


def cmd_check(file_moves: dict[str, str] | None = None) -> int:
    """Report relative md links whose target file/dir does not exist on disk.

    If file_moves is given, links are resolved *as if* the move already
    happened (used to predict post-move integrity without touching disk).
    """
    broken = 0
    total = 0
    for rel in all_markdown_files():
        new_rel = (file_moves or {}).get(rel, rel)
        text = (REPO / rel).read_text(encoding="utf-8")
        urls = [m.group(1) for m in INLINE_LINK.finditer(text)]
        urls += [m.group(2) for m in REF_DEF.finditer(text)]
        for url in urls:
            if not is_relative_link(url):
                continue
            path, _ = split_anchor(url)
            if not path or not (path.endswith(".md") or path.endswith("/")):
                continue
            total += 1
            target_old = resolve_target(rel, path)
            target_new = remap_target(target_old, file_moves) if file_moves else target_old
            if not (REPO / target_new).exists():
                broken += 1
                print(f"BROKEN  {new_rel}  ->  {url}  (resolves to {target_new})")
    print(f"\n{broken} broken / {total} relative md links checked.")
    return broken


def cmd_apply() -> int:
    file_moves = build_file_moves()
    print(f"Moving {len(file_moves)} files...")
    for old, new in sorted(file_moves.items()):
        dst = REPO / new
        dst.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "mv", old, new], cwd=REPO, check=True)
    reverse = {new: old for old, new in file_moves.items()}

    print("Rewriting links...")
    changed = 0
    for rel in all_markdown_files():
        src_old = reverse.get(rel, rel)
        if rewrite_file(REPO / rel, src_old, rel, file_moves):
            changed += 1
    print(f"Rewrote links in {changed} files.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--plan", action="store_true", help="print the move map")
    g.add_argument("--check", action="store_true", help="report broken md links (current disk)")
    g.add_argument("--predict", action="store_true", help="report broken md links as if moved")
    g.add_argument("--apply", action="store_true", help="move files + rewrite links")
    args = ap.parse_args()

    if args.plan:
        return cmd_plan()
    if args.check:
        return 0 if cmd_check() >= 0 else 1
    if args.predict:
        cmd_check(build_file_moves())
        return 0
    if args.apply:
        return cmd_apply()
    return 1


if __name__ == "__main__":
    sys.exit(main())
