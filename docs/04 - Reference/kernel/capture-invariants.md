# Capture invariants — the "what to defend" charter

**Status**: reference (slice 1). Invariants verified against submodule
`vendor/LLMKernel/llm_kernel/` at the pin recorded in the repo root.
**Related**: [`README.md`](README.md) (folder purpose),
[`identity-model.md`](identity-model.md) (the identifiers these spans carry),
[RFC-004](../../05%20-%20Standards/rfcs/RFC-004-failure-modes.md) (failure
taxonomy + K-class), [RFC-007](../../05%20-%20Standards/rfcs/RFC-007-tape-otlp-logs.md)
(tape + OTLP logs).

## What this doc is for

The LLMKernel is a **legibility substrate for agentic work**: every byte
an agent emits is captured with provenance, every failure mode has a
name, and nothing the operator needs to see disappears. That trust
rests on a small set of *load-bearing capture properties*. This file is
the single place a contributor can read to learn **which properties are
load-bearing and what breaks if they touch them.**

Each invariant below states the property precisely, cites the enforcing
`file:line` in `vendor/LLMKernel/llm_kernel/`, explains the legibility
guarantee it protects, and gives an explicit **"if you touch X, do NOT
break Y"** warning aimed at the code sites a contributor would plausibly
edit.

These are not style preferences. Each is a property some downstream
consumer (agent supervision, the notebook renderer, forensic replay)
depends on for correctness. Breaking one does not throw — it silently
degrades the substrate's trustworthiness, which is the one thing the
kernel exists to provide.

## The invariants at a glance

