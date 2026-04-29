# Discipline: Sub-agent dispatch pattern

**Status**: discipline (coordinator methodology, not artifact spec)
**Source specs**: [Engineering_Guide.md](../../../Engineering_Guide.md) (multi-agent rounds, parallel-test discipline), [PLAN-atom-refactor.md §6](../../notebook/PLAN-atom-refactor.md) (fan-out template), [PLAN-v1-roadmap.md](../../notebook/PLAN-v1-roadmap.md) (multi-round campaign structure)
**Related atoms**: [zachtronics](zachtronics.md) (visible-tile principle), [save-is-git-style](save-is-git-style.md) (commit-disciplined work units)

## What this atom captures

How a coordinator LLM (or human operator playing the same role) dispatches **sub-agents** to do work in parallel, and the patterns that survived contact with the project. Not about the agents *inside* the notebook ([concepts/agent](../concepts/agent.md)) — those are claude-code instances bound to cells. This is about the meta-layer: who builds the kernel + extension by farming work to specialized sub-agents.

The Claude Agent tool exposes `subagent_type` + `prompt` + optional `isolation: worktree` + `run_in_background`. This atom names the roles, dispatch patterns, briefing template, and failure-recovery moves we've evolved.

## Sub-agent roles

| Role | Scope | Typical brief |
|---|---|---|
| **Plan-author** | doc-only, `docs/notebook/PLAN-*.md` | Write 1–N self-contained plan docs that future implementation agents (or operators) consume as briefs |
| **Slice-implementation** | code (cross-layer or single-layer) + tests | Implement a BSP-005 slice end-to-end; commit on a wip branch; report counts |
| **Atom-hygiene** | doc-only, `docs/atoms/` | Update Status fields, pin inventions, fold drift; create new atoms; run drift detector |
| **Test-coverage** | tests-only | Write tests for already-shipped production code (often follows a slice agent that errored mid-run) |
| **Verification** | bash-heavy, output-focused | Run preflight tests, smoke suites, drift detectors; report counts |
| **Investigation** | read-only research | Open-ended "where is X" / "how does Y work" — use `subagent_type: Explore` |

## Dispatch patterns

| Pattern | When to use | Tradeoffs |
|---|---|---|
| **Single end-to-end** | Slice is naturally one feature; cross-layer cohesion matters; brief is well-scoped (<3h of work) | Single point of failure mid-run; one report to integrate |
| **File-disjoint pair** | Two slices touching different layers; minimal coordination via locked-in interface contracts | 2× wall-clock parallelism; verify file-disjointness or accept worktree isolation |
| **Mega-round fan-out (3–7 parallel)** | Multiple file-disjoint slices ready at once | Highest parallelism; submodule branch races (kernel agents must serialize); merge complexity at the gate |
| **Serial kernel queue** | Multiple slices touching the same submodule (`vendor/LLMKernel/`) | Slowest reliable path; required because submodule HEAD is shared across worktrees |
| **Worktree-isolated agents** | Extension slices safe to fork repo state | Stale worktrees occasionally surface; verify with `git branch` post-completion |
| **Test-only follow-up** | Production code shipped without test coverage (typically because the slice agent errored mid-run) | Small (~0.5d), low-risk; closes coverage gap |

## Briefing template (evolved)

Each agent brief includes (in this order, ≤500 words):

1. **Context** — one paragraph; what slice this is, what state the tree is in, what depends on it.
2. **Read first (priority-ordered)** — atoms + specs + relevant source files. Atoms before specs; specs before code.
3. **Concrete work** — numbered list, file-targeted. "NEW `path/to/file.py` (~N LoC) — function signature".
4. **Interface contracts** (cross-module slices only) — locked function signatures + wire envelope shapes that other modules code against.
5. **Test surface** — specific test names, file paths, expected count delta.
6. **Constraints** — forbidden zones (paths the agent must not touch). `isolation: worktree` declaration if used. Submodule-branch hygiene if relevant.
7. **Pre-flight + post-flight** — test count baseline + expected target.
8. **Commit discipline** — submodule branch name, outer branch, commit-message style.
9. **Report format** — ≤200–350 words; specific fields (files touched + LoC, tests added, atom flags, drift items, inventions, branch SHAs).

