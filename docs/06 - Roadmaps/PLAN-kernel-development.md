# PLAN — Kernel development: hygiene sweep + substrate trajectory

**Status**: drafted 2026-06-30. Not started. Companion plan to
[`PLAN-kernel-facade.md`](PLAN-kernel-facade.md) (slice-2 detail).

**Audience**: an LLM or operator picking up post-V1 kernel work cold.
Self-contained.

**Goal**: consolidate the pending kernel-side work in two layers —
(1) sharp-edge hygiene items independent of any feature work, and
(2) the post-V1 substrate trajectory (facade → external MCP →
extensions) that gives the kernel legs beyond the VS Code extension.

## §1. Why this plan exists

V1 shipped 2026-06-30 (`v1.0.0`, commit `127a034`). All 14 rows of
[PLAN-v1-roadmap §5](PLAN-v1-roadmap.md) closed green. The substrate
gaps identified in
[PLAN-substrate-gap-closure.md](PLAN-substrate-gap-closure.md)
(G2/G4/G5/G8/G9/G10/G11/G12/G13) all landed. Kernel tests are
908/908.

That set of gap closures was **feature completeness** — missing
modules, missing intent kinds, missing meta-tools. This plan covers
the different category surfaced during the V2-lane design
conversation: **code-hygiene sharp edges** the kernel accumulated
during the V1 shipping push, plus the **post-V1 substrate trajectory**
that the kernel-as-legibility-substrate framing implies.

The strategic framing that produced this plan: the kernel is a
**legibility substrate for agentic work** — capture invariants,
failure-mode discipline, wire-format separation, identity-model
clarity. Agent supervision is a consumer of that substrate, not its
purpose. Every sharp edge in Part 1 either erodes a capture invariant
or makes the substrate harder to reason about. Every slice in Part 2
extends the substrate's reach (embeddable via Python, deployable via
MCP, extensible via a plug-in contract) without changing what makes
it the substrate.

## §2. Goals and non-goals

### Goals

- Every sharp edge in §3 is either fixed, deferred with reason, or
  cross-referenced to another plan that owns it.
