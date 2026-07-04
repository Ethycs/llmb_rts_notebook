# Kernel folder-structure roadmap

**Status:** drafted 2026-07-03. Horizons defined; nothing started. The
kernel is post-V1 (`v1.0.0`, 908/908 tests green) and its folder tree
has not caught up with what the code became.
**Owners:** project lead + future you.
**Cadence:** updated when a horizon closes or when the kernel
trajectory (facade / MCP / extensions) re-orders the gates.

This is the strategic narrative — *what shape the kernel tree is
moving toward and why*. The operational analog:

- **How do I execute it?** →
  [`PLAN-kernel-folder-refactor.md`](PLAN-kernel-folder-refactor.md)
  — dispatch tables (R/T rows), the provisional package layout, shim
  mechanics, and per-commit verification.

---

## 1. Where we are (2026-07-03)

The kernel was forked from an upstream chat-mode project and then
developed hard through V1. The *code* crossed that distance; the
*folder tree* did not:

- **The package root reads as an experiment**, not a shipped
  substrate: tracked `.ipynb_checkpoints/` and `llm_kernel.log`,
  one-off PDF test scripts, a raw chat-export dump, duplicate debug
  notebooks, two pre-RFC-008 design docs, and three competing
  packaging authorities (`setup.py` + `requirements.txt` +
  `pyproject.toml`, plus a `pytest.ini` that silently overrides the
  pyproject pytest table).
- **`tests/` mixes the load-bearing 908-test suite** with ad-hoc
  debug scripts and ~15 scratch notebooks pytest never collects.
- **`llm_kernel/` is flat** — ~55 modules / 27.5k LOC at one level.
  The substrate core (capture, supervision, dispatch, notebook
  model) is interleaved with the fork-era chat surface (reranking,
  provider file handlers, clipboard, multimodal). Only `wire/` has
  the shape the whole package should have.
- **The tree leaks into the outer repo**: root
  `profile_default/history.sqlite` is tracked and perpetually dirty
  (recreated on every in-process kernel boot); kernel-adjacent
  strays sit at the repo root.

Why this matters *now*: the substrate trajectory
([PLAN-kernel-development §4](PLAN-kernel-development.md))
is about to add a facade, an external MCP transport, and an
extension contract on top of this tree. Every one of those slices
gets cheaper on a shaped package and more expensive on a flat one —
and moving modules *after* the facade lands means moving
freshly-written code.

The binding constraints (why this is a roadmap and not an
afternoon): **47 docs files hard-link into
`vendor/LLMKernel/...` paths** with file:line anchors, and **136
test files import flat `llm_kernel.<module>` paths**. Structure
moves must ship with compat shims and a scripted link sweep, and
must not overlap in-flight code edits.

## 2. Horizon 1 — Quiet the tree (now)

*Ship a `vendor/LLMKernel` root that looks like the V1 substrate it
is.* No dependencies; worth doing even if later horizons slip.

| Move | Outcome |
|---|---|
| Untrack litter (`.ipynb_checkpoints/`, `llm_kernel.log`; outer `profile_default/`) | `git status` quiet after a kernel boot + notebook session, both repos |
| Collapse packaging to `pyproject.toml`; delete `setup.py`, `requirements.txt`, `pytest.ini` | One authority for build, deps, and pytest |
| Relocate root strays (one-off tests, examples, chat export, design docs, `.bat` launchers) | Root = package + `tests/` + `demos/` + `docs/` + config |
| Split `tests/` into suite vs `tests/manual/` + `tests/notebooks/` | The 908-test suite is the folder's only ambient content; `markov/` harness untouched |

Exit criteria: dispatch rows R-01…R-12 + T-01…T-02 of the PLAN
landed; suite + smokes green; collect count unchanged.
Effort: ~half a day.

## 3. Horizon 2 — Shape the package (gated)

*Regroup flat `llm_kernel/` into domain subpackages* — `capture/`,
`supervision/`, `dispatch/`, `mcp/`, `notebook/`, `magics/`,
`transports/`, `providers/` (the fork-era surface, grouped so the
dead-code question becomes visible), `wire/` unchanged. Layout is
provisional until checked against the real import graph; the
invariants are **no cycles between subpackages** and **the capture
core never imports `providers/`**.

**Gates — both must hold before starting:**

1. **After** the PLAN-kernel-development Phase 1 hygiene sweep
   (SE-01…SE-07) lands — module moves are maximally rebase-hostile
   to in-flight edits of `agent_supervisor.py` / `_provisioning.py`
   / `metadata_writer.py`.
2. **Before** facade extraction (slice A) starts — the facade should
   land directly in the new layout, not get moved afterward.

