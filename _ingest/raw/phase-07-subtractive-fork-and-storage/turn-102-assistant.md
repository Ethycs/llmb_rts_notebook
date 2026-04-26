---
turn_id: 102
merged_turn_id: 088
role: assistant
phase: 07-subtractive-fork-and-storage
source_lines: [11358, 11833]
source_sha256: 73a953d15b16ca99cec6b7278a3e1f22bf9dc3fab72ae990fbd9b80821a19fc2
char_count: 23081
---



## Assistant

Good move. Pulling testing and lifecycle handling forward into specific work items is the right discipline — they're the two places I flagged as Claude Code's weak spots, and treating them as first-class scoped tasks rather than "stuff to figure out during integration" changes how they get done.

Let me work through both, because they're different kinds of problems and the breakdown for each is different. I'll also flag what I think you mean by "msofy docs" since that's not quite parsing — best guess is "Microsoft docs" (vscode-jupyter and VS Code extension API documentation) but tell me if you meant something else.

Before breaking them down, worth naming why pulling these forward is correct:

Jupyter messaging protocol tests are leverage in a specific way: the protocol is the contract between LLMKernel (Python) and the forked extension (TypeScript). Bugs at the protocol layer manifest as confusing behavior far from the cause — cells silently fail, outputs don't render, kernel appears alive but doesn't respond. Tests at the protocol layer catch issues before they propagate. They're also one of the few places where you can write tests that span the language boundary, which is exactly where bugs hide.

Lifecycle issues are the category of bugs that ship to production and embarrass you. Activation timing, kernel restart, cell-during-shutdown, file-close-while-running — these are the "rare but important" cases that get cut from the v1 schedule and then bite operators in week 2. Documenting and testing them now means they ship working.

Both are infrastructure work. They're not glamorous; they don't show up in a demo. But they're the difference between "the v1 mostly works" and "the v1 is genuinely usable," and they're both well-specified enough that Claude Code can do most of the work with you reviewing.

The Jupyter messaging protocol is documented (`https://jupyter-client.readthedocs.io/en/stable/messaging.html`) and has a stable spec. The wire format is signed JSON over ZeroMQ sockets. There are five sockets per kernel (shell, iopub, stdin, control, heartbeat), and several dozen message types.

For your fork, you only care about a subset. The cuts from the previous turns mean you don't need to test:

What you do need to test:

Core lifecycle messages:

Execution messages:

Display messages:

Custom messages (your additions):

Each of these has a defined schema, defined sender/receiver, defined ordering constraints. Each is testable.

Here's a granular breakdown of test work, sized for individual Claude Code sessions:

1. Test harness setup (~1 day)

Build a test rig that can:

This is foundational; everything else depends on it. The pattern: pytest fixtures that yield a connected kernel, with cleanup in finalizers. Existing examples in the Jupyter ecosystem (the `ipykernel` test suite itself uses this pattern).

Acceptance criteria: a single trivial test ("send `kernel_info_request`, get a `kernel_info_reply`") passes reliably from a clean state, and the suite can run repeatedly without state leaking.

2. Lifecycle test set (~1 day)

Tests for kernel start, ready-state, idle/busy transitions, shutdown, restart, interrupt. Specifically:

Each test is small (10-30 lines) but the set together verifies the lifecycle works.

3. Execution test set (~1 day)

Tests for normal cell execution flow:

This set verifies the meat of cell execution works as expected.

4. Display/output test set (~half day)

Tests for the output pipeline:

Particularly important: your custom MIME types (`application/vnd.rts.run+json`) need to round-trip through the protocol correctly.

5. Custom message test set (~1 day)

Tests for your RTS-specific extensions to the protocol. For each custom message type:

This depends on what custom messages you've defined. From earlier turns: layout-update messages, agent-graph queries, map-state synchronization. Probably 5-10 message types to test.

6. Edge cases and failure modes (~1 day)

Tests for what happens when things go wrong:

Each is a single test verifying graceful failure rather than crash.

7. Concurrency tests (~half day)

Tests for concurrent operations:

