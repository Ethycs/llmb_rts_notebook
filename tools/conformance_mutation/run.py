"""Mutation check for the conformance suites.

Each mutant in ``mutants.py`` breaks one documented contract of the merged facade,
drift-everywhere and magic-defense features with a single exact text replacement, while the
module still imports. This runner applies one mutant at a time, runs the chosen test paths,
restores the files byte for byte, and reports whether the tests caught it (any failure) or
the mutant survived.

    pixi run -e kernel python tools/conformance_mutation/run.py            # every mutant
    pixi run -e kernel python tools/conformance_mutation/run.py -m pin-in-agent-env
    pixi run -e kernel python tools/conformance_mutation/run.py --list

Test paths default to the kernel's tests/conformance and the notebook's tests/conformance;
pass ``--tests kernel:tests/conformance notebook:tests/conformance/reference`` to choose.
Run it from a clean checkout: it edits product files while a mutant is applied and refuses to
start if a target file has uncommitted changes.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
NOTEBOOK = HERE.parents[1]
KERNEL = NOTEBOOK / "vendor" / "LLMKernel"
sys.path.insert(0, str(HERE))
from mutants import MUTANTS  # noqa: E402

ROOTS = {"kernel": KERNEL, "notebook": NOTEBOOK}


def _path(rel: str) -> Path:
    root, _, sub = rel.partition(":")
    return ROOTS[root] / sub


def _check(name: str) -> None:
    for rel, old, _new in MUTANTS[name]:
        n = _path(rel).read_text(encoding="utf-8").count(old)
        if n != 1:
            raise SystemExit(f"{name}: {rel}: expected 1 occurrence, found {n}")


def _dirty(rel: str) -> bool:
    root, _, sub = rel.partition(":")
    out = subprocess.run(["git", "-C", str(ROOTS[root]), "status", "--porcelain", "--", sub],
                         capture_output=True, text=True).stdout
    return bool(out.strip())


def _run_tests(targets: list[tuple[Path, str]], timeout: int) -> list[int]:
    codes = []
    for root, path in targets:
        cmd = [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", path]
        try:
            codes.append(subprocess.run(cmd, cwd=root, capture_output=True, text=True,
                                        timeout=timeout).returncode)
        except subprocess.TimeoutExpired:
            codes.append(-1)
    return codes


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("-m", "--mutant", action="append", help="mutant name (repeatable)")
    ap.add_argument("--tests", nargs="+",
                    default=["kernel:tests/conformance", "notebook:tests/conformance"],
                    help="repo:path test targets (repo = kernel or notebook)")
    ap.add_argument("--timeout", type=int, default=900, help="seconds per test run")
    ap.add_argument("--list", action="store_true", help="list mutants and exit")
    args = ap.parse_args()
    if args.list:
        for name in MUTANTS:
            print(name)
        return 0
    names = args.mutant or list(MUTANTS)
    unknown = [n for n in names if n not in MUTANTS]
    if unknown:
        raise SystemExit(f"unknown mutant(s): {unknown}")
    targets = []
    for t in args.tests:
        root, _, path = t.partition(":")
        targets.append((ROOTS[root], path))
    for n in names:
        _check(n)
        dirty = [rel for rel, _o, _n in MUTANTS[n] if _dirty(rel)]
        if dirty:
            raise SystemExit(f"{n}: uncommitted changes in {dirty}; run from a clean checkout")

    base = _run_tests(targets, args.timeout)
    if any(c != 0 for c in base):
        print(f"the tests do not pass on the unmodified code (exit codes {base})")
        return 2
    caught = 0
    for n in names:
        saved = {}
        t0 = time.monotonic()
        try:
            for rel, old, new in MUTANTS[n]:
                p = _path(rel)
                text = saved.setdefault(p, p.read_text(encoding="utf-8"))
                p.write_text(p.read_text(encoding="utf-8").replace(old, new, 1), encoding="utf-8")
            codes = _run_tests(targets, args.timeout)
        finally:
            for p, text in saved.items():
                p.write_text(text, encoding="utf-8")
        hit = any(c not in (0, 5) for c in codes)
        caught += hit
        print(f"{'CAUGHT  ' if hit else 'SURVIVED'} {n:34s} exit codes {codes} "
              f"({time.monotonic() - t0:.0f}s)", flush=True)
    print(f"{caught}/{len(names)} mutants caught")
    return 0 if caught == len(names) else 1


if __name__ == "__main__":
    sys.exit(main())