The "report format" rule is critical: it caps the integration cost. Long agent reports balloon the coordinator's context. Capped reports can be assimilated into one cycle.

## Locked-in interface contracts (fan-out support)

When dispatching N file-disjoint agents whose work composes (e.g., extension calls kernel via wire envelope), the coordinator pre-locks the cross-module signatures in a §"Interface contracts" section in EVERY brief. Each agent codes to the agreed shape; integration falls out at verification time.

This is the discipline that makes mega-round fan-out tractable: **no in-flight coordination required**. If contracts are well-locked, agents return self-consistent commits.

## Failure modes encountered (logged)

| Mode | Symptom | Recovery |
|---|---|---|
| **API/network error mid-run** | Agent terminates with partial work; some commits may have landed; worktree may be in inconsistent state | Check `git worktree list` + branch SHAs; salvage tracked work; re-dispatch with same brief if scope is recoverable, OR split into smaller agents if hitting a length wall |
| **Submodule branch race** | Two parallel kernel agents step on each other's submodule HEAD | Serialize kernel agents going forward; merge between |
| **Stale worktree state** | `git worktree list` shows old commit; agent appears to have not committed | Verify by `git branch` and `git log` on the candidate branch; the agent may have committed but the worktree display lags |
| **Mid-run brief amendment is unsafe** | Operator wants to add a spec change after agent dispatched | Don't try to redirect; queue as follow-up doc / next agent |
| **Stale audit cited in brief** | Agent finds the production code already implements the gap (audit was written before recent kernel work) | Agent ships test-only PR; coordinator updates the inventory in the next plan iteration |
| **Worktree wrote to main anyway** | Agent's `isolation: worktree` was set but changes appeared in main working tree | Acknowledge state, integrate using `git status` + topical commits per agent |

## When to dispatch vs do it yourself

| Task size | Approach |
|---|---|
| <50 LoC, single file, mechanical (e.g., a one-line fix + test assertion) | Direct edit (Edit/Write) |
| 50–200 LoC, single file, judgment-required | Direct edit + verify with test run |
| 200+ LoC, multi-file, single layer | Single agent (slice-implementation) |
| Cross-layer slice | Single agent end-to-end OR file-disjoint pair |
| 3+ independent slices | Mega-round fan-out (with kernel-serialization constraint) |
| Open-ended "where is X" or "explain Y" | Explore subagent_type, read-only |

The boundary at ~50–200 LoC is where the coordinator-vs-delegate tradeoff inverts. Below: own the work, see every line. Above: brief well, trust the report, verify by tests.

## Anti-patterns (avoid)

| Anti-shape | Why it's wrong |
|---|---|
| Dispatching a slice agent without locked-in interface contracts in a fan-out | Two agents will pick incompatible shapes; merge cost spikes; the V1 plan's mega-round only worked because contracts were pre-fixed |
| Modifying a brief after the agent is dispatched | Can't propagate; agent works against stale spec; queue a follow-up instead |
| Dispatching parallel kernel agents to different submodule branches | Submodule HEAD is shared across outer worktrees; the second agent's branch checkout overrides the first's |
| Long-running agent (50+ tool uses) with no checkpoint | API errors mid-run lose all work; split into smaller agents (single agent should land in <40 tool uses ideally) |
| Trusting `git worktree list` SHA without verifying the branch | Display lag; cross-check with `git branch -v` |
| Reading agent task-output JSONL files via shell tools | The output is a full transcript; reading explodes coordinator context. Wait for the notification; trust the report; verify via tests |

## See also

- [discipline/zachtronics](zachtronics.md) — visible tiles principle (applies to agent briefs too: every constraint visible in the brief, no hidden expectations)
- [discipline/save-is-git-style](save-is-git-style.md) — agent commits are atomic + reversible per the same discipline
- [Engineering_Guide.md §8](../../../Engineering_Guide.md) — multi-agent rounds (broader project methodology)
- [PLAN-atom-refactor.md §6](../../notebook/PLAN-atom-refactor.md) — the original fan-out template that evolved into this pattern
