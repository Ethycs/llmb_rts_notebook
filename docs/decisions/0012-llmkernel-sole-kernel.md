# 0012. LLMKernel hardcoded as sole kernel; no kernel discovery

- **Status:** Accepted
- **Date:** 2026-04-26
- **Tag:** SCOPE-CUT

## Context

Standard Jupyter notebook UIs assume kernel pluralism: a notebook can be backed by Python, Julia, R, .NET Interactive, or any kernel that registers a kernelspec. Supporting that pluralism costs real machinery: kernelspec discovery on disk, environment scanning via the Python extension, remote Jupyter URI providers, a kernel-picker UI, persistence of the chosen kernel per notebook, and reconciliation logic when the chosen kernel is no longer available. In `microsoft/vscode-jupyter` this code is threaded across `src/kernels/`, the Python extension API surface, the URI provider system, and several UI flows.

V1 has exactly one possible execution target: LLMKernel. There is no second kernel, and the V1 scope (DR-0005) does not introduce one. A picker that shows one option is friction without information. Discovery code that scans for absent Python interpreters and remote servers is dead code that runs on every notebook open. Selection logic that resolves between competing kernels is a state machine for a system with one state.

Reducing kernel discovery rather than removing it would still leave the dependencies, the initialization timing, and the error states of the discovery subsystem in place. Cutting it entirely is cleaner than reducing it.

## Decision

**Hardcode LLMKernel as the sole execution target. No kernelspec lookup, no kernel-selection ceremony, no Python-extension dependency.**

The fork registers a single `NotebookController` for the `.llmnb` file type with LLMKernel as its only kernel. When a `.llmnb` file opens, LLMKernel is wired in by default; cells dispatch to it without ceremony. The status bar surfaces kernel state (idle, busy, dead) but no picker. The command palette has no "Select Kernel" or "Change Kernel" entry for `.llmnb` documents. There is no kernelspec on disk to discover, no environment to scan, no remote URI to resolve.

This decision compounds with DR-0009 and DR-0011. DR-0009 said "keep cell semantics, drop the kernel-protocol bridge for Python expectations." DR-0011 said "delete the discovery, picker, and Python-integration code from the fork." DR-0012 says "and inside that frame, the one kernel is hardwired." All three cut machinery; they cut different machinery for different reasons.

## Consequences

- **Positive: opening an `.llmnb` file is ready for input.** No kernel-picker step, no "Select Kernel" prompt, no waiting for environment scans to complete.
- **Positive: zero Python-extension coupling.** The fork has no runtime dependency on `ms-python.python`. Install footprint is smaller; activation is faster; cross-extension API churn does not affect V1.
- **Positive: dead-code elimination is total.** Discovery, selection, kernelspec installation, and kernel-mismatch UI are not just disabled — they are removed. Cannot regress; cannot leak through edge cases.
- **Positive: status-bar and palette UX are crisp.** No menu entries that exist only to be ignored. The operator's mental model of "what kernel is this" collapses to "the one."
- **Negative: cannot host a second kernel without reintroducing selection.** If V2 ever ships a second execution target (a sandboxed Python tool runner, a remote LLMKernel variant), kernel selection has to be re-architected, not toggled. This is acceptable because no second kernel is on the V1 or V1.5 roadmap.
- **Negative: outside the standard Jupyter ecosystem.** No JupyterLab interop, no kernelspec sharing, no "open this notebook against my kernel of choice" workflow. Acceptable because `.llmnb` is a conversation file, not a generic notebook.
- **Negative: the controller's pluralism affordance is inert.** `NotebookController` natively supports multiple controllers per file type; V1 leaves that capability unused. This is a feature of the API, not a cost.
- **Follow-ups:**
  - DR-0013 confirms this scope cut is part of what makes V1 feasible on a 5–6 week calendar.
  - DR-0014 pins the `.llmnb` storage shape, including the metadata namespace LLMKernel writes.
  - Chapter 08 covers the mediator role of LLMKernel as the unifying point for MCP, kernel-protocol messages, and file-format writes.

## Alternatives considered

- **Support multiple kernels behind the existing picker.** Rejected — there is no second kernel in V1 scope, and the picker's machinery is non-trivial. Building optionality for an absent option is pure cost.
- **Proxy to a real Jupyter kernel that wraps an LLM.** Rejected — this is the protocol-bridge complexity DR-0009 already cut. Two protocols (Jupyter messaging on one side, MCP on the other), two state models, glue between them, plus the Python-expectation collision the bridge invariably surfaces in the UI.
- **Reduce discovery to "look for LLMKernel only" but keep the framework.** Rejected — the framework's value is pluralism. Stripped of pluralism, the framework is overhead. Hardcoding is cleaner than a one-element discovery loop.
- **Hide the kernel picker via UI configuration but leave the code paths in place.** Rejected — dead code that runs on every open is a maintenance liability and an initialization-timing risk. Removing the code is cheaper than guarding it.

## Source

- **Source merged turn(s):** 083 (in phase 07)
- **Raw sub-turns:**
  - [turn-091-user.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-091-user.md) — "Let the LLMKernel be the sole kernel." Operator's directive that frames the scope cut.
  - [turn-092-assistant.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-092-assistant.md) — kernel-discovery and kernel-selection enumerated as cuts; rationale for full removal vs. reduction.
  - [turn-097-user.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-097-user.md) — embed-in-ipynb-and-rename-llmnb directive that locks the single-controller / single-kernel registration to the `.llmnb` file type.
- **Dev guide:** [chapter 07](../dev-guide/07-subtractive-fork-and-storage.md)