| # | Invariant | Property in one line | Enforcing site |
|---|---|---|---|
| [1](#1-every-byte-resets-watchdog) | every-byte-resets-watchdog | The silence/liveness watchdog is reset on **any** output byte, not on line or JSON boundaries. | [`supervision/agent_supervisor.py:1791`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py) |
| [2](#2-malformed-lines-as-spans) | malformed-lines-as-spans | Non-JSON / unparseable agent output is captured as an `agent_emit` span of kind `malformed_json`, never dropped and never crashing the reader. | [`supervision/agent_supervisor.py:1801`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py) |
| [3](#3-tape--spans-raw-is-canonical-parsed-is-derived) | tape + spans | The raw byte stream is preserved verbatim alongside the parsed spans; raw is canonical, parsed is derived. | [`supervision/agent_supervisor.py:1806`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py), [`capture/_otlp_log_handler.py:48`](../../../vendor/LLMKernel/llm_kernel/capture/_otlp_log_handler.py) |
| [4](#4-no-silent-drops) | no-silent-drops | Nothing is discarded silently; overflow and failure are surfaced (archive tails, checkpoint markers, K-coded responses, logged event names). | [`capture/metadata_writer/_writer.py:313`](../../../vendor/LLMKernel/llm_kernel/capture/metadata_writer/_writer.py) |
| [5](#5-k-class-taxonomy) | K-class taxonomy | Every capture/emission failure carries a stable `Kxx` code from one shared taxonomy, so failures are named rather than anonymous. | [`capture/metadata_writer/_writer.py:936`](../../../vendor/LLMKernel/llm_kernel/capture/metadata_writer/_writer.py) |

---

## 1. every-byte-resets-watchdog

**Property.** The silence (hang-detection) watchdog fires only on *true
silence* — no output at all for longer than the threshold. It is reset
on **every** line read from the agent's stdout, *including empty lines*
and *including lines the JSON parser rejects*. Liveness is measured in
bytes seen, never in successfully-parsed frames.

**Enforced at.**

- Reset on every read, before any filtering:
  [`supervision/agent_supervisor.py:1791`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py)
  — `handle._last_stdout_ts = time.monotonic()`. Critically this runs
  **before** the empty-line skip at line 1796 (`if not line: continue`)
  and **before** the parse at line 1798. The ordering is the invariant.
  The intent comment sits directly above it (lines 1788–1790: "every
  byte on stdout (even an empty line) resets the silence timer, so the
  watchdog only fires on true silence, not on parser-rejection
  silence").
- The timestamp field and its contract:
  [`supervision/agent_supervisor.py:110`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py)
  (`_last_stdout_ts`).
- The reader of that timestamp:
  [`supervision/agent_supervisor.py:1971`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py)
  — `silence = time.monotonic() - handle._last_stdout_ts` inside
  `_silence_watchdog` (defined at line 1948; threshold
  `DEFAULT_AGENT_SILENCE_THRESHOLD_SEC = 120.0` at line 52).
- Seeded to spawn time so a fresh agent gets the full first-byte budget:
  [`supervision/agent_supervisor.py:1737`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py);
  re-seeded on crash-restart at
  [`supervision/agent_supervisor.py:1926`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py).

**Why it is load-bearing.** A well-behaved agent legitimately emits a
long run of output that the kernel cannot parse (progress chatter,
partial frames, a burst of prose). If liveness were measured on
*parsed* frames, such an agent would be SIGTERMed for "hanging" while
actively working — and the crash-restart machinery
([`_watchdog`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py),
three restarts per five-minute window) would eventually mark it failed.
The whole point of the substrate is that *unstructured output is still
output*: an agent that is talking is alive. This invariant is what makes
malformed-lines-as-spans (invariant 2) safe — the two are a pair.

**If you touch the stdout reader (`_read_stdout`), do NOT:**

- Move the `_last_stdout_ts` assignment below the `if not line: continue`
  guard (line 1796) or below the parse call (line 1798). That would make
  empty lines — and, worse, unparseable lines — stop resetting the
  watchdog, resurrecting exactly the "parser-rejection silence" false
  positive the comment warns against.
- Gate the reset on a successful parse, on line content, or on emit-kind.
- Change the reader to consume in blocks/batches without updating the
  timestamp per block; the watchdog assumes the timestamp advances
  whenever bytes arrive.

**If you touch the watchdog (`_silence_watchdog`), do NOT** compare
against anything other than `_last_stdout_ts`, and do not lengthen the
poll granularity past the threshold — the watchdog must observe silence
within one threshold window.

---

## 2. malformed-lines-as-spans

**Property.** A stdout line that parses as neither MCP JSON-RPC nor
Claude stream-json is **not** dropped and does **not** crash the reader.
It is captured as an `agent_emit` span of kind `malformed_json`,
carrying the verbatim line plus a short parser diagnostic (decoder
message + byte position). stderr is handled the same way: every line
becomes an `agent_emit` span of kind `stderr`.

**Enforced at.**

- The malformed branch:
  [`supervision/agent_supervisor.py:1801`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py)
  — `if parsed is None:` → `_emit_agent_emit(handle,
  emit_kind="malformed_json", emit_content=line,
  parser_diagnostic=parse_error)` (lines 1801–1808), then the line is
  still counted toward the prose-flood threshold via `_handle_violation`
  (line 1809).
- The tolerant parser that produces the diagnostic instead of raising:
  [`supervision/agent_supervisor.py:2387`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py)
  — `_try_parse_json_with_error` catches `json.JSONDecodeError` and
  returns `(None, "<msg> at position <pos>")`; a non-object top-level
  JSON is also rejected as a diagnostic, not an exception (lines
  2396–2402).
- stderr as spans:
  [`supervision/agent_supervisor.py:1838`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py)
  — every non-empty stderr line becomes an `agent_emit` span of kind
  `stderr` (the docstring at line 1825 states the rule: "the data must
  reach the operator surface — no silent drops").
- The span emitter:
  [`supervision/agent_supervisor.py:2670`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py)
  — `_emit_agent_emit` records the diagnostic in span metadata under
  `parser_diagnostic` (line 2704).

**Why it is load-bearing.** An agent that emits garbage is telling you
something — a crash dump, a stack trace, a half-written frame, a prose
violation of the force-tool-use discipline
([DR-0010](../../02%20-%20Implementation/decisions/0010-force-tool-use-suppress-text.md)).
If the reader dropped unparseable lines, that signal would vanish; if it
raised, one bad line would kill the reader thread and blind the kernel
to everything the agent said afterward. Capturing malformed output *as a
typed span* keeps it on the same wire, same provenance, same renderer
path as well-formed output — the operator sees the garbage, tagged as
garbage, in context. This is the concrete guarantee behind the
[span](../atoms/concepts/span.md) atom's claim that a span is emitted
"for every byte of agent output that bypasses structured channels."

**If you touch `_read_stdout` or `_try_parse_json_with_error`, do NOT:**

- Add a `continue`/`return`/`raise` on the parse-failure path that skips
  `_emit_agent_emit`. A dropped malformed line is an invisible failure —
  the worst kind for a legibility substrate.
- Let a parser exception escape `_try_parse_json_with_error`. It must
  keep returning `(None, diagnostic)` for *every* input; a new parser
  (e.g. a third frame format) must fail closed into the `malformed_json`
  branch, not throw.
- Drop the `parser_diagnostic` from the emitted span. The byte position
  is how an operator locates the failing byte in the raw tape.

---

## 3. tape + spans (raw is canonical, parsed is derived)

**Property.** The raw bytes the kernel captured are preserved verbatim
alongside the parsed/structured view. The structured spans are a
*derivation* of the raw stream, never a replacement for it. When the two
disagree, raw wins.

**Enforced at.**

- Verbatim raw carried inside the span itself:
  [`supervision/agent_supervisor.py:1806`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py)
  (`emit_content=line`) and
  [`supervision/agent_supervisor.py:1839`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py)
  (stderr `emit_content=line`) — the span always carries the original
  text, not a re-serialized approximation.
- stderr raw stream written to a per-agent log file, always:
  [`supervision/agent_supervisor.py:1829`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py)
  (`log_path.open("a")` → `fh.write(raw)` at line 1833).
- Raw stdout byte log (opt-in, per RFC-007 opt-in posture):
  [`supervision/agent_supervisor.py:1793`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py)
  — when `LLMKERNEL_DEBUG_STDOUT=1`, every raw line is appended to
  `agent.stdout.<id>.log` (line 1795) *before* parsing.
- The forensic raw layer as a signal on the data plane:
  [`capture/_otlp_log_handler.py:48`](../../../vendor/LLMKernel/llm_kernel/capture/_otlp_log_handler.py)
  — `OtlpDataPlaneHandler` ships raw kernel LogRecords as OTLP/JSON logs,
  the V1 substrate for the `.tape` file
  ([RFC-007](../../05%20-%20Standards/rfcs/RFC-007-tape-otlp-logs.md)).

**Why it is load-bearing.** This is the capture-layer expression of the
[text-as-canonical](../atoms/discipline/text-as-canonical.md) discipline:
one artifact is the source of truth and every other view is re-derivable
from it. If the parsed span were canonical, a parser bug or a schema
migration would *rewrite history* — the operator could no longer trust
that what they see is what the agent actually emitted. Keeping raw
canonical means every structured view is auditable against the bytes,
and a future parser can re-derive better spans from the same tape
without data loss. It is also what makes malformed-lines-as-spans
(invariant 2) honest: the `malformed_json` span carries the raw line, so
"we couldn't parse this" never means "we lost this."

**Scope note (be precise here).** The full `.tape` forensic file is
[RFC-007](../../05%20-%20Standards/rfcs/RFC-007-tape-otlp-logs.md), which
is **queued, not yet a normative spec** — do not implement against it.
What V1 *already enforces* is the underlying property: the raw line is
never discarded on the way to a span (it is the span's `emit_content`),
stderr's raw stream is always logged, and the OTLP log handler exists as
the raw-observability sink. The stdout raw *byte* log is opt-in
(`LLMKERNEL_DEBUG_STDOUT`), matching RFC-007's opt-in posture; the raw
*content* is unconditional because it lives in the span.

**If you touch the readers or `_emit_agent_emit`, do NOT:**

- Replace `emit_content=line` with a normalized / re-serialized / parsed
  form. The span must carry the bytes as read. (The one sanctioned
  transform is the magic-injection escape in
  `_scan_and_rewrite_emit_content`, which is a security control on
  *emission into cells*, not a rewrite of the captured record — keep any
  such transform additive and reversible, never lossy.)
- Make the parsed span the only persisted artifact and treat the raw
  line as throwaway. If you add a new capture channel, add the raw sink
  in the same change.
- Invert the derivation direction — deriving raw *from* parsed spans (or
  reconstructing "raw" by re-serializing a span) breaks the audit
  guarantee even if the bytes happen to match today.

---

## 4. no-silent-drops

**Property.** Nothing the operator might need is discarded silently.
When a bounded buffer overflows or an operation fails, the loss is
*surfaced* — as an archive tail, an on-disk checkpoint marker + snapshot,
a K-coded failure response, and/or a logged event with a stable
`event.name`.

**Enforced at.**

- Event-log overflow archives rather than deletes:
  [`capture/metadata_writer/_writer.py:237`](../../../vendor/LLMKernel/llm_kernel/capture/metadata_writer/_writer.py)
  — when `event_log` exceeds `event_log_max_entries`, the overflow tail
  is moved to `event_log_archive[]` (lines 238–243), not dropped.
- Queue-cap overflow drops a checkpoint marker + direct-writes a
  snapshot, then logs a `metadata.queue_overflow` event:
  [`capture/metadata_writer/_writer.py:313`](../../../vendor/LLMKernel/llm_kernel/capture/metadata_writer/_writer.py)
  — `record_run` builds a marker with `queue_size_at_overflow`
  (lines 333–354), writes the fallback snapshot to disk (line 362), and
  emits the `logger.warning` with `event.name = "metadata.queue_overflow"`
  (lines 370–378). (The log is deliberately moved *outside* the lock per
  the [rlock-logging](../atoms/anti-patterns/rlock-logging.md)
  anti-pattern.)
- Failures are returned as structured, counted responses, not swallowed:
  [`capture/metadata_writer/_writer.py:933`](../../../vendor/LLMKernel/llm_kernel/capture/metadata_writer/_writer.py)
  — `_intent_failure` returns `{applied: false, error_code, error_reason,
  ...}` and logs a named marker.
- stderr never silently collapses:
  [`supervision/agent_supervisor.py:1825`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py)
  — "Renderers may collapse stderr by default, but the data must reach
  the operator surface — no silent drops."
- Hang detection surfaces the kill:
  [`supervision/agent_supervisor.py:1978`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py)
  — a hang emits one error-level `agent.hang_detected` event carrying
  the silence duration before the SIGTERM.

**The one sanctioned exception (know it, don't widen it).**
`capture_envelope` **does** silently drop *structurally malformed*
envelopes on the hot path:
[`capture/metadata_writer/_writer.py:211`](../../../vendor/LLMKernel/llm_kernel/capture/metadata_writer/_writer.py)
(the `if not isinstance(envelope, dict): return` / non-string
`message_type` guards at lines 214–218). This is justified only because
**the wire layer already validated the envelope** before it reaches this
sink — the drop is defensive belt-and-suspenders, not the primary
validation. This exception is narrow. Do not cite it as license to drop
anything that has *not* already been validated and surfaced upstream.

**Why it is load-bearing.** A silent drop is a hole in the record that
no consumer can detect. Agent supervision decides whether to restart or
escalate based on what it can see; forensic replay
([RFC-007](../../05%20-%20Standards/rfcs/RFC-007-tape-otlp-logs.md))
reconstructs history from the event log; the operator trusts that an
empty cell means the agent said nothing, not that the kernel lost it.
"Fails CLOSED, no silent retries" is the reliability posture of the
whole system per
[RFC-004](../../05%20-%20Standards/rfcs/RFC-004-failure-modes.md); this
invariant is that posture at the capture layer.

**If you touch the buffers or overflow paths, do NOT:**

- Turn an archive into a plain truncation. If you make `event_log`,
  `event_log_archive`, or `_extra_runs` more aggressively bounded,
  preserve the checkpoint-marker + snapshot fallback so the tail is
  recoverable and the overflow is logged with its `event.name`.
- Replace a K-coded failure response with a bare `return`/`None` or a
  swallowed exception. Every rejection must carry a code and a reason
  (see invariant 5).
- Broaden the `capture_envelope` malformed-drop to inputs that were not
  already wire-validated, or drop them without the upstream surface.

---

## 5. K-class taxonomy

**Property.** Every capture/emission failure is named with a stable
`Kxx` code drawn from one shared taxonomy, rather than surfaced as an
anonymous exception, a generic boolean, or a bare log line. The code is
the operator's and the test harness's stable handle on "what went
wrong."

**Enforced at.** The taxonomy is distributed across the subsystems that
can reject, but the discipline is uniform — a rejection carries a `Kxx`
`error_code`:

| K-code range | Subsystem | Site |
|---|---|---|
| `K30`/`K31` (raise), `K33`/`K35` (advisory) | Cell-text / magic parse | [`text/cell_text.py:342`](../../../vendor/LLMKernel/llm_kernel/text/cell_text.py) — advisory emissions appended to `cell.k_class_emissions` (field at [line 136](../../../vendor/LLMKernel/llm_kernel/text/cell_text.py)); rules described at lines 280–294. |
| `K40`–`K43` | Intent apply (metadata writer) | [`capture/metadata_writer/_writer.py:936`](../../../vendor/LLMKernel/llm_kernel/capture/metadata_writer/_writer.py) — the `_intent_failure` marker map: `K40` unknown kind, `K41` CAS rejected, `K42` validation failed, `K43` zone write failed (lines 937–942; contract at 528–533). |
| `K90`–`K95` | Overlay structural ops | [`capture/overlay_applier/_validators.py:23`](../../../vendor/LLMKernel/llm_kernel/capture/overlay_applier/_validators.py) — e.g. `K90` move/section, `K93` merge_cells, `K94` split_cell, `K95` cell-is-executing; raised as `_OverlayRejected` and caught into an `error_code` at [`_writer.py:676`](../../../vendor/LLMKernel/llm_kernel/capture/metadata_writer/_writer.py) (lines 676–697). |
| `K100`/`K101` (and `K103`) | Context packer | [`capture/context_packer.py:60`](../../../vendor/LLMKernel/llm_kernel/capture/context_packer.py) — `K100OrphanCellError` (cell not in overlay), `K101` section-parent cycle (taxonomy at lines 26–29). |

**Why it is load-bearing.** Named failure modes are the difference
between "something broke" and a *legible* failure. The K-code is a
contract: [RFC-004](../../05%20-%20Standards/rfcs/RFC-004-failure-modes.md)
pins the failure taxonomy and its log signatures; the fault-injection
harness asserts on codes; the renderer dispatches operator-facing error
tiles on them; a contributor grepping for `K42` finds every site that
can produce it. A failure without a code is a failure no test can pin
and no operator can look up — it is exactly the anonymous, un-triageable
failure the substrate exists to eliminate. The split between *raising*
codes (K30/K31 — cell unparseable) and *advisory* codes (K33/K35 —
appended to `k_class_emissions`, line falls through to body) is itself
load-bearing: advisory codes keep parsing legible without halting it.

**If you add or change a capture/emission failure, do NOT:**

- Introduce a new failure mode without a `Kxx` code, or reuse an
  existing code for an unrelated condition. Allocate a new code and
  record it in the subsystem's taxonomy block **and** in
  [RFC-004](../../05%20-%20Standards/rfcs/RFC-004-failure-modes.md).
- Collapse a K-coded response into a generic exception or a bare
  `False`/`None`. The code must reach the caller in the response's
  `error_code` field (see `_intent_failure`, invariant 4).
- Promote an advisory code (K33/K35) to a raise, or demote a raising
  code (K30/K31) to advisory, without checking every consumer — some
  iterate `k_class_emissions` *after* a successful parse and assume the
  cell still parsed.

---

## See also

- [`README.md`](README.md) — why this folder exists; the substrate framing.
- [`identity-model.md`](identity-model.md) — the identifiers every captured span carries.
- [concepts/span](../atoms/concepts/span.md) — the unit malformed and raw output is captured as.
- [discipline/text-as-canonical](../atoms/discipline/text-as-canonical.md) — the "raw/source is canonical, parsed is derived" discipline that invariant 3 mirrors.
- [discipline/wire-as-public-api](../atoms/discipline/wire-as-public-api.md) — the wire contract these spans cross.
- [anti-patterns/rlock-logging](../atoms/anti-patterns/rlock-logging.md) — why the overflow warning logs outside the lock (invariant 4).
- [anti-patterns/secret-redaction](../atoms/anti-patterns/secret-redaction.md) — capture must never persist secrets; `reject_secrets` guards the writer.
- [RFC-004](../../05%20-%20Standards/rfcs/RFC-004-failure-modes.md) — normative failure taxonomy + K-class + "fails CLOSED" posture.
- [RFC-007](../../05%20-%20Standards/rfcs/RFC-007-tape-otlp-logs.md) — the `.tape` raw-observability layer (queued; invariant 3's forensic endpoint).
