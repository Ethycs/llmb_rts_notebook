# PLAN — Kernel folder refactor: layout hygiene + package regrouping

**Status**: drafted 2026-07-03. Not started. Operational analog of
[`ROADMAP-kernel-folders.md`](../06%20-%20Roadmaps/ROADMAP-kernel-folders.md)
(the strategic narrative; Phases 1/2/3 here = Horizons 1/2/3 there).
Companion plan to
[`PLAN-kernel-development.md`](PLAN-kernel-development.md) (code
hygiene) and [`PLAN-kernel-facade.md`](PLAN-kernel-facade.md)
(slice-A facade extraction).

**Audience**: an LLM or operator picking up kernel folder-structure
work cold. Self-contained.

**Goal**: bring the `vendor/LLMKernel` folder tree in line with what
the kernel now is — a shipped V1 substrate, not an experimental
upstream fork. Three layers: (1) untrack/relocate root clutter,
(2) separate the real pytest suite from ad-hoc debug scripts,
(3) regroup the flat 55-module `llm_kernel` package into
domain subpackages, with a scripted doc-link sweep.

## §1. Why this plan exists

The kernel was forked from an upstream "LLM Kernel" chat-mode
project and then heavily developed through V1 (`v1.0.0`, `127a034`,
908/908 tests). The folder tree still carries the fork's sediment:

- **Root clutter, tracked in git**: `.ipynb_checkpoints/` (4 files),
  `llm_kernel.log` (gitignored *now* but tracked before the ignore
  landed), stray one-off test scripts (`test_notebook_pdf_upload.py`,
  `test_openai_assistant_pdf.py`, `test_chat_mode.ipynb`), a raw
  chat-export dump
  (`LiteLLM_Jupyter_Kernel_Context_Management_…2025-07-03….md`),
  duplicate debug notebooks (`debug/debug_kernel.ipynb` vs
  `demos/debug_kernel.ipynb`), two pre-RFC-008 design docs at root,
  and three competing packaging/config authorities
  (`setup.py` + `requirements.txt` + `pyproject.toml`;
  `pytest.ini` + `[tool.pytest.ini_options]`).
- **`tests/` mixes concerns**: the real 908-test pytest suite shares
  the folder with ad-hoc scripts (`check_*.py`, `debug_pdf_*.py`,
  `run_pdf_tests.py`, `notebook_path_methods.py`) and ~15 scratch
  `.ipynb` notebooks that pytest never collects.
- **Flat package**: `llm_kernel/` holds ~55 modules / 27.5k LOC at
  one level, with only three subpackages (`wire/`,
  `intent_handlers/`, `magic_commands/`). The live substrate core
  (capture, supervision, dispatch, notebook model) is
  interleaved with the fork-era chat-mode surface (reranking,
  provider file integrations, clipboard, multimodal). Every new
  contributor pays the flatness tax; the facade extraction
  (slice A) is about to add more top-level modules.
- **Outer-repo spillover**: root `profile_default/history.sqlite` is
  tracked and shows as perpetually modified (the kernel recreates it
  on every in-process boot — the vendor `.gitignore` already ignores
  its own copy; the outer repo does not); root `test_chat_mode.ipynb`
  and `chat-export-2026-04-26….md` are kernel-adjacent strays.

**What makes this non-trivial**: 47 files under `docs/` hard-link
into `vendor/LLMKernel/llm_kernel/...` and `vendor/LLMKernel/tests/...`
paths — including file:line anchors in the dispatch tables of
PLAN-kernel-development and PLAN-kernel-facade. Any module move must
ship with a scripted link rewrite, and tests import via
`from llm_kernel.<module> import ...` (136 test files), so old module
paths must keep resolving during the transition.

## §2. Goals and non-goals

### Goals

- `git status` inside `vendor/LLMKernel` is quiet: no tracked logs,
  checkpoints, or generated artifacts.
- One packaging authority (`pyproject.toml`), one pytest config.
- `tests/` contains only pytest-collected suite + fixtures; ad-hoc
  scripts and scratch notebooks live in clearly-labeled folders.
- `llm_kernel/` regrouped into domain subpackages with
  behavior-preserving `git mv` commits, compat shims at every old
  module path, and a scripted docs-link sweep.
- A repeatable doc-link checker exists in `tools/` so future moves
  can't silently break the 47 anchored docs.

### Non-goals

