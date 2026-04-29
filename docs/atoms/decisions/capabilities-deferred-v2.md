# Decision: Capabilities table and privilege levels deferred to V2

**Status**: decision (V1 lock-in, 2026-04-28)
**Source specs**: [KB-notebook-target.md §0.7](../../notebook/KB-notebook-target.md#07-capabilities--v2), [KB-notebook-target.md §20](../../notebook/KB-notebook-target.md#20-permissions-and-trust), [BSP-002 §13.5.1](../../notebook/BSP-002-conversation-graph.md#1351-metadatartscellsidcapabilities-kb-target-07--v2), [PLAN-atom-refactor.md §4](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms)
**Related atoms**: [concepts/cell](../concepts/cell.md), [decisions/v1-runframe-minimal](v1-runframe-minimal.md)

## The decision

**V1 has one trust boundary** (operator → kernel → agents) and reserves `metadata.rts.cells[<id>].capabilities[]` as an empty array for V2 expansion. Per [KB-target §0.7](../../notebook/KB-notebook-target.md#07-capabilities--v2):

- The full capabilities table from [KB-target §20](../../notebook/KB-notebook-target.md#20-permissions-and-trust) — `read_context | read_files | write_files | run_commands | call_tools | call_agents | modify_overlay | checkpoint | export | access_secrets` — is **deferred to V2**.
- The five privilege levels — `view | draft | edit | execute | admin` — are **deferred to V2**.
- V1 ships the schema slot (`capabilities: []`) so V1-written `.llmnb` files round-trip through V2 producers without a major schema bump.
- The agent→tool boundary in V1 is governed entirely by RFC-001's `--allowedTools` flag passed to claude-code at spawn.

## Rationale

1. **Single-operator V1 has one trust boundary.** The operator runs the kernel locally; the kernel spawns agents the operator authored cells for. There is no second user, no shared workspace, no role to differentiate. A capabilities table is meaningful only when there's >1 actor whose permissions could differ.

2. **`--allowedTools` is sufficient for V1.** RFC-001 ships claude-code with an explicit allow-list of MCP tools. That's the only enforcement boundary V1 needs because the operator pre-authorizes the tool set at session start. Per-cell capabilities would re-litigate that decision on every cell run with no operator benefit in single-user mode.

3. **Reserving the slot keeps V2 additive.** Per [BSP-002 §13.5.1](../../notebook/BSP-002-conversation-graph.md#1351-metadatartscellsidcapabilities-kb-target-07--v2): V1 producers MUST write `capabilities: []`; V1 consumers MUST ignore non-empty arrays from forward producers. V2 fills the array; V2 readers enforce; V1-written files don't need migration.

4. **Per [Engineering Guide §11.3](../../../Engineering_Guide.md#113-premature-abstraction)**: building a privilege model before the use case arrives gives us an abstraction that doesn't fit the V2 reality. V2 collaboration mode will tell us whether the right axis is "privilege level" (RBAC) or "capability set" (capability-based) or both. Deferring lets that decision be informed.

## Operational consequences

| V1 behavior | Where enforced |
|---|---|
| Producers emit `metadata.rts.cells[<id>].capabilities: []` for every cell | [BSP-002 §13.7 validation summary](../../notebook/BSP-002-conversation-graph.md) |
| Consumers ignore non-empty `capabilities[]` arrays from forward producers | [BSP-002 §13.5.1](../../notebook/BSP-002-conversation-graph.md) |
| RunFrame `tool_permissions` field is NOT EMITTED in V1 | [v1-runframe-minimal](v1-runframe-minimal.md) |
| Tool authorization happens via RFC-001 `--allowedTools` at agent spawn | RFC-001 |
| Operator → kernel boundary: no per-action permission check; the operator IS the kernel's user | [KB-target §20](../../notebook/KB-notebook-target.md#20-permissions-and-trust) |
| Kernel → agent boundary: no per-call permission check; agents inherit the operator's authorization scope | [KB-target §20](../../notebook/KB-notebook-target.md#20-permissions-and-trust) |
| Agent → tool boundary: enforced by claude-code's `--allowedTools` allow-list | RFC-001 |

## V1 vs V2+

| | V1 | V2+ |
|---|---|---|
| `metadata.rts.cells[<id>].capabilities[]` | Always `[]`; ignored if non-empty | Populated with capability tokens; enforced |
| Privilege levels | None — operator is the only actor | `view | draft | edit | execute | admin` |
| Per-cell tool authorization | None — handled by claude-code spawn flags | Per-cell capability check before tool dispatch |
| RunFrame `tool_permissions` | Not emitted | Snapshot of capabilities active at run time |
| Multi-actor collaboration | Out of scope | Per-actor capability sets |

## What unlocks at V2

- **Read-only viewers**: a `view` privilege level that can browse the notebook but not run agents or mutate overlays.
- **Per-cell tool gating**: a cell that should not be able to call `run_commands` even though the agent can.
- **Audit trail**: RunFrames record which capabilities were active at run time, so retrospective compliance review is meaningful.
- **Secrets boundary**: `access_secrets` becomes a capability check rather than purely an env-var conventions per [anti-patterns/secret-redaction](../anti-patterns/secret-redaction.md).

None of this is V1-blocking; all of it ships additively when the multi-actor use case arrives.

## See also

- [concepts/cell](../concepts/cell.md) — the schema slot lives on cells.
- [decisions/v1-runframe-minimal](v1-runframe-minimal.md) — `tool_permissions` deferral is part of this same V2 bundle.
- [anti-patterns/secret-redaction](../anti-patterns/secret-redaction.md) — secrets stay env-only in V1; V2 capabilities formalize this.
- [KB-target §20](../../notebook/KB-notebook-target.md#20-permissions-and-trust) — the V2+ target model.
- [BSP-002 §13.5.1](../../notebook/BSP-002-conversation-graph.md#1351-metadatartscellsidcapabilities-kb-target-07--v2) — the schema slot reservation.
- [PLAN-atom-refactor.md §4](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms) — the 24-row decision table.
