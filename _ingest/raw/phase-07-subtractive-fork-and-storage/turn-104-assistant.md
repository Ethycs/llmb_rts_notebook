---
turn_id: 104
merged_turn_id: 090
role: assistant
phase: 07-subtractive-fork-and-storage
source_lines: [11840, 12055]
source_sha256: 260ba6b00274f564db54c203b1dca91bf884797cc484dd7134a8a5aa445d4674
char_count: 19079
---



## Assistant

Yes — and this is one of those questions where the obvious-sounding answer ("write tests for what the code does") is wrong, and your instinct ("write tests against the docs") is right. Let me work through why it simplifies, and then where the limits are, because there are some real subtleties.

The core insight: the documentation is the contract. The Jupyter messaging protocol spec, the VS Code extension API, the LangSmith schema — these are specifications written by other people, and your code is supposed to conform to them. If you test what your code does, you're testing your implementation. If you test what the docs say, you're testing whether your implementation honors the contract.

Several real benefits follow:

The docs are the source of truth. When you write tests from docs, the docs become your test specification. As long as the docs are accurate, your tests verify correctness. As long as the docs are current, your tests stay aligned with reality.

The test list is enumerable. The Jupyter messaging spec lists every message type with its required and optional fields. The VS Code API documents every API call with its parameters and return types. You can mechanically walk through the docs and write a test for each spec'd behavior. The work becomes "did I cover everything in the docs?" rather than "did I think of every edge case?"

The tests are stable across implementation changes. If you refactor your message handling code, doc-based tests still pass as long as you still honor the protocol. Tests that mirror your implementation break on every refactor; tests that mirror the docs break only when the docs change (which is much rarer).

Bugs become bugs against spec. When a test fails, you don't argue about whether the behavior is "right" — the docs say what's right. The conversation becomes "the docs say X, our code does Y, fix the code." Specifications resolve disagreements that implementation-level tests just exhibit.

You catch protocol violations you wouldn't have thought to test. The Jupyter spec mandates that `parent_header` field be set on responses to `execute_request`. If you only tested "execute_request returns a reply," you'd miss the parent_header check. If you walked the spec and tested every required field, you'd catch it.

The same tests work for the kernel and the client. Both sides of the protocol have to honor the same docs. A test for "kernel sends `kernel_info_reply` with these required fields" works whether you're testing the kernel emitting it or the client receiving it. The contract is symmetric.

Documentation gaps become visible. When you try to write a test from a doc and find the doc doesn't say what should happen in some case, you've found a documentation bug (or an underspecified behavior). Either fix it or document the assumption you're making.

So yes — for any well-documented protocol or API, doc-driven tests are simpler, more stable, more enumerable, and produce stronger guarantees. This applies to:

For these, treat the docs as the test specification.

Honest list of where doc-driven testing alone isn't enough:

Behaviors that aren't documented. Plenty of behavior in real systems is implicit. Race conditions, timing, error recovery, performance — these are rarely in spec docs. If you only test what's documented, you miss undocumented invariants that matter in practice.

Specific example: the Jupyter spec says what a `kernel_info_reply` looks like, but doesn't specify the exact timing requirements. Your code might be technically conformant but slow enough that VS Code times out. Doc tests don't catch this.

Your custom extensions. Anything you add beyond the spec — your custom MIME types, your custom messages for RTS state, your `metadata.rts` schema — needs its own documentation, written by you. If you test the standard protocol from upstream docs and your custom additions from your own docs, you're consistent. If you have undocumented custom behavior, you need to either document it or test it implementation-style.

Integration behavior. Doc tests verify each component honors its contract. They don't verify that two components interacting produce the right behavior end-to-end. "Kernel emits valid `display_data`" and "Extension renders `display_data` correctly" both pass, but the screen still might be blank because of a bug in how they connect. End-to-end tests are still needed.

Spec ambiguity and gaps. Real specs have ambiguous corners. The Jupyter spec doesn't fully specify, e.g., what happens when you send `execute_request` to a kernel that's already busy. Different kernels handle it differently (queue, error, ignore). Doc-driven testing here forces you to pick a behavior and document it, which is good, but the doc isn't telling you which behavior is correct.