These catch race conditions, which are the worst protocol bugs.

Total: ~5-6 days of focused test work, parallelizable in chunks. Can be done in parallel with the v1 implementation by Claude Code while you focus on the harder integration work.

A real consideration: not everything needs the same test depth. Three layers:

Unit tests for individual message handlers in LLMKernel. Mock the socket; test the handler logic. Fast, deterministic, no subprocess. Use these for testing the kernel's logic in isolation.

Integration tests for round-trip behavior. Real kernel subprocess, real socket, real messages. Slower but tests the actual wire protocol. Use these for the lifecycle, execution, and custom-message tests.

Property-based tests for protocol invariants. Use a library like `hypothesis` (Python) to generate random message sequences and assert invariants (e.g., "every busy is followed by idle," "every execute_request gets a reply"). These catch edge cases you wouldn't think to write.

For v1, all three layers matter but in different proportions: lots of integration tests (the meat), fewer unit tests (mostly for complex handlers), a small set of property-based tests (for the most important invariants).

Concretely, in your test directory:

The TypeScript tests live with the fork; the Python tests live with the kernel. They test the same protocol from opposite sides.

A nice property: integration tests on the Python side and integration tests on the TypeScript side (using `jupyter-server` or similar to mock the other party) cover the same protocol from both ends. Bugs that show up in only one side's tests indicate sender/receiver mismatches.

Now the second half. "Lifecycle issues" is a category, not a specific bug list. Let me enumerate what can go wrong, then organize into work items.

The lifecycle stages and their associated risks:

Extension activation:

File open:

Kernel start:

Cell execution:

Map view lifecycle:

File save:

File close:

Kernel shutdown:

Extension deactivation:

That's a lot. Each is a real failure mode. Let me organize them into work items.

Group by transition, since each transition is where issues happen:

Work item L1: Extension activation hardening (~1 day)

Acceptance: extension activates reliably across VS Code's activation scenarios; clear error messages if it can't.

Work item L2: File open handling (~1 day)

Acceptance: opening any `.llmnb` file results in either a successful load or a clear error message; never silently broken state.

Work item L3: Kernel start sequence (~1-2 days)

Acceptance: kernel start works in 99% of cases without operator intervention; the 1% has clear actionable error messages.

Work item L4: Cell execution lifecycle (~1-2 days)

Acceptance: cell execution behaves predictably under all the conditions tests cover; no zombie cells, no lost outputs, no false "still running" states.

Work item L5: Map view lifecycle (~1 day)

Acceptance: opening, closing, and reopening the map view in any order works without breaking.

Work item L6: File save sequencing (~1 day)

Acceptance: saves are reliable; the saved file always represents a consistent state; failures are visible.

Work item L7: File close coordination (~1 day)

Acceptance: closing a notebook handles all the resources properly; nothing leaks; operator is warned about real risks.

Work item L8: Kernel shutdown coordination (~1 day)

Acceptance: kernel shutdown is reliable; nothing is left running; final state is captured.

Work item L9: Extension deactivation (~half day)

Acceptance: extension can be deactivated, uninstalled, or updated without leaving artifacts behind.

Work item L10: Diagnostic and recovery commands (~1 day)

Acceptance: when things break, the operator has tools to understand and fix.

Total: ~10-12 days of lifecycle work, but most of it is small focused changes rather than large feature work. Highly parallelizable into Claude Code sessions.

Best guess on "msofy docs" — Microsoft's documentation for VS Code extension API and vscode-jupyter. There are specific pages worth referencing:

VS Code Extension API:

vscode-jupyter wiki:

Jupyter messaging protocol spec:

Pulling these into a local doc reference (or just letting Claude Code fetch them as needed) gives you specific patterns to follow. Worth doing a documentation-mining pass early in the project so the lifecycle code uses official patterns rather than reinvented ones.

If "msofy" actually meant something else — let me know and I'll redirect.

You asked how to break it down even more. A few axes that help:

By component: separate test files and lifecycle work for kernel, extension, webview, file format. Each component has its own surface and can be worked on independently.