- **No code behavior changes.** Every commit is move/untrack/config
  only. The 908-test suite and all four smoke tests stay green at
  every commit.
- **No rename of `vendor/LLMKernel` or the `llm_kernel` package
  name.** Outer `pyproject.toml` pins
  `llm-kernel = { path = "vendor/LLMKernel", editable = true }` and
  `pixi.lock` embeds it; the kernelspec argv invokes
  `python -m llm_kernel`. Both stay.
- **No dead-code deletion decisions.** Whether the fork-era chat
  modules (reranking, provider file handlers, …) should be deleted
  is a separate audit; this plan only *groups* them so the question
  becomes visible.
- **Does not subsume PLAN-kernel-development.** SE-01…SE-12 are code
  edits; this plan never edits module contents (shim files are new
  files, not edits).

## §3. Dispatch table — root + tests hygiene (Phase 1)

Each row is independent and behavior-preserving. Paths relative to
`vendor/LLMKernel/` unless prefixed `ROOT:` (outer repo).

| # | Item | Problem | Fix | Verify |
|---|---|---|---|---|
| R-01 | `.ipynb_checkpoints/` (root + `demos/`) | Editor litter tracked in git | `git rm -r --cached`, add `**/.ipynb_checkpoints/` to `.gitignore` | `git ls-files | grep checkpoints` empty |
| R-02 | `llm_kernel.log` | Runtime log tracked (ignore rule added after tracking) | `git rm --cached llm_kernel.log` | `git ls-files` clean; boot kernel, `git status` quiet |
| R-03 | `test_notebook_pdf_upload.py`, `test_openai_assistant_pdf.py`, `test_chat_mode.ipynb` (root) | One-off PDF/chat experiments at package root; also collected by the stale `testpaths=["."]` in pyproject | `git mv` → `tests/manual/` (created in T-01) | pytest count unchanged (they were never in `tests/`) |
| R-04 | `example.ipynb`, `example_notebook_path_usage.py`, `clear_notebook_outputs.py` | Demos/utilities at root | `git mv` examples → `demos/`; `clear_notebook_outputs.py` → outer `tools/` (sibling of `check_atom_drift.py`) | manual run of the tool from new path |
| R-05 | `debug/debug_kernel.ipynb`, `debug_kernel.json` | Duplicate of `demos/debug_kernel.ipynb`; orphaned debug kernelspec | Diff the two notebooks; keep one in `demos/`, delete `debug/`. Keep `debug_kernel.json` only if a `.vscode/launch.json` config references it — else delete | `grep -r debug_kernel .vscode docs` |
| R-06 | `LiteLLM_Jupyter_Kernel_Context_Management_…md` | 1 raw LLM-conversation export at package root | Move to outer `_ingest/` (the decompose pipeline's intake) or delete if already decomposed | `_ingest/` listing |
| R-07 | `vscode_extension_design.md`, `vscode_seamless_integration.md` | Pre-RFC-008 design docs at root; superseded by RFC-008 / BSP-004 | Move to `vendor/LLMKernel/docs/` with a `> Historical — superseded by RFC-008` banner, or into outer `docs/` archive | link check |
| R-08 | `setup.py`, `requirements.txt` | Three packaging authorities; pixi installs editable via `pyproject.toml` | Delete both. First grep repo + CI for references | `pixi install` + `pixi run -e kernel python -c "import llm_kernel"` from clean env |
| R-09 | `pytest.ini` vs `[tool.pytest.ini_options]` | Duplicate config; `pytest.ini` silently wins; pyproject's `testpaths=["."]` is wrong | Merge into pyproject (`testpaths=["tests"]`), delete `pytest.ini` | `pytest --collect-only -q | tail -1` == 908 |
| R-10 | `start_console.bat`, `start_jupyter.bat` | Windows launchers duplicating pixi tasks (`bootstrap`, `lab`) | Delete if pixi tasks cover them; else move to a `scripts/` subfolder | run the pixi tasks |
| R-11 | ROOT: `profile_default/` | `history.sqlite` tracked + perpetually dirty (kernel recreates it each in-process boot) | `git rm -r --cached profile_default`, add `profile_default/` to root `.gitignore` (vendor copy already ignores it) | boot kernel; `git status` quiet |
| R-12 | ROOT: `test_chat_mode.ipynb`, `chat-export-2026-04-26….md` | Kernel-adjacent strays at repo root | notebook → `vendor/LLMKernel/demos/` or delete (duplicate name exists there); export → `_ingest/` | root listing |
| T-01 | `tests/check_kernel_env.py`, `check_multimodal.py`, `debug_pdf_context.py`, `debug_pdf_upload.py`, `run_pdf_tests.py`, `notebook_path_methods.py` | Ad-hoc scripts inside the pytest tree | `git mv` → `tests/manual/` with a README ("not collected; run by hand") | `pytest --collect-only` count unchanged |
| T-02 | ~15 scratch `.ipynb` in `tests/` (`test_all_magics.ipynb`, `test_pdf_*.ipynb`, …) | Never collected by pytest; ambiguous status | `git mv` → `tests/notebooks/` with README, or `demos/` where they duplicate | collect count unchanged |
| T-03 | `tests/markov/` | Property/invariant harness — **keep as-is** (has its own conftest + README) | No move | — |

`.env.debug` was inspected: debug flags only, no secrets. Keep.

## §4. Package regrouping (Phase 2) — provisional target layout

Regroup `llm_kernel/` by domain. Cluster assignments below are
**provisional** — before executing, generate the real import graph
(`grep`-level is enough) and adjust; the invariant is *no import
cycles between subpackages* and *the capture core never imports the
provider layer*.

```
llm_kernel/
├── __init__.py          # public surface; where the facade's `Kernel` will export
├── __main__.py          # subcommand CLI (stays)
├── kernel.py            # ipykernel subclass (stays — the eponym)
├── app.py               # FastAPI lifespan (slice A will consume it)
├── install.py           # kernelspec installer (console script target)
├── config_manager.py
├── capture/             # the substrate's write path — what SE-07 defends
│   metadata_writer, event_log, run_tracker, run_envelope,
│   context_packer, socket_writer, drift_detector, _otlp_log_handler
├── supervision/
│   agent_supervisor, _provisioning, inline_agent
├── dispatch/            # envelope routing + intent handlers
│   custom_messages, auth_handlers, intent_handlers/*
├── mcp/
│   mcp_server, mcp_manager
├── notebook/            # notebook object model
│   cell_manager, cell_text, notebook_format, notebook_utils,
│   overlay_applier, zone_control, file_actions
├── magics/              # magic_commands/ merged in
│   magic_registry, magic_hash, magic_generators, magic_emit_tool,
│   base, config, context, mcp, multimodal, multimodal_native_pdf, reranking
├── transports/
│   pty_mode, serve_mode
├── providers/           # fork-era chat-mode surface, grouped for later audit
│   llm_integration, litellm_proxy, anthropic_passthrough,
│   anthropic_file_integration, openai_assistant_integration,
│   openai_file_handler, gemini_file_integration, multimodal,
│   file_upload_manager, file_cache_manager, clipboard_utils,
│   context_manager, dialogue_pruner
├── wire/                # unchanged — already correct
└── _internal/
    _attrs, _rfc_schemas, _kernel_hooks, _diagnostics, _mitm_addon
```

### Compatibility mechanics

1. **Shims, not `__getattr__`.** All 136 test files import
   `from llm_kernel.<module> import X`. After each `git mv`, leave a
   one-line shim at the old path
   (`llm_kernel/agent_supervisor.py` → `from .supervision.agent_supervisor import *  # noqa: F401,F403`
   plus explicit re-export of underscore names the tests use). Shims
   keep the whole suite green with zero test edits during the move.
2. **One cluster per commit**, `git mv` so `--follow` history
   survives. Suite + smokes green after every commit.
3. **Final commits of the phase**: (a) scripted rewrite of test
   imports to new paths, (b) delete shims, (c) run the doc sweep
   (§5). If facade work (slice A) is imminent, shims may instead be
   kept until slice A lands and deleted in its cleanup commit —
   decide at phase start.

### Ordering vs. the other kernel plans

- **PLAN-kernel-development Phase 1 (SE-01…SE-07)** edits
  `agent_supervisor.py`, `_provisioning.py`, `metadata_writer.py`.
  Module moves are maximally rebase-hostile to in-flight edits —
  **do not overlap**. Land SE-01…SE-07 first (they're small and
  high-value), then regroup.
- **PLAN-kernel-facade (slice A)** references flat module paths in
  its 10-commit decomposition. Regrouping **before** facade work
  starts is cheapest: the facade then lands directly in the new
  layout, and the doc sweep (§5) patches the facade plan's path
  references in the same pass. Regrouping *after* facade means
  moving freshly-written code — avoid.
- Net recommended order: **hygiene sweep (SE rows) → this plan
  Phase 1 → this plan Phase 2+3 → facade (slice A) → MCP transport
  (B) → extensions (C)**.

## §5. Docs-link sweep (Phase 3)

47 files under `docs/` link into `vendor/LLMKernel/...` paths
(heaviest: `metadata_writer.py` ×16, `agent_supervisor.py` ×15,
`cell_manager.py` ×11, `custom_messages.py` ×10). Line anchors stay
valid — file contents don't change — only path prefixes move.

1. Write `scripts/rewrite_kernel_links.py` (precedent:
   `scripts/reorg_docs.py`): a literal old-path → new-path map
   derived from the Phase 2 `git mv` log, applied across `docs/`,
   `vendor/LLMKernel/docs/`, and the two READMEs.
2. Write `tools/check_doc_links.py` (precedent:
   `tools/check_atom_drift.py`): for every
   `[...](...vendor/LLMKernel/...)` and intra-docs relative link,
   assert the target file exists. Run it in Phase 1 too (it will
   catch R-05/R-07 fallout) and keep it as a standing tool.
3. Also patch in the sweep: SE-11's already-broken
   `PLAN-kernel-facade.md` link in
   `docs/04 - Reference/kernel/README.md` (coordinate with
   PLAN-kernel-development so it's fixed once, not twice).

## §6. Verification

Per commit, from the outer repo root:

```powershell
pixi run -e kernel python -m pytest vendor/LLMKernel/tests/ -x -q   # 908 green
pixi run -e kernel python -m llm_kernel pty-mode-smoke
pixi run -e kernel python -m llm_kernel agent-supervisor-smoke
pixi run -e kernel python -m llm_kernel metadata-writer-smoke
python tools/check_doc_links.py                                      # once it exists
```

Phase-2-specific: after each cluster commit, additionally
`pixi run -e kernel python -c "import llm_kernel.<old_path>"` for
every shimmed module (scriptable from the shim list), and one
end-to-end kernelspec boot (`python -m llm_kernel.install install` +
open a notebook) after the `install.py`/`kernel.json` rows.

## §7. Sequencing and effort

| Phase | Content | Depends on | Effort |
|---|---|---|---|
| 1 | R-01…R-12, T-01…T-02 as ~6 small commits | nothing | ~half day |
| 2 | Package regrouping, one cluster per commit + shims | SE-01…SE-07 landed (avoid rebase pain) | ~1-2 days |
| 3 | Link-rewrite script + doc sweep + standing link checker | Phase 2 mv log | ~half day |

Phase 1 can start immediately and is worth doing even if Phase 2 is
deferred. Phase 2's GO/NO-GO should be decided when facade work is
scheduled: the only wrong choice is interleaving them.

## §8. Cross-references

- [PLAN-kernel-development.md](PLAN-kernel-development.md) — code
  hygiene (SE rows) + substrate trajectory; sequence before Phase 2.
- [PLAN-kernel-facade.md](PLAN-kernel-facade.md) — slice A; sequence
  after Phase 2, path references patched by the §5 sweep.
- [`docs/04 - Reference/kernel/README.md`](../04%20-%20Reference/kernel/README.md)
  — kernel doc index; SE-11 link fix coordinated in §5.
- `scripts/reorg_docs.py`, `tools/check_atom_drift.py` — house
  precedents for scripted doc moves and standing doc checks.

## §9. Definition of done

- `git status` quiet after a kernel boot + notebook session (no
  tracked logs, checkpoints, `profile_default` churn) — both repos.
- `pyproject.toml` is the sole packaging and pytest authority in
  `vendor/LLMKernel`; `setup.py`, `requirements.txt`, `pytest.ini`
  gone.
- `vendor/LLMKernel` root contains only: package, `tests/`, `demos/`,
  `docs/`, packaging/config files, READMEs, kernelspec files that
  something references.
- `tests/` = pytest suite + `markov/` + `fixtures`; ad-hoc material
  under `tests/manual/` and `tests/notebooks/` with READMEs.
- `llm_kernel/` subpackage layout matches the (adjusted) §4 map; no
  shims remain (or shims explicitly parked pending slice A, with a
  note here); import-graph invariant holds (capture core does not
  import `providers/`).
- 908/908 tests and all four smokes green; `tools/check_doc_links.py`
  reports zero broken links across `docs/`.
