---
turn_id: 106
merged_turn_id: 092
role: assistant
phase: 07-subtractive-fork-and-storage
source_lines: [12062, 12452]
source_sha256: 4f1b82e68b25735649d41124a0df3f77512c5f99f88f0523b2a69abce7f8eecf
char_count: 22923
---



## Assistant

Yes, and this is a real upgrade in test sophistication. Combining mocks with Markov-driven simulation and fault injection gives you a fundamentally different class of test guarantee than doc-driven contract tests alone — you go from "does each individual interaction conform to spec" to "does the system behave correctly under realistic and adversarial sequences." Let me work through what each piece does, why they compose well, and how to actually build this.

Worth being clear about what we're combining, because they each address different test gaps:

Mocks isolate components and let you test them deterministically. You replace the real kernel with a mock kernel that emits exactly the messages you tell it to. Tests become predictable; failures localize cleanly. This is the standard testing technique and it's essential for fast unit tests.

Markov simulation generates realistic message sequences by modeling state transitions probabilistically. Instead of writing a fixed sequence ("send execute_request, expect execute_reply"), you model the protocol as states (idle, busy, executing, error) with probabilistic transitions, and let the simulator generate sequences. You get coverage of message orderings you wouldn't have thought to write by hand, including pathological ones.

Fault injection deliberately introduces failures — dropped messages, delayed messages, malformed messages, process crashes, network partitions — to verify the system handles them gracefully. Without this, tests verify happy paths; with it, you verify recovery.

The combination — mocks driven by Markov sequences with fault injection — is the standard approach for testing distributed systems, and the Jupyter messaging protocol is essentially a small distributed system. The kernel and the extension are independent processes communicating over sockets; bugs there are exactly the kind that Markov + fault injection catches.

Each technique addresses a specific gap:

A v1 with all four layers is meaningfully more reliable than a v1 with just unit tests. And the combination is more efficient than writing all the cases by hand — Markov simulation generates cases that would take you weeks to enumerate manually.

The cost is real: setting up the simulation infrastructure is non-trivial. But once built, it pays compound interest — every protocol change, every new feature, every refactor gets exercised against the same robust harness.

The Jupyter messaging protocol can be modeled as a Markov chain over kernel states. The states are roughly:

Transitions are probabilistic and event-driven:

Each state has a set of valid input messages and emits specific output messages with timing distributions. The Markov model captures this.

What you simulate:

Concretely, here's a sketch of what the Markov model looks like in Python:

The simulator runs by:

This is a small piece of code (maybe 200-300 lines for the full kernel state machine) and once built, you can drive it with any sequence of triggers.

A few patterns worth using:

Realistic operator workflows. Sequences derived from real usage: "open notebook, run 5 cells, edit cell 3, re-run, save, close." These verify happy paths under realistic conditions.