Spec-document mismatch. Sometimes the spec is wrong, or the canonical implementation diverges from the spec, and you have to match the implementation rather than the spec. The Jupyter spec has had cases where what `ipykernel` does and what the spec says are different; in practice, you have to match `ipykernel`. Doc-driven testing alone won't tell you which is right.

Behavior that emerges from composition. Some behaviors are properties of how multiple things compose, not of any individual contract. "The kernel doesn't leak memory across thousands of executions" isn't in any doc but matters for shipping software.

UI and UX behaviors. Doc tests don't verify that the UI feels right. The diff preview opens correctly per the API; whether it's visible to the operator at the right time isn't a docs question.

These aren't reasons to abandon doc-driven testing. They're reasons it's the right foundation but not the whole test suite.

Layer it like this:

Layer 1: Doc-driven contract tests. The bulk of the test work. For each documented protocol message, API call, or schema, write tests that verify conformance. This is mechanical and enumerable.

Layer 2: Custom-extension tests. For everything you add (custom messages, custom MIME types, custom file format extensions), write your own docs first, then test against those docs. Same discipline as Layer 1 but for your additions.

Layer 3: Documented behavior tests. For behaviors you've specified in your project's design docs (the v1 spec, architectural decisions), test those. This catches "we decided X behavior in week 2; week 5's refactor accidentally changed it."

Layer 4: Integration / end-to-end tests. A small set of tests that exercise the full stack: kernel + extension + UI working together for key user workflows. These catch composition bugs.

Layer 5: Property-based tests for invariants. For properties that should always hold (e.g., "every busy is followed by idle," "every cell execution produces an execute_reply"), use property-based testing to generate random sequences and check invariants.

Layer 6: Regression tests. When a bug is found in the wild, write a test that reproduces it. Add to suite. Prevents recurrence.

The mass is in Layer 1 (and Layer 2 for your additions). Layers 3-6 are smaller but important.

Re-reading the protocol test work item from the last turn through the doc-driven lens, several work items collapse:

Lifecycle test set, execution test set, display/output test set — these were three separate test sets I described, each enumerating cases. Done as doc-driven tests, they collapse into one mechanical exercise: walk the Jupyter messaging spec, write a test for each message type and each documented behavior. Probably reduces total work by ~30% because you're not reinventing the structure of "what to test."

Edge cases and failure modes — partially covered by doc-driven tests (the docs say what should happen on invalid input), partially in your custom extension docs, partially in property-based tests for invariants. Doc-driven approach forces you to ask "what does the doc say happens on bad input?" which is the right question.