By risk: rank the lifecycle issues by how likely they are to bite operators. The highest-priority ones (kernel start failure, save during execution) get done first; lower-priority ones (extension update mid-session) get done later.

By dependency: some work items unblock others. The test harness (work item 1) unblocks all the test sets. The kernel start hardening (L3) unblocks reliable test runs. Identify dependencies and parallelize what can be parallelized.

By session size: aim for half-day to one-day work items. Each is a focused Claude Code session with clear scope and acceptance. Smaller items that can be batched (several edge case tests in one session) save context-switching cost. Larger items (the kernel start sequence) need a full session.

By language boundary: Python work (kernel-side) and TypeScript work (extension-side) can be in separate sessions. They communicate via the protocol; they're testable independently.

By milestone: chunk the work into milestones with end-to-end functionality. "After this milestone, the operator can run a cell and see output." "After this milestone, the operator can save and reopen a file." Each milestone is a working state of the system.

Applying these axes:

A reasonable first milestone: kernel start, run a cell, see output, save, reopen, see output preserved. This requires:

That's ~9-11 days for milestone 1: the basic round-trip works reliably. Probably 2 weeks of calendar time with you reviewing.

After milestone 1, the rest is about robustness and edge cases. Each subsequent week ticks off lifecycle issues, expands test coverage, and stabilizes the system.

A few tactical recommendations:

Have Claude Code write the test list first, before writing any tests. Get the comprehensive list of test cases as a document, review it for completeness, then have Claude Code implement them in batches. This separates "what should be tested" from "how to test it" and lets you catch missing cases early.

For each lifecycle work item, define acceptance criteria upfront. "After this work item, this scenario works: <specific scenario>." Claude Code can implement to spec; vague specs produce vague code.

Run the tests frequently as the implementation progresses. Tests are only useful if they actually run and pass. Set up CI early so every change runs the suite.

Use property-based testing sparingly but pointedly. Hypothesis-style tests are great for protocol invariants (every busy followed by idle, every request gets a response). Don't try to property-test everything; focus on the invariants that actually matter.

Test failures are documentation. When a test fails, the output should clearly say what was expected and what happened. Invest in good failure messages; they pay back when debugging.

Document protocol deviations. If your custom messages or behaviors deviate from standard Jupyter, document why. Future-you will need to know.

Doing the testing and lifecycle work properly buys you:

Confidence to refactor. With good tests, you can change implementation knowing tests catch regressions. The fork will need refactoring as you discover better patterns.

Faster bug investigation. When something breaks, the failing test points at the cause directly. Without tests, you're hunting through logs.

Easier collaboration. If anyone else (or future-you) works on this, tests are the documentation of expected behavior.

Real shipping confidence. The difference between "I think it works" and "I tested it works" is the difference between v1 surviving real use and v1 falling apart on contact.

Foundation for v2. v2 features will be built on top of the v1 lifecycle. If v1's lifecycle is shaky, v2 inherits that fragility. Investing in lifecycle now compounds.

Pulling testing and lifecycle work to the front is the right move. It changes the v1 plan from "build features fast, fix issues during integration" to "build a foundation that's testable and reliable, then build features on it." The latter is slower at the start but much faster overall.

Total estimate for both:

Combined ~15-18 days, or 3-4 weeks calendar time. This is in addition to the other v1 work, but most of it parallelizes with feature implementation and parts of it (the test harness, the activation hardening) are prerequisites that unblock everything else.

The work items I've listed above are each small enough for a focused Claude Code session with clear acceptance criteria. The dependencies between them are explicit. The order is deliberate (test harness first, then test sets, then hardening, then edge cases).

Decisions worth making:

What was "msofy docs" supposed to mean? If Microsoft docs, the work I sketched aligns with mining their official references. If something else, redirect me and I'll adjust.

Want to dig into the test harness specifics for either language, the acceptance criteria for the highest-priority lifecycle work items, the protocol-deviation documentation pattern, or the milestone-1 plan in more concrete detail?

