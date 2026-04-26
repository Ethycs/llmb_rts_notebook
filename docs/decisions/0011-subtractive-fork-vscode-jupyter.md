# 0011. Subtractive fork of vscode-jupyter

- **Status:** Accepted
- **Date:** 2026-04-26
- **Tag:** LOCK-IN

## Context

DR-0009 commits V1 to VS Code's `NotebookController` API: cells stay, the Jupyter kernel goes. That decision leaves an implementation question — where does the surrounding notebook UI come from? Building a notebook editor from scratch is months of work duplicating problems that vscode-jupyter has already solved over a decade: the cell editor, MIME-typed output rendering, document persistence to JSON, multi-cell selection, keybindings, diff support, and the `NotebookController` integration surface itself. None of that work is V1's actual differentiator.

Using vscode-jupyter as-is is not viable either. Most of its surface area is Python-shaped: kernel discovery and selection across kernelspecs, conda envs, and remote Jupyter URI providers; coordination with the `ms-python.python` extension; the IPyWidgets bridge; the Variable, Data, and Plot Viewers; the Interactive Window; notebook debugging; nbconvert exports to HTML/PDF/Python; the web-worker target. None of these subsystems serve LLMKernel-as-sole-kernel, and each one carries dependencies, initialization timing concerns, error states, and upstream churn. Keeping them is permanent cost for zero V1 benefit.

The fork direction is therefore subtractive rather than additive: start from vscode-jupyter, delete what does not apply, keep what does. The cuts are the substance of the architectural decision, not a side effect of it.

## Decision

**Fork `microsoft/vscode-jupyter` and execute a subtractive cut against a defined target.**

Cut entirely:

- Python environment management (interpreter selection, ipykernel installation, the Python-extension dependency).
- Kernel discovery and selection (kernelspecs, environment scanning, remote Jupyter URI providers, the kernel-picker UI).
- Remote Jupyter server support.
- IPyWidgets and the widget bridge.
- The Interactive Window and "send to interactive" workflows.
- Variable Viewer, Data Viewer, Plot Viewer.
- Notebook debugging (run-by-line, cell-level debugging).
- Most non-Markdown export paths (HTML, PDF, Python script export via nbconvert).
- The web environment (`*.web.ts` and the entire web-worker target).
- IntelliSense / language services for notebook cells.
- Conda activation, kernelspec installation, Python troubleshooting commands.

Keep, with modifications where needed:

- The notebook editor itself: cell creation, editing, output rendering, document model, JSON persistence.
- The kernel-protocol message machinery as the wire format LLMKernel speaks back to the editor.
- The MIME-type renderer extension API surface — the substrate the LangSmith-shaped run renderer plugs into.
- Webview infrastructure (used by the map view).
- The `NotebookController` API surface: one controller, one kernel, no selection.
- The `.ipynb` JSON serialization path, reused with `metadata.rts` extensions for the `.llmnb` file shape.
- Notebook diff support.

Target outcome: a fork roughly 30–40% the size of the original by line count, with a focused identity as a lean notebook editor for LLM-agent transcripts.

## Consequences

- **Positive: every surviving line earns its place.** The fork has a clearer thesis and a leaner maintenance profile than the original. Less to track upstream because cut subsystems cannot break; smaller surface for VS Code API churn.
- **Positive: V1 inherits a battle-tested cell editor.** Mixed MIME output, streaming, multi-cell selection, persistence, and diff support arrive working on day one.
- **Positive: cuts compose with DR-0009 and DR-0012.** No protocol bridge (DR-0009), no kernel discovery (DR-0012), and now no Python integration to maintain.
- **Negative: reduced reversibility.** Re-adding a cut subsystem later is real work, not a configuration toggle.
- **Negative: upstream contribution becomes one-directional.** The fork is too divergent to send PRs back. Selective cherry-picking of upstream bug fixes in kept subsystems is an ongoing tax of a few hours per month.
- **Negative: identity confusion risk.** Operators who try to use the fork as a generic Jupyter alternative will be disappointed. Naming (`.llmnb`, distinct extension marketplace identity) and documentation must make this explicit.
- **Follow-ups:**
  - DR-0012 hardcodes LLMKernel as the sole kernel inside the surviving frame.
  - DR-0013 confirms V1 is shippable on a 5–6 week calendar with this scope.
  - DR-0014 pins the `.llmnb` storage shape on top of the surviving `.ipynb` serialization path.
  - Ongoing fork-merge maintenance burden (cherry-pick policy, upstream-tracking cadence) is owned by the team.

## Alternatives considered

- **Build the notebook UI from scratch.** Rejected — months of effort to rebuild what already exists in working form: cell editor, MIME rendering, persistence, diffs, keybindings. The differentiator is the chat-over-MCP surface and the map view, not the cell editor.
- **Use vscode-jupyter as-is, layer LLMKernel on top.** Rejected — bakes Python expectations and kernel-selection ceremony into the operator surface. Every opened file would surface a kernel picker for one option; the Python extension would remain a hard dependency; IPyWidgets and the data-science viewers would ship dead code on every install.
- **Additive fork: keep everything, add LLMKernel paths alongside.** Rejected — additive forks bloat. The original codebase plus new code, with both fighting for attention and the maintenance liability compounding. Subtraction produces a smaller, clearer artifact.
- **Use a different notebook substrate (Jupyter Lab, Polyglot Notebooks, Observable).** Rejected — none ship inside VS Code as the host (DR-0007), and reproducing VS Code's ambient development affordances around them defeats the host choice.

## Source

- **Source merged turn(s):** 079, 080 (in phase 07)
- **Raw sub-turns:**
  - [turn-091-user.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-091-user.md) — operator's subtractive directive: "take away everything we don't need," LLMKernel as sole kernel, repurpose MIME types, map as a tab.
  - [turn-092-assistant.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-092-assistant.md) — full enumeration of the cut list and the kept surface; the substance of the architectural decision.
  - [turn-094-assistant.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-094-assistant.md) — continuation: storage shape that the surviving editor must serialize.
- **Dev guide:** [chapter 07](../dev-guide/07-subtractive-fork-and-storage.md)