- The kernel's public embedding surface (`from llm_kernel import
  Kernel`) becomes usable — the facade extraction in
  [PLAN-kernel-facade.md](PLAN-kernel-facade.md) lands.
- The external MCP transport ships — kernel becomes durably reachable
  as an MCP server for non-extension clients (external agents,
  scripts, other kernels).
- The extension contract lands — plug-in coordination models (PBX
  the worked example) can ship without core kernel changes.

### Non-goals

- **No new feature work**. This plan is hygiene + previously-scoped
  trajectory. New agent-side capabilities, new UI, new wire families
  are out of scope.
- **No V2 UX work**. The V2 lane (branch-switching UX,
  output-kind lens) is UI-side and lives under BSP-005 §6.6 /
  [ROADMAP.md](ROADMAP.md).
- **No changes to the RFC-006 v2 wire format**. Extensions add tools;
  extensions do not change envelopes.
- **No changes to RFC-002 canonical system prompt template major
  version**. Minor bump acceptable (adding a tool bullet); major
  version stays at 1.

## §3. The dispatch table — sharp edges

Each row: severity, file:line, one-line fix, verification. Sorted by
recommended priority (highest first).

| # | Severity | File / anchor | Description | Fix | Verification |
|---|---|---|---|---|---|
| SE-01 | High | [agent_supervisor.py:639, 770-773](../../vendor/LLMKernel/llm_kernel/agent_supervisor.py) | `send_user_turn` takes `self._lock` only to resolve the handle; the stdin write block runs unlocked. Under any concurrent caller (extensions, external MCP, future PBX) two writers to the same handle interleave lines. | Add `_stdin_lock: threading.Lock` to `AgentHandle`; extract `_write_user_turn_locked(handle, lines)`; refactor the write block to use it. Behavior-preserving. | `test_send_user_turn_concurrent_no_interleave` — two threads dial the same target with distinct bodies; assert stdin contents split cleanly. |
| SE-02 | High | [_provisioning.py:84-86](../../vendor/LLMKernel/llm_kernel/_provisioning.py) | `emit_magic_cell` is in `TOOL_CATALOG` and `NATIVE_TOOLS` ([wire/tools.py:251-282](../../vendor/LLMKernel/llm_kernel/wire/tools.py)) and in `RFC001_ALLOWED_TOOLS` (L38-43), but **absent from the rendered system prompt bullet list**. Agents literally cannot see a tool they are allowed to call. | Add a bullet under `run_command` describing `emit_magic_cell`. Bump `EXPECTED_SYSTEM_PROMPT_TEMPLATE_VERSION` from `"1.0.0"` → `"1.0.1"` (patch — silent). Update marker comment at L104. | `test_system_prompt_includes_emit_magic_cell` — assert substring present in rendered prompt. Extend existing template-version test to accept 1.0.1. |
| SE-03 | Med | [agent_supervisor.py:695-771](../../vendor/LLMKernel/llm_kernel/agent_supervisor.py) | `_synthesize_handoff_prefix` unconditionally injects notebook-DAG turns before every operator message. Correct for the operator path; wrong for any non-notebook caller (PBX, external MCP, library-embedded use). Design implicitly assumes "only operators drive turns" — an assumption already breaking under the trajectory. | Add `inject_notebook_prefix: bool = True` keyword to `send_user_turn` at L592. When `False`, skip the `_missed_turns` walk and don't advance `handle.last_seen_turn_id`. Default preserves backward-compat. | `test_send_user_turn_no_notebook_prefix_skips_handoff_walk` — assert prefix machinery not invoked under the flag and `last_seen_turn_id` unchanged. |
| SE-04 | Med | [agent_supervisor.py:645-693](../../vendor/LLMKernel/llm_kernel/agent_supervisor.py) | The resume-if-target-reaped block is inlined in `send_user_turn`. Any second writer path (PBX handler, library caller) needs the same logic; today it would copy-paste. | Extract `_resume_if_needed(handle, agent_id, fresh_task_text) -> Tuple[AgentHandle, str]`. Both `send_user_turn` and any future writer call through it. Behavior-preserving. | Existing 60 supervisor tests plus one call-site test asserting the extracted helper is idempotent when the handle is already live. |
| SE-05 | Med | [metadata_writer.py](../../vendor/LLMKernel/llm_kernel/metadata_writer.py) event log | The event log queue is capped at 10k with drop-oldest-on-overflow. Operators have no runtime visibility into how full it gets — first sign of overflow is missing envelopes downstream. | Expose `MetadataWriter.queue_depth()` and `drop_count()`. Include both fields in the Family-G heartbeat envelope. | `test_heartbeat_includes_queue_depth_and_drop_count` — spawn writer, saturate queue past threshold, assert heartbeat reports non-zero drop. |
| SE-06 | Med | `docs/04 - Reference/kernel/` (missing file) | The kernel has ~10 identifier types (`agent_id`, `zone_id`, `executor_id`, `trace_id`, `run_id`, `cell_id`, `turn_id`, `manifest_id`, `claude_session_id`, `correlation_id`) with no single reference doc. Cognitive tax on any new contributor. | Write `docs/04 - Reference/kernel/identity-model.md`: per-identifier definition, scope, lifecycle, where each appears in code + RFCs, relationship diagram. Note `executor_id` is forward-declared and always equals `agent_id` today. | Manual review; each identifier's entry cross-links to a canonical code site + RFC anchor. |
| SE-07 | Med | `docs/04 - Reference/kernel/` (missing file) | The substrate's load-bearing capture properties (every-byte-resets-watchdog, malformed-lines-as-spans, tape+spans, no-silent-drops, K-class taxonomy) are documented across many places but nowhere as a single "what to defend" charter. Contributors modifying the kernel need to know which properties are load-bearing. | Write `docs/04 - Reference/kernel/capture-invariants.md`. Every property with a file:line anchor. Explicit "if you touch X, do NOT break Y." | Manual review; every property cross-links to the code site enforcing it. |
| SE-08 | Med | [RunFrame schema (BSP-008)](../03%20-%20Blueprint/BSP-008-contextpacker-runframes.md) + `executor_id` field | `executor_id` is defined on RunFrames but always equals `agent_id` in practice. Field mislead future readers about what is polymorphic. Either commit to polymorphism (slice ties to PLAN-kernel-facade) or remove the field. | Deferred: this is downstream of the facade extraction. Recommendation: keep the field, document as "always equals `agent_id` until executor abstraction lands" in the identity-model doc (SE-06). Do not remove — polymorphism is the eventual target. | Covered by SE-06. |
| SE-09 | Low | [mcp_server.py:186](../../vendor/LLMKernel/llm_kernel/mcp_server.py) `_handlers` dict + [custom_messages.py](../../vendor/LLMKernel/llm_kernel/custom_messages.py) `register_handler` | The dispatcher registers handlers per message type — event routing, not addressed dispatch. My earlier "kernel is microkernel-shaped already" claim is optimistic; there is real distance to a documented bus contract with service identity and capability discovery. | Deferred: not touched by any Part 2 slice. Bus formalization only lands when a second in-kernel routing concern beyond the current envelope routing emerges (see §5 deferred items). | Not verified in this plan. |
| SE-10 | Low | [mcp_manager.py:16](../../vendor/LLMKernel/llm_kernel/mcp_manager.py) vs [mcp_server.py:36](../../vendor/LLMKernel/llm_kernel/mcp_server.py) | Client uses `fastmcp.Client`; server uses the lower-level official `mcp.server.Server`. Mixed conventions in adjacent modules. | Deferred: convergence to FastMCP everywhere is a cleanup that should ride on a separate slice when someone is next deep in `mcp_server.py`. External MCP transport (slice B) will add a FastMCP server; convergence follows opportunistically. | Not verified in this plan. |
| SE-11 | Low | [docs/04 - Reference/kernel/README.md](../04%20-%20Reference/kernel/README.md) Planning-artifacts section | The Planning-artifacts table there links to `PLAN-kernel-facade.md` at the folder-local path — but after the doc reorg the file lives at [`docs/06 - Roadmaps/PLAN-kernel-facade.md`](PLAN-kernel-facade.md). Broken link. | Fix the link to reference the Roadmaps location. Consider whether Planning-artifacts should be a section in the kernel README at all (all PLAN files now live in `06 - Roadmaps/`). | Manual click-through in an IDE preview. |
| SE-12 | Low | [_provisioning.py:59-104](../../vendor/LLMKernel/llm_kernel/_provisioning.py) `CANONICAL_SYSTEM_PROMPT_TEMPLATE` | The system prompt aggressively suppresses free-form text (DR-0010) — necessary given the MCP-only surface, but tight. A `reflect(note, importance)` or `note(observation, importance)` tool that captures intentional prose without flooding the operator could be a release valve for pattern violations. | Deferred: design work. Not blocking. Track as an RFC-001 v1.2 candidate. | N/A. |

**Priority legend**: **High** = ships broken behavior or blocks any future writer path. **Med** = quality-of-life or new-slice-blocker. **Low** = polish or deferred design.

## §4. The dispatch table — substrate trajectory

Post-V1 kernel work extending the substrate's reach. Each slice is
separately reviewable and leaves the kernel in a shipping state.

| Slice | Description | Owner | Detail | Status |
|---|---|---|---|---|
| **A** | **Kernel facade** — extract subsystem wiring from `app.py` lifespan + `__main__.py` subcommands into a public `Kernel` class. Unlocks `from llm_kernel import Kernel` embedding, library-level testing, transport-plug-in architecture. | K-KF | [PLAN-kernel-facade.md](PLAN-kernel-facade.md) — 10-commit decomposition, ~250 LOC facade, existing subsystems reused. Async-first public API, threadsafety contract, event-loop ownership rules. | Not started. Prerequisite for B and C. |
| **B** | **External MCP transport** — bind a FastMCP-based streamable-HTTP transport to the facade. Kernel becomes durably reachable by non-extension clients. Bearer-token auth, session resumption via `Mcp-Session-Id`, `kernel://session_summary` resource. Three surfaces coexist in one process: internal stdio MCP (agents), kernel-host PTY+socket (extension), external HTTP MCP (any client). | K-MCP | Sketched in the substrate trajectory (Claude Code planning artifact at `~/.claude/plans/let-s-sketch-this-out-deep-peacock.md`). No slice PLAN yet — write one when starting. | Not started. Depends on A. |
| **C** | **Extension protocol + PBX as first extension** — formalize `Extension.register(kernel)` (tool_catalog, system_prompt append, config_loaders, magics). PBX ships as the worked example: `dial` / `answer_call` MCP tools, telephone envelope convention, `.pbx/config.json`, `%llm_pbx_*` magics. Extensions land features without touching core kernel. | K-EXT | Sketched in the substrate trajectory. No slice PLAN yet. | Not started. Depends on A and (optionally) B. |
| **D** | **Documentation deliverables** across A/B/C — `docs/04 - Reference/kernel/architecture.md` (A), `embedding.md` (A), `deployment.md` (B), `external-mcp-reference.md` (B), `extensions.md` (C), `pbx.md` (C). Doc slots already reserved in [`kernel/README.md`](../04%20-%20Reference/kernel/README.md). | K-Docs | Per-slice — each slice includes its `docs(kernel)` commit. | Docs stubs written; content lands with each slice. |