```javascript
tests/
├── conftest.py                          # fixtures
├── protocol/
│   ├── test_lifecycle.py                # start, stop, restart, interrupt
│   ├── test_execution.py                # execute_request flow
│   ├── test_display.py                  # display_data, MIME types
│   ├── test_custom_messages.py          # RTS-specific messages
│   ├── test_edge_cases.py               # malformed input, timeouts
│   └── test_concurrency.py              # races, queueing
├── kernel/
│   ├── test_handlers_unit.py            # in-process handler tests
│   └── test_magic_commands.py           # your existing tests, extended
└── extension/                           # TypeScript tests in fork
    ├── test_message_handler.ts          # extension-side message handling
    └── test_renderer.ts                 # MIME renderer behavior
```

- IPyWidgets comm channels
- Most debugger messages
- Some Python-specific messages

- kernel_info_request / kernel_info_reply (handshake)
- shutdown_request / shutdown_reply
- interrupt_request / interrupt_reply
- status (busy/idle broadcasts on iopub)
- Kernel start/stop sequencing

- execute_request / execute_reply
- execute_input (broadcast)
- execute_result
- error
- stream (stdout/stderr)

- display_data
- update_display_data
- clear_output

- RTS-specific message types you define for layout, agent graph, map state

- Start LLMKernel as a subprocess
- Connect to it over the kernel protocol (using the jupyter_client library or your own minimal client)
- Send messages and assert on responses
- Tear down cleanly between tests

- Kernel reaches idle state within N seconds of start
- kernel_info_reply returns within N ms of request
- shutdown_request causes kernel to exit cleanly within N seconds
- shutdown_request with restart=True brings kernel back up
- interrupt_request during a long execution stops it
- Kernel survives an exception in user code (status returns to idle, kernel still responsive)
- Kernel survives an exception in your custom magic command

- execute_request returns matching execute_reply
- Status transitions to busy then idle
- execute_input is broadcast on iopub
- execute_result for expression-returning cells
- stream messages for stdout/stderr
- error messages for exceptions, with traceback
- Multiple concurrent execute_requests queue correctly
- Empty cells return cleanly

- display_data with various MIME types renders correctly
- update_display_data updates the right output
- clear_output clears
- Streaming output (multiple stream messages for one execution)
- Mixed output (stream + display in the same cell)

- Round-trip serialization works
- Schema validation catches malformed messages
- The receiver handles it correctly
- Errors in custom message handling don't break the kernel

- Malformed messages (missing fields, wrong types)
- Messages with wrong session ID
- Messages out of order
- Kernel taking too long to respond (timeout handling)
- Socket disconnect mid-execution
- Very large messages (bigger than typical buffer sizes)
- Unicode and binary content edge cases

- Multiple cells executing in sequence (queueing works)
- Status messages broadcast to multiple subscribers
- Custom message handling under load
- Heartbeat continues during long execution