Random valid sequences. Generate random sequences of valid operator actions (within the state machine's allowed transitions). Catches ordering bugs.

Stress sequences. High-rate sequences (many cells in flight, frequent interrupts, rapid restarts). Catches concurrency and resource issues.

Adversarial sequences. Sequences that probe edge cases (run-then-immediately-interrupt, shutdown-during-execute, restart-while-busy). Catches state-machine bugs.

Replay sequences. When you find a bug in the wild, capture the sequence that caused it and add it to the test corpus. Becomes a regression test.

The combination of all five gives you breadth. Random sequences are particularly powerful because they explore the state space without your bias toward specific cases.

For random sequence generation, there are two flavors:

Pure random: each step, pick a uniformly random valid action. Simple but spends time on uninteresting sequences.

Coverage-guided: track which states and transitions have been exercised; bias generation toward unexercised paths. More efficient but more complex.

For v1, pure random with a few targeted sequences (the workflows, stress, adversarial) is enough. Coverage-guided is a v2 enhancement.

Markov simulation pairs naturally with property-based testing libraries like `hypothesis` (Python) or `fast-check` (TypeScript). The library generates sequences; your assertions are properties that must hold throughout.

Properties to assert:

Hypothesis-style tests look like:

The test runs hundreds or thousands of random sequences, each potentially exercising a different bug. When a failure is found, hypothesis shrinks the failing case to a minimal reproducer. This is genuinely powerful.

Fault injection makes the mock kernel deliberately misbehave. The categories:

Message-level faults:

Process-level faults:

Resource faults:

Timing faults:

For your project, the most relevant fault categories for v1:

These are the ones to test first. The others are v2.

Fault injection is implemented as configuration on the mock kernel: "in this scenario, drop the third execute_reply" or "in this scenario, the kernel hangs after 5 seconds." The simulator runs the same sequences with faults enabled; the system under test is supposed to recover or fail gracefully.

What you're testing under fault injection is recovery: does the extension show a useful error? Does it allow the operator to retry? Does it recover state on kernel restart? These are real lifecycle issues from the previous turn, now made testable.

Putting it together, the v1 test architecture has these layers:

Layer A: Doc-driven contract tests. Each documented message and behavior gets a test. Mechanical, comprehensive. Run on every change.

Layer B: Unit tests with mocks. Individual handlers tested with mocked dependencies. Fast feedback during implementation.

Layer C: Integration tests with real kernel subprocess. End-to-end on key workflows. Slower; run before merging.

Layer D: Markov simulation. Mock kernel driven by state machine; random and targeted sequences; property-based assertions. Run nightly or in CI on a schedule (slower, more thorough).

Layer E: Fault injection. Same Markov simulation but with faults enabled. Assertions are about recovery, not just correctness. Also run nightly.

Layer F: Stress and chaos. Highest-volume, longest-running, most adversarial. Run weekly or pre-release.

Each layer catches a different class of bug. Each is built on the layer below. The layers compose because they share the underlying mock infrastructure.

Practical breakdown, with realistic time budgets:

Step 1: Mock kernel infrastructure (~2 days)

A Python class that implements the kernel protocol from the kernel side: accepts messages on shell socket, emits messages on iopub and shell, handles heartbeat. Minimal compliant kernel that can be driven externally. Probably 300-500 lines.

Acceptance: a real Jupyter client can connect to it, send `kernel_info_request`, and get a valid reply.

Step 2: State machine encoding (~1 day)

Encode the Markov model: states, transitions, valid triggers per state, message emissions, timing distributions. As data, not code, so easy to extend.

Acceptance: given a sequence of triggers, the state machine produces a valid sequence of state transitions and messages.

Step 3: Simulator driver (~1 day)

Code that drives the mock kernel through the state machine: receives triggers (from tests or from a generator), executes transitions, emits messages with timing.

Acceptance: a test can send a sequence of operator actions and observe the resulting message stream.

Step 4: Property-based test integration (~1 day)

Hook up `hypothesis` to drive sequence generation. Define core properties (liveness, safety, ordering). Write the first batch of property tests.

Acceptance: `hypothesis` generates random sequences; properties pass for valid sequences; properties fail clearly when violated (synthetic bug introduced for verification).

Step 5: Fault injection framework (~2 days)

Configurable faults on the mock kernel: probability or scheduled triggering, fault types (drop, delay, corrupt, crash). Tests can specify a fault scenario and verify recovery behavior.

Acceptance: a test can specify "kernel crashes after 3rd execute_reply" and verify the system recovers (or fails gracefully).

Step 6: Test corpus (~2 days)

Build the actual test cases:

Each is a small test file referencing the simulator infrastructure.

Step 7: CI integration (~1 day)

Set up CI to run different layers at different cadences:

Reporting: failures are reported with the offending sequence (hypothesis shrinks to minimal case).

Total: about 9-10 days of focused work for the full simulation + fault injection infrastructure.

This is a real investment but it pays off across the whole project lifecycle. Once built, every protocol change gets exercised against thousands of generated sequences with faults — that's a level of confidence you can't get from hand-written tests at any reasonable cost.

Inserting into the v1 plan:

The simulation work parallelizes well with feature work because they're separate concerns. Claude Code can build the mock kernel and state machine while you (or other Claude Code sessions) work on the renderer or map view. Integration happens at week 4-5.

Concretely, what does this buy you?

Bugs caught before integration. A whole class of "kernel and extension don't agree about state" bugs gets caught before you connect them. Cleaner integration.

Confidence in lifecycle handling. The lifecycle work items from the previous turn become testable: each is exercised by the simulator with appropriate faults. "Kernel crash mid-execution" goes from "we should test this someday" to "we test this every night."

Stability under refactor. When you refactor — and you will — the simulator catches regressions immediately. Without it, regressions surface days later when a real workflow hits them.

Ship confidence. "Does v1 work?" becomes answerable: "The simulator runs N sequences nightly with M fault types and all properties pass." That's a real answer, not a vibes assessment.

Documentation as a side effect. The state machine encoding is documentation. Future readers can see exactly what kernel states exist, what transitions are valid, what messages are emitted. No need to read code or guess.

Foundation for v2. When v2 adds new features, you extend the state machine and add new properties. The infrastructure is reusable. v1's test work amortizes across the project's lifetime.

The investment is roughly 9-10 days; the return is in fewer bugs shipped, faster debugging when bugs do appear, and confidence that compounds over time.

A few real-world considerations:

Property assertion is hard. Writing the right properties is the cognitively expensive part. "Every request gets a reply" is easy; "the system handles a kernel restart during a partial execution gracefully" is harder to formalize. You'll iterate on properties as you understand the system better. Plan for this.

Hypothesis shrinking is amazing but slow. When a property fails, hypothesis tries to find a minimal failing case. This can take minutes for complex sequences. Worth it; just don't expect instant feedback on failures.

Timing in tests is tricky. Real systems have real timing; tests usually want to be fast. The mock kernel's timing distributions need to be either fast (for unit tests) or configurable (for stress tests that simulate realistic delays). Two modes is the right design.

Fault injection can be too aggressive. "Drop every third message" sounds reasonable but in practice produces tests where nothing works. Tune fault probabilities to realistic levels — actual systems have, like, 0.001% packet loss, not 33%. Calibrate against reality.

Real kernel behavior diverges from spec. The mock kernel implements the spec; real kernels (LLMKernel, ipykernel) may have undocumented behaviors. The simulator catches "code expecting strict spec compliance from a real kernel that's not strictly compliant." This is good — it surfaces assumptions.

State explosion is possible. As you add states (zones, agents, MCP servers), the state space grows. The Markov model needs to stay tractable. For v1, keep the model focused on protocol-level states; agent-level states are a v2 extension.

These are practical concerns, not blockers. Each has a manageable solution.

Your project has Python (LLMKernel) and TypeScript (the fork). Markov simulation can apply to both:

Python side: mock the client (the extension). Drive the kernel through scripted client behaviors; verify kernel state. The mock kernel is stateful Python; the mock client is stateful Python. Tests run in Python.

TypeScript side: mock the kernel. The fork's kernel-client code talks to a Python-implemented mock kernel via the real protocol over real sockets. Tests run via Node, calling out to Python. Or, mock the kernel in TypeScript directly (re-implementing the protocol). Either works; the Python-mock-via-real-sockets is more realistic.

For v1, I'd argue: build the mock kernel and the simulator in Python, since the Python ecosystem (jupyter_client, hypothesis) is mature here. Use it for testing both LLMKernel-side code (Python client connecting to mock kernel) and extension-side code (TypeScript client connecting to the mock kernel via real sockets). Single mock implementation, two test consumers.

Yes — Markov simulation with mocks and fault injection is the right next step beyond doc-driven contract testing. It's a real investment (9-10 days for the infrastructure) but it pays off in bug detection, refactor stability, ship confidence, and foundation for v2. The combination of all four techniques (mocks + simulation + property-based + fault injection) is the standard toolkit for testing distributed systems, and the Jupyter protocol is small enough to model fully.

Specifically:

This combination tests properties that hand-written tests can't reasonably cover. It catches bugs that doc-driven tests miss. It builds confidence in lifecycle handling that integration tests alone don't provide.

For v1, the build is parallelizable with feature work. The infrastructure (~9-10 days) lands in week 2-3, then everyone benefits for the rest of v1 and beyond. CI runs the slower layers nightly, providing continuous validation.

Decisions to lock:

The plan is real and the work is tractable. Each piece is well-scoped enough for Claude Code execution with your review at architectural points.

Want to dig into the specific Markov state machine for the Jupyter protocol, the hypothesis property definitions for v1, the fault injection framework's API, or the cross-language test execution pattern?

```python
import random
from dataclasses import dataclass
from enum import Enum

class KernelState(Enum):
    STARTING = "starting"
    IDLE = "idle"
    BUSY = "busy"
    INTERRUPTING = "interrupting"
    SHUTTING_DOWN = "shutting_down"
    DEAD = "dead"

@dataclass
class Transition:
    from_state: KernelState
    to_state: KernelState
    trigger: str  # what causes this transition
    probability: float  # probability given the trigger
    emit: list  # messages to emit on this transition
    delay: tuple  # (min, max) delay distribution

# Example transitions for the IDLE state
IDLE_TRANSITIONS = [
    Transition(
        from_state=KernelState.IDLE,
        to_state=KernelState.BUSY,
        trigger="execute_request",
        probability=1.0,
        emit=["status:busy", "execute_input"],
        delay=(0.001, 0.01),
    ),
    Transition(
        from_state=KernelState.IDLE,
        to_state=KernelState.SHUTTING_DOWN,
        trigger="shutdown_request",
        probability=1.0,
        emit=["status:busy"],
        delay=(0.01, 0.1),
    ),
    Transition(
        from_state=KernelState.IDLE,
        to_state=KernelState.IDLE,
        trigger="kernel_info_request",
        probability=1.0,
        emit=["kernel_info_reply"],
        delay=(0.001, 0.005),
    ),
]
```

```python
from hypothesis import given, strategies as st

@given(st.lists(st.sampled_from([
    "execute_request",
    "interrupt_request",
    "shutdown_request",
    "kernel_info_request",
]), max_size=50))
def test_kernel_protocol_invariants(action_sequence):
    sim = KernelSimulator()
    handler = SystemUnderTest()
    
    for action in action_sequence:
        emitted = sim.send(action)
        for msg in emitted:
            handler.receive(msg)
    
    # Invariants
    assert handler.busy_count == handler.idle_count, "every busy followed by idle"
    assert handler.pending_replies == 0, "every request got a reply"
    assert not handler.has_concurrent_executions(), "no concurrent execution"
```

- Doc-driven tests catch contract violations (this message doesn't conform to spec)
- Mocks catch handler bugs (this code doesn't process this input correctly)
- Markov simulation catches sequence bugs (this code mishandles this ordering of valid messages)
- Fault injection catches robustness bugs (this code breaks when reality intrudes)

- starting — kernel process spawned, not yet ready
- idle — kernel ready, waiting for requests
- busy — kernel currently executing
- interrupting — kernel received interrupt, hasn't yet returned to idle
- shutting_down — kernel received shutdown, hasn't yet exited
- dead — kernel exited (cleanly or otherwise)

- From starting: high probability transition to idle after some delay; small probability of dead (start failure)
- From idle: transitions to busy on receiving execute_request; to shutting_down on shutdown_request; back to idle (no-op) on heartbeat or info request
- From busy: transitions to idle on execute_reply; to interrupting on receiving interrupt_request; to dead on crash (small probability)
- From interrupting: transitions to idle once interrupt completes; to dead on force-kill timeout
- From shutting_down: transitions to dead once shutdown completes

1. Generate a sequence of operator actions (run cell, interrupt, run another, restart kernel, etc.) drawn from realistic distributions
2. The mock kernel processes each action by transitioning through the state machine, emitting the right messages with realistic timing
3. The system under test (the extension code, or the kernel-protocol client) receives those messages and is supposed to handle them correctly
4. Assertions verify invariants throughout: every busy is followed by idle, every execute_request gets a reply, no two simultaneous executions, etc.

1. Starting in some state
2. Receiving (or generating) a trigger
3. Looking up valid transitions
4. Picking one based on probability
5. Sleeping for the delay
6. Emitting the messages
7. Updating state
8. Repeating

- Liveness: every execute_request eventually receives an execute_reply (within timeout)
- Safety: never two executions in flight simultaneously
- Ordering: status busy must precede execution outputs; status idle must follow them
- Mutual exclusion: kernel doesn't accept new requests while shutting down
- Resource: no message sequence causes unbounded memory growth
- Conservation: every input message corresponds to defined state transitions

- Drop a message (reply never arrives)
- Duplicate a message (reply arrives twice)
- Reorder messages (out-of-order arrival)
- Delay a message (arrives much later than expected)
- Corrupt a message (malformed JSON, missing fields, wrong types)
- Send a message at the wrong time (status idle while still busy)

- Kernel crash (process exits unexpectedly)
- Kernel hang (stops responding entirely)
- Kernel slow response (takes much longer than expected)
- Kernel restart mid-conversation
- Kernel sends signal-of-death without proper shutdown

- Out-of-memory in kernel
- Disk full when writing
- Socket buffer overflow
- File handle exhaustion

- Clock skew between kernel and extension
- Heartbeat timeouts
- Race conditions (two events at the same instant)

- Kernel crash (real, happens)
- Slow responses (real, happens)
- Malformed custom messages (regression risk)
- Heartbeat timeout (real lifecycle issue)
- Disk-full on save (real, embarrassing if not handled)

- Realistic workflow sequences
- Stress sequences
- Adversarial sequences (state machine edge cases)
- Replay sequences (initially empty; populated as bugs are found)

- Layers A-C on every commit
- Layer D nightly
- Layer E nightly
- Layer F weekly

- Week 1: doc-mining, project skeleton, fork setup (as before)
- Week 2: parallel — mock kernel infrastructure (steps 1-3) alongside other implementation
- Week 3: property-based tests and fault injection (steps 4-5) alongside continued implementation
- Week 4: test corpus (step 6) alongside integration work
- Week 5: CI integration, end-to-end testing, polish
- Week 6: ship-readiness

1. Layered test architecture: doc-driven contracts, mocked unit tests, integration tests, Markov simulation, fault injection, stress tests. Each layer at appropriate CI cadence.
2. Mock kernel implements the Jupyter protocol from the kernel side, configurable, drivable.
3. State machine as data, not code. Easy to extend, debuggable, documents the protocol.
4. Property-based testing via hypothesis for invariants. Random and targeted sequences.
5. Fault injection as configuration on the mock kernel. Drop, delay, corrupt, crash, hang. Tunable probabilities.
6. Test corpus includes realistic workflows, stress, adversarial, and replay sequences. All five categories.
7. CI runs different layers at different cadences. Fast layers per-commit; slow layers nightly.
8. Mock kernel is Python, drives both Python and TypeScript test sides.
9. Properties are documented alongside code. Each property cites the doc section it verifies.
10. Initial fault probabilities calibrated to realism. Not maximalist; reflects real failure rates.

- Doc-driven tests verify each interaction conforms to spec
- Mocks let you test handlers in isolation
- Markov simulation generates realistic and adversarial sequences
- Fault injection verifies recovery from real-world failures
- Property-based testing catches invariant violations across generated sequences

1. Layered architecture committed: docs, mocks, simulation, fault injection, properties, regression.
2. Mock kernel built in Python, used by Python and TypeScript tests.
3. State machine as data, easy to extend.
4. Hypothesis for property-based testing on sequences.
5. Fault types and probabilities calibrated to realism.
6. CI cadence varies by layer: fast on every commit, slow nightly.
7. Test corpus categories: workflows, random, stress, adversarial, replay.
8. Properties documented alongside code, citing doc sections.

