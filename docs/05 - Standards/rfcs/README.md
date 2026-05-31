# RFC docket

The numbered RFCs that gate implementation, per [DR-0016](../../02%20-%20Implementation/decisions/0016-rfc-standards-discipline.md) and [chapter 08](../../01%20-%20Design/dev-guide/08-blockers-mediator-standards.md). Each RFC closes an integration risk at a process, language, storage, or version boundary.

The discipline is Bell-System-inspired: every RFC is normative, dated, version-numbered, and reviewed against a backward-compatibility class system before any implementation conforms to it. Implementations conform to the RFC; deviations require a spec update, not a code workaround.

## Layering

RFCs own public boundary contracts: wire envelopes, storage formats, process launch contracts, transport handshakes, and failure surfaces.

BSPs own notebook substrate behavior and implementation sequencing. FSPs own feature slice behavior and test campaign structure. Atoms own reusable definitions, schemas, operations, and discipline rules. When an RFC needs one of those concepts, it links to the BSP/FSP/atom and states only the boundary-specific requirement. It does not restate the full definition.

## Index

| # | Title | Status | Source ADRs |
|---|---|---|---|
| RFC-001 | V1 MCP tool taxonomy | Draft | [DR-0008](../../02%20-%20Implementation/decisions/0008-bidirectional-mcp-as-comm-channel.md), [DR-0010](../../02%20-%20Implementation/decisions/0010-force-tool-use-suppress-text.md), [DR-0015](../../02%20-%20Implementation/decisions/0015-kernel-extension-bidirectional-mcp.md) |
| RFC-002 | Claude Code provisioning procedure | Draft | [DR-0010](../../02%20-%20Implementation/decisions/0010-force-tool-use-suppress-text.md), [DR-0012](../../02%20-%20Implementation/decisions/0012-llmkernel-sole-kernel.md), [DR-0015](../../02%20-%20Implementation/decisions/0015-kernel-extension-bidirectional-mcp.md) |
| RFC-003 | Custom Jupyter message format | Superseded by RFC-006 | [DR-0009](../../02%20-%20Implementation/decisions/0009-notebook-controller-no-jupyter-kernel.md), [DR-0014](../../02%20-%20Implementation/decisions/0014-three-storage-structures-embedded.md), [DR-0015](../../02%20-%20Implementation/decisions/0015-kernel-extension-bidirectional-mcp.md) |
| RFC-004 | Failure-mode analysis and fault-injection harness | Draft | [DR-0013](../../02%20-%20Implementation/decisions/0013-v1-feasible-with-claude-code.md), [DR-0015](../../02%20-%20Implementation/decisions/0015-kernel-extension-bidirectional-mcp.md) |
| RFC-005 | `.llmnb` file format | Draft | [DR-0009](../../02%20-%20Implementation/decisions/0009-notebook-controller-no-jupyter-kernel.md), [DR-0014](../../02%20-%20Implementation/decisions/0014-three-storage-structures-embedded.md), [DR-0016](../../02%20-%20Implementation/decisions/0016-rfc-standards-discipline.md) |
| RFC-006 | Kernel↔extension wire format (v2; supersedes RFC-003) | Draft | [DR-0009](../../02%20-%20Implementation/decisions/0009-notebook-controller-no-jupyter-kernel.md), [DR-0015](../../02%20-%20Implementation/decisions/0015-kernel-extension-bidirectional-mcp.md), [DR-0016](../../02%20-%20Implementation/decisions/0016-rfc-standards-discipline.md) |
| RFC-007 | `.tape` files (OTLP/JSON Logs for raw kernel observability) | Queued | [DR-0016](../../02%20-%20Implementation/decisions/0016-rfc-standards-discipline.md) |
| RFC-008 | Kernel host integration (PTY + socket two-channel transport) | Draft | [DR-0009](../../02%20-%20Implementation/decisions/0009-notebook-controller-no-jupyter-kernel.md), [DR-0011](../../02%20-%20Implementation/decisions/0011-subtractive-fork-vscode-jupyter.md), [DR-0012](../../02%20-%20Implementation/decisions/0012-llmkernel-sole-kernel.md), [DR-0015](../../02%20-%20Implementation/decisions/0015-kernel-extension-bidirectional-mcp.md) |
| RFC-009 | Zone control and config precedence | Draft | [DR-0016](../../02%20-%20Implementation/decisions/0016-rfc-standards-discipline.md), [Engineering Guide §11.8](../../../Engineering_Guide.md#118-vs-code-config-priority-anti-pattern) |

## RFC document structure

Every RFC under this directory follows the same section layout:

1. **Status** — Draft / Accepted / Superseded by RFC-NNN; date; version.
2. **Context** — what forced the spec, citing the relevant ADRs.
3. **Specification** — the normative content (schemas, procedures, message catalogs, failure tables).
4. **Backward-compatibility analysis** — what counts as a breaking change vs. additive; how versions are signaled.
5. **Failure modes** — for runtime-behavior RFCs only; fault-tree per RFC-004's taxonomy.
6. **Worked example** — at least one end-to-end concrete example exercising the spec.
7. **Consumers** — which components depend on this RFC.
8. **Source** — ADRs and dev-guide chapters this RFC derives from.

## Backward-compatibility classes

The RFCs share one compatibility vocabulary so consumers can reason about change safely:

- **Additive** — new optional fields, new tools, new message types. Old clients keep working without updates.
- **Deprecating** — a field/tool/message is marked obsolete but still honored. Clients are notified to migrate.
- **Breaking** — old clients must be updated before they can interoperate. Bumps the RFC's major version and produces a migration note.

V1 has only one schema version per RFC, but the framework exists from the start so V2 evolution is tracked rather than improvised.

## Known issues queued for amendment

| RFC | Issue | Surfaced by | Disposition |
|---|---|---|---|
| RFC-001 | Three severity-shaped enums use inconsistent vocabularies: `notify.importance` is `["trace","info","warn"]`, `report_problem.severity` is `["info","warning","error","fatal"]`, `escalate.severity` is `["medium","high","critical"]`. Cross-tool comparison and policy expression are awkward. | Track B1 contract test (Stage 2). | RFC-001 v1.1.0 SHOULD normalize to a single ordered severity vocabulary across all three tools. Held until V1 ships. |