- Activates at the wrong time (too early: VS Code APIs not ready; too late: file already open with no handler)
- Activation throws (extension dead, hard to debug)
- Activation is slow (VS Code shows progress; if too slow, user thinks it's broken)
- Multiple activations (extension activates twice from different events)

- File opens before kernel is ready
- File opens with wrong file extension association
- File contains schema your code can't handle (old version, corrupted)
- File is huge and parse takes long
- File is opened in two windows simultaneously

- Kernel binary not found (LLMKernel not installed)
- Kernel takes too long to start
- Kernel starts but never reaches idle (infinite init loop)
- Kernel starts but reports an error
- Multiple kernels start for the same file (race condition)
- Python environment issue (wrong Python, missing dependencies)

- Cell runs while another is queued
- Cell is interrupted mid-execution
- Cell execution hangs
- Kernel dies mid-execution (process crash)
- Cell produces error output
- Cell produces no output
- Output stream is unusually large

- Map opens before notebook is loaded
- Map references zone IDs that don't exist
- Map closes while data is loading
- Multiple maps open for the same notebook
- Webview crashes (rare but possible)
- Webview takes too long to load

- Save happens during cell execution
- Save fails (disk full, permissions)
- Save happens during agent operation (partial state captured)
- Concurrent saves from two windows
- Schema migration on save

- Close while cells are executing
- Close while agents are running
- Close without saving
- Close with unsaved changes
- Close while map view is open

- Shutdown requested while busy
- Shutdown takes too long, force-kill needed
- Subprocess (agent) doesn't terminate when kernel does
- Shutdown during file save

- VS Code shutting down with active kernel
- Extension being uninstalled
- Extension being updated (deactivate/reactivate)
- Workspace switch (extension disposes some resources)

- Define explicit activation events in package.json (onLanguage:llmnb or specific commands)
- Wrap activation function in error handling that logs but doesn't crash
- Verify VS Code API readiness before using each feature
- Test activation in clean and dirty workspaces
- Add telemetry/logging for activation timing

- Schema validation on file open (catch old formats, corrupted files)
- Migration path for old schema versions
- User-friendly error if file can't be opened (not a generic "can't parse JSON")
- Handle "file already open in another window" case
- Defer kernel start until file is fully loaded

- Detect missing LLMKernel installation, provide install instructions
- Timeout on kernel start with a useful error message
- Retry on transient failures (port conflicts, etc.)
- Race condition prevention (only one kernel per notebook)
- Health check before considering kernel "ready"
- Logging to a known location for diagnostics

- Queue management for concurrent execute_requests
- Interrupt handling that actually stops the cell
- Timeout for cells that hang
- Recovery from kernel crashes mid-execution
- Cell output saved to file even if cell is interrupted
- Status correctly reflects current execution

- Map waits for notebook load before rendering
- Map handles missing/stale data gracefully
- Map can open and close cleanly multiple times
- Webview crash recovery (relaunch if it dies)
- State synchronization on reload

- Save coordinates with kernel state (kernel writes its state into metadata before file is serialized)
- Save during execution doesn't capture partial state
- Save failures are reported, not silent
- Schema migration on first save after upgrade
- Atomic writes (write to temp file, rename)

- "Close with unsaved changes" prompt
- "Close with running cells" prompt
- "Close with active agents" prompt and graceful agent shutdown
- Map view closes when notebook closes
- Resources released cleanly

- Graceful shutdown with timeout
- Force-kill if graceful shutdown fails
- Agent processes terminated with kernel
- Final state captured before kernel dies
- Logged for postmortem

- Dispose all resources (subscriptions, webviews, kernels)
- Handle workspace switch
- Handle extension reload (update)
- Persist any unsaved state

- "Restart Kernel" command that works reliably
- "Show Kernel Logs" for debugging
- "Reset Notebook State" for unrecoverable cases
- Status bar item showing current kernel state
- Telemetry for understanding common failure modes

- Activation events documentation
- Notebook API reference
- Webview API reference
- Disposable pattern documentation
- Extension lifecycle documentation
- Custom editor API (if relevant)

- Source Code Organization (we referenced this)
- Kernels (Architecture)
- Module Dependencies
- Extensibility for other extensions
- Kernel API documentation

- The official Jupyter Client documentation
- The full message specification

- Test harness (1 day)
- Lifecycle test set (1 day)
- Execution test set (1 day)
- L1: Extension activation hardening (1 day)
- L2: File open handling (1 day)
- L3: Kernel start sequence (1-2 days)
- L4: Cell execution lifecycle (1-2 days)
- L6: File save sequencing (1 day)

- Protocol tests: ~5-6 days
- Lifecycle work items: ~10-12 days

1. Lock the test taxonomy (unit / integration / property-based) and stick to it.
2. Define acceptance criteria for each lifecycle work item before implementation.
3. Run tests in CI from week 1 so regressions are caught immediately.
4. Pick the milestone-1 scope (basic round-trip) and complete it before moving to robustness.
5. Document custom protocol extensions as you add them.
6. Pull Microsoft docs for VS Code Extension API and vscode-jupyter into your reference set.
7. Allocate time for both Python and TypeScript test work — they're complementary halves of the same protocol.