## §5. Deferred beyond this plan

Items surfaced in the design conversation that are explicitly not in
scope here:

- **Executor abstraction + IPython sibling executor.** Wait for
  concrete evidence of polyglot pressure inside a single kernel
  process. Federation via external MCP (slice B) may cover the use
  case entirely — cross-kernel calls are just MCP-client-to-MCP-server.
- **Kernel-bus formalization** (microkernel discipline). The
  dispatcher is proto-bus-shaped today (SE-09). Promote to a
  first-class bus only when a second in-process routing concern
  beyond envelope routing emerges. Speculative refactors here have
  a well-known failure mode ("microkernel that never ships").
- **Cross-kernel federation / trunks.** Falls out trivially from
  slice B (one kernel's external MCP client connects to another
  kernel's external MCP server). No first-class trunk abstraction
  needed yet.
- **`reflect` / `note` release-valve tool** (SE-12). Design work;
  candidate for RFC-001 v1.2 when there is evidence of pattern
  violation cost.
- **FastMCP convergence** on the internal stdio bridge (SE-10).
  Opportunistic cleanup. Not blocking any slice.

## §6. Recommended sequencing

Suggested commit order — each keeps the codebase in a shipping state.

**Phase 1 — Hygiene sweep (SE-01 through SE-07).** No slice
dependency, ships behavior-preserving improvements. ~1 week.

1. `refactor(supervisor): per-handle stdin write lock` (SE-01).
2. `fix(provisioning): include emit_magic_cell in system prompt;
   template v1.0.1` (SE-02).
3. `refactor(supervisor): factor _resume_if_needed; add
   inject_notebook_prefix flag` (SE-03 + SE-04).
4. `feat(metadata): queue depth + drop count on Family-G heartbeat`
   (SE-05).
5. `docs(kernel): identity-model.md` (SE-06).
6. `docs(kernel): capture-invariants.md` (SE-07).
7. `docs(kernel): fix stale PLAN-kernel-facade.md link in README`
   (SE-11).

**Phase 2 — Facade extraction (slice A).** Follow the 10-commit
decomposition in [PLAN-kernel-facade.md](PLAN-kernel-facade.md) §Commit
decomposition. Depends on Phase 1 SE-01, SE-03, SE-04 (the facade
public methods rely on the write lock and the notebook-prefix flag).
~1-2 weeks.

**Phase 3 — External MCP transport (slice B).** Write a dedicated
`PLAN-external-mcp-transport.md` at start of the phase — the sketch
in the substrate trajectory is not detailed enough. Depends on
Phase 2. ~1-2 weeks.

**Phase 4 — Extension protocol + PBX (slice C).** Write a
`PLAN-extensions-and-pbx.md` at start of the phase. Depends on
Phase 2 (and optionally Phase 3 — PBX is meaningful whether or not
the external MCP surface exists, but external clients only see PBX
tools if slice B is live). ~1-2 weeks.

## §7. Test surface

Kernel test suite baseline: **908 tests green** as of `127a034`.

Phase 1 additions (~6-8 new tests):
- `test_send_user_turn_concurrent_no_interleave` (SE-01)
- `test_system_prompt_includes_emit_magic_cell` (SE-02)
- `test_send_user_turn_no_notebook_prefix_skips_handoff_walk`
  (SE-03)
- `test_heartbeat_includes_queue_depth_and_drop_count` (SE-05)

Existing 908 tests must stay green throughout every hygiene commit.

Phases 2-4 test surfaces are documented in their respective plans.

Verification command per commit:
```powershell
pixi run -e kernel python -m pytest vendor/LLMKernel/tests/ -x -q
```

Smoke tests must keep passing:
```powershell
pixi run -e kernel python -m llm_kernel pty-mode-smoke
pixi run -e kernel python -m llm_kernel agent-supervisor-smoke
pixi run -e kernel python -m llm_kernel metadata-writer-smoke
```

## §8. Cross-references

- [PLAN-kernel-facade.md](PLAN-kernel-facade.md) — slice A detail
  (facade extraction), the load-bearing plan for Phase 2.
- [PLAN-v1-roadmap.md](PLAN-v1-roadmap.md) — the V1 ship-ready
  checklist; row 13 (substrate gaps) and row 14 (atom drift) both
  closed 2026-06-30.
- [PLAN-substrate-gap-closure.md](PLAN-substrate-gap-closure.md) —
  the different-category work that closed row 13 (feature
  completeness, not hygiene).
- [PLAN-atom-hygiene.md](PLAN-atom-hygiene.md) — the different-
  category work that closed row 14 (atom-corpus consistency, not
  code hygiene).
- [`docs/04 - Reference/kernel/README.md`](../04%20-%20Reference/kernel/README.md)
  — the kernel-substrate doc index (SE-06 and SE-07 land there).
- [`ROADMAP.md`](ROADMAP.md) — the V2 strategic
  queue.

## §9. Definition of done

**Phase 1 done when:**
- SE-01 through SE-07 land as separate commits (SE-08 through SE-12
  either deferred with reason or fixed opportunistically).
- Kernel test suite ≥ 914/914 green (908 baseline + ~6 new tests).
- All four smoke tests green.
- [`docs/04 - Reference/kernel/README.md`](../04%20-%20Reference/kernel/README.md)
  "Files in this folder" table marks `identity-model.md` and
  `capture-invariants.md` as **Present** (not **Planned**).

**Overall plan done when:**
- Phases 1-4 land.
- The kernel is importable as `from llm_kernel import Kernel` and
  documented at [`docs/04 - Reference/kernel/embedding.md`](../04%20-%20Reference/kernel/embedding.md).
- The kernel runs as an external MCP server via `kernel-serve-mcp`
  and is documented at [`docs/04 - Reference/kernel/deployment.md`](../04%20-%20Reference/kernel/deployment.md).
- PBX (or another concrete extension) ships end-to-end via the
  extension contract, proving the substrate can accept coordination
  models without core changes.
- Every planned file in [`kernel/README.md`](../04%20-%20Reference/kernel/README.md)
  is marked **Present**.
- No new sharp edges surfaced during the trajectory are left un-
  triaged (either fixed, deferred with reason, or cross-referenced
  to a follow-up plan).
