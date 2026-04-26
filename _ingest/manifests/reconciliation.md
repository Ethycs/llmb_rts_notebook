# Phase reconciliation narrative

## Granularity choice: 8 canonical phases

The three agents proposed 14 raw phases. A naive merge to 7 (one per "big arc") loses the V1-scope-cut as a distinct event, which is the most important inflection in the entire conversation. A faithful 14-phase manifest over-fragments the long notebook-substrate arc into four phases that all answer one question: "where does the chat live and what is it built on top of?" Eight phases is the granularity at which each phase has a single load-bearing question and a single resolution.

## Agent-coverage seams

- **035 → 036 (kept).** This is a real topic seam, not just an agent boundary. Turn 035 is the last expansion-phase utterance ("MCP placement options 1–7"); turn 036 opens with the user's "Consider the simplest build for our V1" and the assistant's catalogue of cuts. The architectural mode flips from "add" to "subtract" here. Two phases.
- **070 → 071 (dissolved).** This is purely an agent-coverage boundary. Turn 070 ends mid-design on cell-based chat-over-MCP; turn 071 is the user's continuation ("remember when we talked about inadequate chat interface, bring that forward and get rid of the jupyter kernel..."). The same design problem spans both. Merged into phase 06.

## Over-fragmented phases that I merged

- **B.3 + B.4 + B.5 + C.1 → phase 06 (vscode-notebook-substrate, 057–076).** Four proposed phases all narrow toward the same conclusion: VS Code notebook as substrate, with bidirectional MCP and forced tool use. Splitting them would be cosmetic.
- **B.1 + B.2 → phase 05 (v1-scope-reduction, 036–056).** The frontend-framework search is the immediate consequence of the scope cut and resolves into "frontend is not the question." One phase.
- **C.2 + C.3 + C.4 → phase 07 (subtractive-fork-and-storage, 077–093).** All three answer "what survives the fork and how is the surviving data structured." The user's subtractive instruction in turn 077, the LLMKernel-as-sole-kernel commit in 083, and the .llmnb embedding in 083+ are one continuous design exercise.

## Phases I kept separate despite proximity

- **Phase 04 (isolation/MCP placement) vs phase 05 (V1 scope cut).** Adjacent in the chat but opposite in mode (expand vs contract). The 035 → 036 seam is the single most important inflection in the manifest; collapsing it would erase that.
- **Phase 06 (notebook substrate) vs phase 07 (subtractive fork).** Phase 06 picks the substrate (VS Code NotebookController + fork plan); phase 07 commits to the subtractive method and works out what survives, what storage looks like, and how to test the protocol. The seam at 076/077 is the user's "subtractive approach" instruction, which is a methodological commit distinct from the substrate choice.

## Decision deduplication

- **DR-0009 (notebook-controller, no Jupyter kernel)** subsumes Agent B's 067/070 lock-in and Agent C's 077/078 lock-in. Both proposals named the same decision; one ID with refs to all four turns.
- **DR-0014 (three storage structures embedded)** subsumes Agent C's 081/082 lock-in plus the 083 file-format collapse to .llmnb. The three-structures decision and the single-file embedding are the same architectural commit completed across two turns.
- Agent A's "chroot ladder" exploration (turns 022–027) did not resolve into a single LOCK-IN-grade decision; the placement decision (DR-0004) is the actionable one. The chroot-vs-bubblewrap detail is captured later in DR-0005 (V1 scope cut).

**Total: 8 phases, 16 decisions, covering merged turns 001–105 contiguously.**
