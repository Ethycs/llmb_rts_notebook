# Discipline: Certified magic emitter

**Status**: discipline (V1 standard; the dual of the emission ban — defines which code paths may produce dispatchable magic syntax)
**Source specs**: [PLAN-S5.0.1 §3.3](../../notebook/PLAN-S5.0.1-cell-magic-injection-defense.md#33-output-sanitizer-wrapper--vendorllmkernelllm_kernelsocket_writerpy-modest) (the emission-ban chokepoint this standard inverts), [PLAN-S5.0.1 §3.7](../../notebook/PLAN-S5.0.1-cell-magic-injection-defense.md#37-cell-manager-re-stamping) (`restamp_with_pin` as a certified emitter), [PLAN-S5.0 §3.8](../../notebook/PLAN-S5.0-cell-magic-vocabulary.md#38-cell-manager-text-operations--vendorllmkernelllm_kernelcell_managerpy-new-80-loc) (Cell Manager text primitives), [PLAN-S5.0.2](../../notebook/PLAN-S5.0.2-magic-code-generators.md) (generator handlers, queued)
**Related atoms**: [discipline/magic-injection-defense](magic-injection-defense.md), [discipline/cell-manager-owns-structure](cell-manager-owns-structure.md), [discipline/text-as-canonical](text-as-canonical.md), [concepts/magic](../concepts/magic.md), [concepts/magic-code-generator](../concepts/magic-code-generator.md), [contracts/cell-manager](../contracts/cell-manager.md), [protocols/mcp-tool-call](../protocols/mcp-tool-call.md)

## The rule

A **certified magic emitter** is a code path the kernel allows to produce magic syntax (`@@<name>`, `@<name>`, or in hash mode `@@<HMAC(pin, name)>:<args>`) into `cells[<id>].text` — the canonical source the parser dispatches. Every other code path is subject to the [emission ban](magic-injection-defense.md): any magic-shaped output from agent stdout/stderr, tool result, MCP message, synthetic span, or kernel notify text MUST be sanitized before it crosses into a surface a parser will read.

Certification is **structural**, not a human-trust judgment. A path is certified iff it mechanically satisfies the five clauses below; no manual blessing exists. The standard ratifies the emitters that already route through Cell Manager / serializer / generator handlers and forbids new emission paths from being added without meeting the same gate.

## The standard — five clauses

An emitter is certified iff it satisfies ALL five:

1. **Operator-rooted intent.** The emission's causal chain originates in operator-typed cell text, an operator-action intent ([protocols/operator-action](../protocols/operator-action.md)), or an MCP tool invocation by an agent the operator has granted a *magic-emit privilege* — never in raw agent stdout/stderr, tool result text, or any other channel that ingests untrusted prose. Magic code generators are the recursive case: they execute *because* the operator typed `@@template` / `@@expand` / `@@import`. Privileged agents are the delegated case: the operator's grant authorizes a specific `agent_id` to invoke the structural emit channel (clause 2), but the agent never types magic — it invokes it.
2. **Structural-write surface.** The emitter writes through Cell Manager text-mutation primitives ([contracts/cell-manager](../contracts/cell-manager.md)) or the writer's serializer — never through `socket_writer.append_output`. Cell outputs are the agent's surface; cell text is the operator's. Cross-mixing is a structural-ownership violation per [cell-manager-owns-structure](cell-manager-owns-structure.md).
3. **Hash-mode aware.** When `magic_hash_enabled == true`, the emitter computes valid `HMAC(pin, name)` for every magic line it writes and uses the `emit_magic_line()` helper (or equivalent direct `magic_hash()` call) — never hard-codes `@@<name>` plain. Body text the emitter produces that happens to *look* like magic is escaped (`\@@<...>`) or passed through `strip_hash_from_line` before it crosses into any agent-visible surface.
4. **Provenance-preserving.** When the emitter inserts new cells, every inserted cell carries `generated_by` + `generated_at` per [magic-code-generator](../concepts/magic-code-generator.md). Re-stamping operations (e.g. `restamp_with_pin`) preserve operator authorship — they rewrite hashes for existing magics but never invent new magics or new cells on the operator's behalf.
5. **Round-trip stable.** Emitted text round-trips through [parse-cell](../operations/parse-cell.md) to an equivalent `ParsedCell` per [text-as-canonical](text-as-canonical.md). Emitters that produce malformed cells fail loudly (K3I `generator_handler_produced_invalid_hash` / K3J `generator_provenance_missing`); they do NOT silently land partial cells.

## V1 certified emitters

| Emitter | Path | What it emits | Hash-mode tooling |
|---|---|---|---|
| Operator typing | cell editor → save | any magic the operator types | none at type time; kernel re-stamps on save via `restamp_with_pin` |
| `cell_manager` text primitives | `set_cell_kind` / `insert_line_magic` / `remove_line_magic` / `split_at_break` / `merge_cells` | mutated `cells[<id>].text` per the structural API | `emit_magic_line()` for `@@<kind>` declarations |
| `cell_manager.restamp_with_pin` | `@@auth set <pin>` / `@@auth rotate <new>` | re-hashed magic lines across every cell, atomically | direct `magic_hash(pin, name)` per registered name |
| Magic code generator handlers (V2+) | `@@template` / `@@expand` / `@@import` per [PLAN-S5.0.2](../../notebook/PLAN-S5.0.2-magic-code-generators.md) | new cells inserted after the generator cell | `emit_magic_line()`; mandatory `generated_by` provenance |
| Privileged agent via MCP tool (V2+) | agent invokes `emit_magic_cell(name, args, …)` per [protocols/mcp-tool-call](../protocols/mcp-tool-call.md); kernel handler routes through Cell Manager | a new cell with `@@<name> <args>` and `generated_by: <agent_id>` provenance | `emit_magic_line()` inside the kernel-side tool handler; the agent never sees the hash |
| Writer serializer | `MetadataWriter.save` | the canonical `.llmnb` text emission for every cell | byte-stable; relies on existing `cells[<id>].text` (no fresh hashing) |

Anything not in this table is **uncertified by default**. Adding a new entry requires the path to satisfy the five clauses *and* an inbound link from this atom recording the addition.

## What this rules out

| Anti-shape | Why forbidden |
|---|---|
| `cells[<id>].outputs.append("@@spawn ...")` from any code path | Fails clause 2 (structural-write surface). Layer-2 emission ban catches it; K3A fires. |
| Agent stdout containing `@@<name>` lines, no matter how trustworthy the agent | Fails clause 1 (operator-rooted intent). Layer-1 contamination flag fires; in hash mode the line is escaped per Layer-2. |
| Kernel-side notify/escalate code that writes "type `@@spawn alpha`…" into a cell output | Fails clause 2. Re-route via Cell Manager (insert a new cell) or render in a non-output surface (toast / status line / sidebar chip). |
| Generator handler that emits `@@<name>` plain while hash mode is on | Fails clause 3. K3I (`generator_handler_produced_invalid_hash`). |
| New cell created by any path without `generated_by` provenance | Fails clause 4. K3J (`generator_provenance_missing`). |
| "Fix-up" pass that rewrites `cells[<id>].text` outside Cell Manager | Fails clause 2 AND [cell-manager-owns-structure](cell-manager-owns-structure.md). No commit, no history mode, no validators. |
| Operator flag exempts a specific agent's stdout/stderr from sanitization | Wrong axis. Privileging an agent grants a *channel* (the `emit_magic_cell` MCP tool); it never widens the *stream*. Stdout-based emission stays banned regardless of grant. K3A still fires on any magic-shaped line in the output stream. |
| Privileged agent invokes `emit_magic_cell` from a zone whose operator did NOT grant the privilege | Privilege is per-(operator, agent_id, zone) — granting an agent in one notebook does not transfer to another. Tool call rejects with K3K (`unprivileged_agent_magic_emit`). |
| Approved-author allowlist trusting an agent's prose by model name or vendor | Wrong axis. Certification is a property of code paths and channels, not of speakers. The prose surface is structurally banned even from privileged agents. |

## What this rules in

- A single chokepoint per surface: emit through Cell Manager or the serializer; never through the output writer. The dual chokepoint of `socket_writer.append_output` for the ban gives the project two grep-able invariant lines.
- Clauses 1–2 are mechanically lintable: grep the kernel for `cells[*].outputs.append(` taking any magic-shaped literal; grep for direct writes to `cells[*].text` that are not in `cell_manager.py` / serializer.
- The certified set is enumerable and small. New entries require a code-review trail because they edit this atom and its inbound consumers — drift surfaces in the docs graph before it surfaces in production.
- The hash-mode pin is the structural guarantee that an attacker outside the certified set cannot forge clause 3 — they don't hold the HMAC key, so any magic-shaped line they emit decomposes to body via `strip_hash_from_line` at every agent-visible boundary.

## Stream emissions by agents (banned but observed)

The ban does not make stream emissions go away — it makes them detectable. Agents WILL emit magic-shaped lines into stdout/stderr: an LLM explaining magic syntax in tutorial prose, an injected tool result, a malicious upstream document, or a privileged agent that "forgot" to invoke `emit_magic_cell` and just typed the magic in its reply. The standard must describe how the kernel handles each case, not pretend they don't happen.

| Source | Hash mode off | Hash mode on |
|---|---|---|
| Unprivileged agent stream | Layer-1 contamination flag set on receiving cell; line lands in `cells[<id>].outputs` as text. Parser ignores (outputs are never parsed). | Layer-2 sanitizer escapes leading `@` → `\@`; line stored escaped; K3A (`hashed_magic_emission_ban`) fires; contamination flag set. |
| Privileged agent stream (privilege held but unused) | Same Layer-1 handling, PLUS K3L (`privileged_agent_stream_magic`) — informational marker. Operator-facing **promotion chip** appears: *"Agent {id} emitted `@@spawn beta` via stream. Promote to tool call?"* | Same Layer-2 handling, PLUS K3L + the promotion chip. The escaped form remains in outputs regardless of operator action. |
| Tool result text quoting magic syntax | Treated as agent stream (writes flow through the same `socket_writer.append_output` chokepoint). | Same. |

The **promotion chip** is the recovery affordance for privileged agents: when a privileged `agent_id` stream-emits a syntactically-valid magic line, the kernel surfaces a one-click control on the cell badge. Operator clicks → kernel synthesizes an `emit_magic_cell(name, args, …)` invocation **on the operator's behalf** (clause 1 satisfied by the click, not the stream); the call routes through Cell Manager (clause 2); the new cell carries `generated_by: <agent_id>` and a `promoted_from_stream: true` provenance flag (clause 4). Without the click, nothing dispatches — the sanitized line stays in outputs and never reaches a parser.

The carve-out preserves every clause. The stream remains banned, the channel remains the only certified emission path, the promotion gesture is itself an operator action subject to all the same rules. The chip only makes privileged agents more *forgiving* of LLM forgetfulness; it never widens the threat model. Unprivileged agents get no chip — their stream emissions stop at sanitization.

## Why "certification," not "trust"

The word *certified* is structural. It does NOT mean a human reviewed the emitter and decided it's safe; it means the path mechanically satisfies clauses 1–5. The standard exists so the question "is this code allowed to emit magic?" reduces to a checklist, not a judgment call. An "approved emitter" list maintained by hand drifts; a structural test does not.

The stream/channel distinction is the load-bearing idea: **an agent's stdout/stderr stream is permanently banned**, because it ingests untrusted prose and is the prompt-injection attack surface. An agent may, however, be granted a **structural emit channel** — the `emit_magic_cell` MCP tool. The agent invokes the tool (a JSON-RPC call with typed args, validated by the schema); the kernel's handler routes the request through Cell Manager and stamps `generated_by: <agent_id>` on the resulting cell. The agent never types magic; it requests it. Operator authorizes the request via the privilege grant; clause 1 is satisfied by that grant, not by the agent's identity. Certification is a property of code paths and channels, not of speakers — but a path may be opened *to* a speaker by operator action, under structural rules the speaker cannot bend.

The kernel's emission ban remains non-negotiable on the prose surface, even for privileged agents; the operator's only escape hatch from the ban itself is the verbatim acceptance string per [PLAN-S5.0.1 §3.11](../../notebook/PLAN-S5.0.1-cell-magic-injection-defense.md#311-refusal-flag--verbatim-injection-acceptance), which doesn't certify anything — it merely records that the operator has opted out of protection.

## V1 vs V2+

- **V1 (post-S5.0.1)**: operator typing, Cell Manager primitives, `restamp_with_pin`, writer serializer.
- **V2+**: generator handlers ship per [PLAN-S5.0.2](../../notebook/PLAN-S5.0.2-magic-code-generators.md). Privileged-agent emission lands as the `emit_magic_cell` MCP tool — operator grants the privilege via an operator-action intent (`grant_magic_emit_privilege { agent_id, zone_id, scope }`), the kernel records it in `metadata.rts.config.magic_emit_privileges[]`, and the supervisor exposes the tool only to the named agent. Privileged emissions appear in History mode like any overlay commit and carry `generated_by: <agent_id>` provenance. K3K rejects unprivileged invocations; K3L marks the stream-promotion case so the audit trail distinguishes invoked-tool from promoted-stream cells. The promotion chip is the operator-action `promote_stream_magic { cell_id, line }` that synthesizes the tool call.
- **V3+**: per-tool capability scopes (only certain magics emittable by a given agent); per-emitter audit log surfacing every line that flowed through a certified path; cross-notebook generator pipelines.

## See also

- [discipline/magic-injection-defense](magic-injection-defense.md) — the emission ban this standard is the structural dual of
- [discipline/cell-manager-owns-structure](cell-manager-owns-structure.md) — clause 2's parent rule
- [discipline/text-as-canonical](text-as-canonical.md) — clause 5's round-trip invariant
- [concepts/magic](../concepts/magic.md) — the vocabulary being emitted
- [concepts/magic-code-generator](../concepts/magic-code-generator.md) — the operator-designated recursive case (clause 1)
- [contracts/cell-manager](../contracts/cell-manager.md) — clause 2's structural-write API
- [protocols/mcp-tool-call](../protocols/mcp-tool-call.md) — the channel privileged agents use to invoke `emit_magic_cell`
- [operations/parse-cell](../operations/parse-cell.md) — clause 5's parse target
- [PLAN-S5.0.1](../../notebook/PLAN-S5.0.1-cell-magic-injection-defense.md) — defines `restamp_with_pin`, `emit_magic_line()`, the emission-ban sanitizer, and K3A/K3I/K3J
- [PLAN-S5.0.2](../../notebook/PLAN-S5.0.2-magic-code-generators.md) — queued slice for generator handlers
