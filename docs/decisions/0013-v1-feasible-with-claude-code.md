# 0013. V1 scope confirmed feasible with Claude Code as collaborator

- **Status:** Accepted
- **Date:** 2026-04-26
- **Tag:** LOCK-IN

## Context

After the V1 scope cut (DR-0005) and the substrate decisions that followed (DR-0007 vscode-as-host, DR-0008 bidirectional MCP, DR-0009 NotebookController without Jupyter kernel, DR-0010 forced tool use, DR-0011 subtractive fork, DR-0012 LLMKernel as sole kernel), the architecture had stabilized into a concrete, finite build. What had not yet been answered was the practical question hanging over all of it: is this actually buildable in the time available, by this team, with Claude Code as the implementing collaborator?

A vague "we will figure it out as we go" is not an acceptable answer at lock-in time. Either the work fits inside a credible calendar window — with the scope cuts that have already been made — or the cuts were not deep enough and another pass is needed before any code is written. The forcing question was sharp: a serious V1, not a toy demo, with the fork executed, LLMKernel integrated, the advanced chat UI built, and the RTS map view functional, on a calendar that the operator can commit to.

The implementing context is also specific. Claude Code is the day-to-day coding collaborator with hands-on architectural oversight at decision points; it is not autonomous, and the operator is not coding solo. Both extremes have known failure modes: pure solo takes 2-3 times longer at the same quality bar, while unsupervised Claude Code lands at roughly 60-70% with rough edges and architectural drift that costs more to fix than to prevent. The honest assessment must reflect the actual collaboration mode.

## Decision

V1 is deliverable as a serious release on a calendar window of roughly five to six weeks with Claude Code as the implementing collaborator and the operator providing architectural oversight at decision points.

What "serious V1" includes:

- Subtractive fork of vscode-jupyter executed against the cut list locked in DR-0011, producing a clean, reduced codebase.
- Integration with the existing LLMKernel codebase: kernel start, cell execution, message round-trip.
- LangSmith-shaped JSON I/O with a single MIME renderer for `application/vnd.rts.run+json` that dispatches internally on `run_type`.
- The RTS map view as a webview panel with state synchronization to the kernel.
- Sidebar Activity Bar contributions (zones tree, agents tree, recent activity).
- Single-file `.llmnb` format with the three embedded structures from DR-0014.
- Inline permission approvals with diff preview, streaming with auto-scroll and interrupt, edit-and-resend with branching by file copy.
- The three-pane mental model (stream / current / artifacts) from chapter 06.

What is explicitly out of V1:

- Production polish at scale. Files over a few megabytes, sessions running over days, conversations with thousands of cells: V1 handles these correctly but not optimally.
- The full RFC tool taxonomy. Tool standards work is deferred to chapter 08 and DR-0016.
- A complete fault-injection test harness. The foundation (doc-driven contract tests, mock kernel, basic property assertions) lands; the full Markov simulation and chaos suite parallelize and may not all land.
- Cross-notebook coordination, time-travel for layout, map annotations, layout-as-visualization-spec. Each is deferred to a named later milestone.

The fork is the most uncertain part of the schedule. Subtractive cuts surface dependencies that look innocuous but turn out to be load-bearing; calendar time on the cuts will exceed what the line count suggests. The new functionality is more predictable because each component is well-scoped.

## Consequences

- **Positive:** The team has an honest, defensible commitment instead of vague intent. The five-to-six-week window is plannable: week one for skeleton and initial cuts, weeks two and three for parallel new-functionality tracks, week four for integration, weeks five and six for polish. Out-of-scope items are named so they cannot quietly creep back in. The Claude-Code-with-oversight collaboration mode is acknowledged as the actual delivery mechanism, not aspirational autonomy.
- **Negative / cost:** Several capabilities are deferred that would otherwise be tempting to bundle: full fault injection, the complete RFC tool taxonomy, cross-notebook coordination, and production-scale polish. The calendar assumes disciplined oversight; if the operator cannot make decision-point time, the schedule slips toward the unsupervised 60-70% number. The fork's surfacing of load-bearing dependencies is a known risk that cannot be fully estimated up front.
- **Follow-ups:** DR-0015 picks up LLMKernel's mediator role (the unifying point translating between MCP, the kernel protocol, PTY traffic, and file-format writes), which V1 implements but the chapter defers full elaboration of. DR-0016 establishes the RFC discipline for the deferred tool taxonomy so the deferral has structure rather than drift. The doc-driven contract testing strategy locks in here as the foundation that does land in V1.

## Alternatives considered

- **Declare V1 not feasible and extend the timeline.** Rejected. The scope cuts in DR-0005 were specifically tuned to make this version feasible; extending the timeline without changing scope is procrastination, and cutting more scope at this stage would leave a build too small to test the hypothesis.
- **Ship a smaller "V0" demo first.** Rejected. A V0 that does not include the fork, the RTS view, and the chat UI would not exercise the integration questions that V1 is designed to answer. It would prove only that the easy parts are easy. The hypothesis test requires the full surface.
- **Plan for unsupervised Claude Code over a longer window.** Rejected. The 60-70% number with architectural drift implies expensive rework; trading oversight time for calendar time is a false economy for a build with this many cross-component decisions.
- **Plan for solo development without Claude Code.** Rejected as 2-3x slower at the same quality. The amplification from the collaboration is real and material to the calendar.

## Source

- **Source merged turn:** 085
- **Raw sub-turns:**
  - [turn-099-user.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-099-user.md) — the forcing question: could Claude Code make a serious V1 with fork+merge LLMKernel, advanced chat capabilities, and RTS view.
  - [turn-100-assistant.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-100-assistant.md) — honest feasibility verdict, what serious-V1 includes, what is deferred, the 5-6 week calendar shape, the supervised-vs-unsupervised collaboration math.
- **Dev guide:** [chapter 07](../dev-guide/07-subtractive-fork-and-storage.md)