Mechanics (detail in the PLAN): one cluster per `git mv` commit;
one-line re-export shims at every old module path so all 136 test
files stay green with zero edits during the move; a final scripted
import-rewrite deletes the shims (or parks them until slice A's
cleanup commit — decided at horizon start).

Exit criteria: layout matches the (adjusted) map; import-graph
invariants hold; no shims remain or their parking is documented;
908 + smokes green. Effort: ~1-2 days.

## 4. Horizon 3 — Docs that can't rot (rides on Horizon 2)

The 47 anchored docs are an asset — they make the kernel legible —
and an anchor-rot liability every time a file moves. Two
deliverables:

- `scripts/rewrite_kernel_links.py` — literal old→new path map
  derived from the Horizon-2 `git mv` log, applied across `docs/`
  (precedent: `scripts/reorg_docs.py`). Line anchors survive because
  file contents never change.
- `tools/check_doc_links.py` — a **standing** checker (precedent:
  `tools/check_atom_drift.py`): every `vendor/LLMKernel/...` and
  intra-docs link must resolve. Runs after Horizon 1 too, and after
  any future move, forever.

Also folds in the already-broken SE-11 link fix (coordinate with
PLAN-kernel-development so it's fixed once). Exit criteria: checker
reports zero broken links. Effort: ~half a day.

## 5. Beyond the horizon

Unlocked by this roadmap but owned elsewhere:

- **`providers/` dead-code audit** — grouping the fork-era chat
  surface makes "do we still ship reranking / provider file
  handlers?" a folder-sized question instead of a 55-module archaeology
  dig. Own it as a small follow-up plan after Horizon 2.
- **Facade, external MCP, extension contract** (slices A/B/C of the
  kernel trajectory) — land on the shaped tree. A future
  `extensions/` subpackage (slice C's `Extension.register(kernel)`
  contract, PBX as first citizen) slots into the Horizon-2 layout
  without another reshuffle.
- **FastMCP convergence** (SE-10) — the `mcp/` subpackage puts both
  MCP modules side-by-side, making the mixed-convention cleanup
  obvious when someone is next in there.

## 6. Sequencing spine

The kernel work, in one line:

**SE hygiene sweep (SE-01…07) → Horizon 1 → Horizon 2 + 3 →
facade (slice A) → external MCP (slice B) → extensions (slice C)**

Horizon 1 floats freely (can run before or alongside the SE sweep —
it touches no module contents). Horizons 2 and 3 are a single
campaign. The only wrong ordering is interleaving Horizon 2 with
either the SE sweep or slice A.

## 7. Genuine constraints (and what would unlock them)

| Constraint | What binds it | Unlock |
|---|---|---|
| `vendor/LLMKernel` path and `llm_kernel` package name are frozen | Outer `pyproject.toml` editable pin, `pixi.lock`, kernelspec argv (`python -m llm_kernel`) | Nothing needed — internal moves don't disturb any of them; renaming the roots is simply not on this roadmap |
| Old import paths must keep resolving mid-campaign | 136 test files import flat paths | Shims (Horizon 2 mechanics); removed at campaign end |
| Doc anchors must survive moves | 47 docs link `vendor/LLMKernel/...` with line anchors | Scripted rewrite + standing checker (Horizon 3) |

## 8. Non-goals

So they don't get re-litigated every session:

- **No behavior changes** — every commit on this roadmap is
  move / untrack / config-only; suite + smokes green throughout.
- **No dead-code deletion** — Horizon 2 groups the fork-era surface;
  deleting it is the §5 audit's call, made on evidence.
- **No microkernel/bus restructuring** — SE-09's dispatcher stays as
  is; folder shape must not smuggle in architecture changes.
- **No wire-format or RFC changes** — folders move, envelopes don't.

## 9. Trajectory summary (one paragraph)

The kernel's code became a shipped legibility substrate; this
roadmap makes the folder tree say so. Horizon 1 clears the fork-era
sediment so the root reads as a product. Horizon 2 shapes the flat
55-module package into domain subpackages — capture core separated
from supervision, dispatch, transports, and the legacy provider
surface — gated to land between the code-hygiene sweep and the
facade extraction so nothing is moved twice. Horizon 3 makes the
richly-anchored docs move-proof with a scripted rewrite and a
standing link checker. Downstream, the facade, external MCP
transport, and extension contract land on a tree whose shape matches
the architecture they extend — and the grouped `providers/` folder
turns the lingering dead-code question into a decision instead of an
excavation.

---

**Last updated:** 2026-07-03. Next review when Horizon 1 closes or
when slice-A scheduling forces the Horizon-2 GO/NO-GO call.