Concurrency tests — mostly not in docs (Jupyter spec doesn't say much about concurrency). These stay as custom tests against your own design specs.

The custom message test set and the lifecycle work items are still custom-spec tests (Layer 2) since they're your additions. The docs you write for them are part of the project, and tests verify conformance.

Total test work probably drops from ~5-6 days to ~3-4 days for the protocol layer, with the savings coming from "the structure is in the docs already, you don't have to invent it."

A few things that make this approach actually work:

Read the docs carefully. Skimming and writing tests for vibes doesn't work. The docs have specifics that matter. Plan to spend time reading.

Cite the docs in tests. Each test should reference which doc section it covers. `test_execute_request_required_fields` should have a comment: `# Per Jupyter Messaging Spec section 4.1, execute_request must have these fields...`. Makes it auditable: did we cover the whole spec?

Track coverage against the docs. Maintain a checklist or generated report: "Jupyter spec section 4.1: ✓ tested. Section 4.2: ✓ tested. Section 4.3: not tested." Lets you see gaps.

Maintain your own custom-extension docs in the same shape. Your `metadata.rts` schema, your custom messages, your `.llmnb` format — write docs that look like the upstream specs (numbered sections, each describing a message or field), so the same tooling and discipline apply.

Update tests when docs update. When the upstream Jupyter spec changes, your tests should change. Track upstream doc changes (their git history of the spec) and update accordingly.

Be honest about what's not in the docs. When you encounter undocumented behavior in upstream implementations, write a test for what you observe and label it explicitly: `# UNDOCUMENTED: ipykernel behavior, observed in version X.Y.` Future-you knows this is implementation-shadow rather than spec-derived.

Given this approach, here's the revised work plan:

Day 1: doc-mining. You and Claude Code together produce a structured outline of:

End of day 1: a single document (or set of docs) listing every testable assertion across all the contracts.

Day 2-3: test harness + first batch of tests. Set up the test infrastructure (last turn's test harness work). Then mechanically work through the first batch of doc-driven tests — probably the lifecycle messages and the basic execution flow. Claude Code can do this efficiently because each test is "given assertion X from section Y, write a test that verifies it."

Day 4-5: rest of the protocol tests. Continue through the doc, batch by batch. Custom messages get tested against your custom-extension docs. Each batch follows the same pattern.

Day 6: gaps and edges. Cases where the doc isn't clear, behaviors you observed that weren't documented, integration tests for end-to-end flows. These are the genuinely custom test work, post-doc-driven foundation.

Day 7: coverage check and fill-in. Generate a coverage report against the docs. Find the gaps. Fill them in.

Total: about a week for comprehensive doc-driven test coverage of the protocol surface, including the test harness. This is faster than the previous turn's estimate because the doc-driven structure removes a lot of "what should we test?" thinking and replaces it with mechanical execution.

Lifecycle issues are partially addressable with doc-driven testing — the VS Code extension API has documented patterns for activation, lifecycle, and disposal. But many lifecycle issues are:

So lifecycle work is partially doc-driven (use documented patterns correctly, test for documented contracts) and partially custom (test the specific scenarios you've identified as risks).

The breakdown from the previous turn still holds for lifecycle, but with one shift: each lifecycle work item should produce its own design doc first, then tests against that doc.

For example, work item L3 (kernel start sequence):

This makes lifecycle work doc-driven too, just with the docs being your project's design docs rather than upstream specs.

The pattern that makes this work generally: before writing code, write a doc that specifies what the code does. Then write tests against the doc. Then write the code to make tests pass.

This is mostly TDD with an explicit documentation step, and it has a few nice properties:

For a project where many components are implementations of external protocols (Jupyter, VS Code API, MCP, LangSmith), most of the docs are just summaries of upstream docs. The doc-writing is a few hours of work that produces a clear test specification.

For your custom additions, doc-writing is more work but it's work that needed doing anyway — you'd have written design docs at some point. Doing it before tests makes everything else easier.

Significantly. Doc-driven testing is very well-suited to Claude Code workflows:

You can reasonably do this:

This is very different from "write tests for whatever you think is important." It's structured, enumerable, and reviewable.

Claude Code also benefits in a less obvious way: when implementing the code, Claude Code can reference the same docs. "Implement message handler X per Jupyter spec section Y" produces code that's spec-conformant by construction, then tested against the same spec. Tight loop.

Updating the v1 plan to incorporate doc-driven testing:

Pre-week 1 (or week 0): doc-mining sprint. Produce summarized doc-derived assertion lists for all contracts — Jupyter spec, VS Code API surface used, LangSmith schema, MCP, custom extensions. Result: a set of structured docs that drive testing.

Week 1: test harness + first batch of doc-driven tests, in parallel with the project skeleton. By end of week, you can run protocol tests against a placeholder kernel implementation.

Week 2-3: implementation tracks (from previous turns), with each piece written against its doc spec and tested against the doc-driven assertions.

Week 4: integration tests, end-to-end scenarios, gap-filling. The doc-driven layer is comprehensive; this week is the rest.

Week 5-6: polish, edge cases, regression tests as bugs surface.

The doc-driven approach saves time in weeks 1-3 by structuring the work; doesn't change the polish phase.

Yes, doc-driven testing simplifies — substantially. It replaces "think of every case" with "walk the spec." It makes tests stable across refactors, auditable against docs, and explicitly grounded in the contracts your code is meant to honor.

For your project specifically, where most components implement well-specified external protocols (Jupyter, VS Code API, MCP, LangSmith), most of the test work becomes mechanical doc-walking. The remaining work — your custom extensions, integration tests, edge cases — is smaller and more focused once the foundation is solid.

This approach also has a nice side effect: it forces you to write design docs for your custom additions, which you'd want to do anyway. The discipline of "doc, then test, then code" applies to your own work too.

Estimated savings: ~30-40% of the previous turn's protocol-testing time, with stronger guarantees and better-structured tests at the end.

The shift from "what does our code do?" to "what does the spec say should happen?" is the simplification you intuited. It's the right move.

Decisions to lock:

Want to dig into the doc-mining workflow specifically, the format for the structured assertion lists, the layered test taxonomy in more concrete code examples, or how to track coverage against external docs?

- Jupyter messaging protocol (well-spec'd)
- LangSmith / OpenTelemetry GenAI run schemas (spec'd, with some variation)
- VS Code Extension API (well-documented)
- MCP protocol (spec'd by Anthropic)
- The .ipynb format (spec'd by Jupyter)

- The Jupyter messaging protocol specification, summarized into a numbered list of testable assertions
- The VS Code extension API surface you depend on, similar treatment
- LangSmith / OpenTelemetry GenAI schema, summarized
- Your custom extensions (the message types, the .llmnb format, the MIME types) — write the docs for these now if they don't exist

- Behaviors that emerge from how your code uses the API (not from the API itself)
- Race conditions that aren't in any doc
- Recovery from failures that the docs don't fully specify

1. Design doc: write down the spec for how kernel start should work in your system. "Kernel must reach idle within 10 seconds. If start fails, error message must include the failure reason. Kernel restart on crash should preserve cell outputs."
2. Implementation: write code that meets the spec.
3. Tests: write tests that verify each assertion in the design doc.

- The doc is real before code; you've thought through the design
- Tests reference the doc, so tests are auditable
- Docs reference upstream specs where applicable, so the chain of authority is explicit
- Future readers (including future-you) can read the doc instead of reverse-engineering from code

- Reading dense specs and producing summarized testable assertions is something Claude Code does well
- Writing tests against numbered assertions is mechanical and parallelizable
- Generating coverage reports against doc structure is easy
- Cross-referencing tests to doc sections produces good test names and comments

1. Hand Claude Code the upstream docs (URLs or pasted content)
2. Ask it to produce the summarized assertion list
3. Review the list for completeness
4. Hand it batches of assertions and have it write tests
5. Review the tests for quality
6. Run, iterate

1. Doc-driven testing is the foundation for protocol, API, and schema conformance. Default to it.
2. Custom extensions get their own docs first, then tests. Same discipline as upstream-derived tests.
3. Tests cite their doc source. Comments referencing spec sections. Auditable.
4. Coverage is tracked against docs, not against code. "Did we test every documented assertion?" is the metric.
5. Layer structure: doc-driven contract tests at the foundation, then custom-extension docs and tests, then integration tests, then regression tests. Property-based tests for documented invariants.
6. Doc-mining is a real phase before testing. Budget the time; produce structured assertion lists.
7. Implementation references the same docs as tests. Code is spec-conformant by construction; tests verify the conformance.
8. Gaps in upstream docs are documented as such. Behavior we have to match without spec backing is labeled.
9. Updates to upstream docs trigger test updates. Track upstream doc git history.
10. Claude Code does most of the doc-summarizing and test-writing. The mechanical nature of the work suits it well.

1. Doc-driven contract testing as the foundation.
2. Doc-mining before testing, producing structured assertion lists.
3. Custom extensions get their own docs, then tests.
4. Tests cite doc sections.
5. Coverage tracked against docs.
6. Layered structure: doc-driven, custom-doc, integration, regression, property-based.
7. Implementation references the same docs.
8. Claude Code drives the mechanical parts; you review.

