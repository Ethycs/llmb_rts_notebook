# 0015. Bidirectional 'paper-telephone' MCP between kernel and extension

- **Status:** Accepted
- **Date:** 2026-04-26
- **Tag:** LOCK-IN

## Context

[DR-0008](0008-bidirectional-mcp-as-comm-channel.md) committed V1 to bidirectional MCP as the chat protocol: structured tool calls, not prose, are the conversation primitives, and the operator can drive UI on the agent's side just as the agent can drive UI on the operator's. DR-0008 named the *pattern*; it did not name the *endpoints*. With [DR-0009](0009-notebook-controller-no-jupyter-kernel.md) (NotebookController, no Jupyter kernel) and [DR-0012](../../_ingest/manifests/decisions.json) (LLMKernel as sole kernel) in place, the endpoints are now constrained: there is a Python LLMKernel subprocess and there is a TypeScript VS Code extension, with agents (Claude Code in V1) spawned by the kernel.

The remaining question is who bears which half of the bidirectional MCP relationship and how the agent's PTY stream relates to it. Three forces converge on the answer. First, every cross-component message — operator approving a card, kernel asking the extension to show a diff, agent calling a native operator-interaction tool, agent calling a proxied filesystem tool — needs a single shape rather than a parallel set of one-off message types. Second, the kernel sits in the path of every model call (via the LiteLLM endpoint) and every tool call (via its MCP server), so it is already the natural trust, audit, and modification boundary. Third, the user's "paper telephone" framing in turn 113 names the property the architecture needs: every link in the chain holds the message in a stable, inspectable, replayable form before passing it on, which means each leg must be a typed RPC rather than a free-form pipe.

## Decision

**LLMKernel and the VS Code extension each host an MCP server and each act as MCP clients to the other. The kernel additionally mediates the agent's PTY stream and the LiteLLM endpoint, making it the trust boundary, the audit boundary, and the modification boundary for every agent interaction.**

The topology:

```
Operator <-> Extension <-> LLMKernel (PTY + LiteLLM) <-> Agent <-> Model
```

Every arrow is bidirectional MCP. The kernel's responsibilities decompose into three layers in one Python process:

- *Standard MCP server.* Native operator-interaction tools (`ask`, `clarify`, `propose`, `request_approval`, `report_progress`, `present`, `notify`, `escalate`) plus proxied system tools (`read_file`, `write_file`, `run_command`). Native = kernel implements directly; proxied = kernel mediates a real implementation. The agent connects as an MCP client.
- *LiteLLM endpoint.* OpenAI-compatible HTTP endpoint that agents configure as their API base. Every model call routes through it; every call is logged, optionally transformed, then forwarded.
- *Frontend delivery.* LangSmith-shaped run records (POST/event/PATCH) emitted to the extension via Jupyter messaging with `display_id` semantics for in-place cell-output rendering.

The extension hosts its own MCP server exposing tools the kernel calls into to drive the operator's UI: `show_diff(file_a, file_b)`, `navigate_to(file, line)`, `display_widget(widget_spec)`, `prompt_operator(prompt_spec)`, `notify(message, urgency)`, `open_panel(panel_id)`, `update_status(state)`, `highlight(file, region)`. The kernel's MCP server in turn exposes tools the extension calls into to drive kernel state: `execute_cell(cell_id, content)`, `pause_agent(agent_id)`, `resume_agent(agent_id)`, plus the operator-interaction tools agents see as their conversation primitives. There is no special-cased "rendering protocol" outside MCP; everything that crosses the kernel-extension boundary is an MCP-shaped tool call.

## Consequences

- **Positive: clean trust boundary.** Agents are configured to use the kernel's endpoints exclusively — no direct provider keys, no direct shell, no MCP servers outside the kernel's control. What the kernel allows, agents can do.
- **Positive: protocol symmetry.** One shape (typed RPC, JSON-RPC envelope, schema-validated payload) covers every cross-component message. Adding a capability means defining a tool, not inventing a message type.
- **Positive: paper-telephone observability.** Every link writes its part of the trail before forwarding. The chain is observable end-to-end and replayable from the trail.
- **Positive: replaceable extension.** The CLI, web, or mobile client is whatever implements the MCP-client side of the kernel's exposed tools. The kernel does not change.
- **Positive: round-trips compose naturally.** A `prompt_operator` round-trip is kernel-forwards-to-extension, extension-renders-UI, operator-answers, extension-calls-back-into-kernel, kernel-returns-tool-result-to-agent — four legs, one protocol shape.
- **Negative: more interfaces to specify and test.** Two MCP surfaces instead of one. Each side's tool list, schemas, error semantics, and versioning need writing down (RFC-001, RFC-003).
- **Negative: kernel lifecycle owns more.** It hosts an MCP server, a LiteLLM endpoint, the agent supervisor, and a Jupyter messaging layer in one process. Failure-mode analysis is correspondingly larger (RFC-004).
- **Negative: bidirectionality requires both sides to be MCP-capable from day one.** A renderer-only extension is not a viable interim step.
- **Follow-ups:**
  - RFC-001 (V1 MCP tool taxonomy) — locks the schemas for both surfaces.
  - RFC-003 (custom message format) — covers the non-tool-call traffic that still crosses the kernel-extension boundary (run lifecycle, layout state, agent-graph queries, heartbeats).
  - [DR-0016](0016-rfc-standards-discipline.md) — the discipline under which RFC-001 through RFC-004 are written.

## Alternatives considered

- **One-directional MCP (agent→kernel only, extension as pure renderer).** Rejected — the kernel needs to drive UI on the extension's side (show diff, focus panel, prompt operator) and only the extension owns those operations. Without bidirectionality, every kernel→extension call needs a parallel non-MCP message type, which is exactly what bidirectional MCP eliminates.
- **Extension as MCP server only (kernel as pure backend).** Rejected — the extension and agents both need to drive kernel state (execute a cell, pause an agent, resolve an approval). One-directional in this direction means the kernel cannot be addressed as a tool host, breaking the symmetry the agent depends on.
- **Shared message bus (event broker) between kernel and extension instead of MCP.** Rejected — reinventing a protocol. MCP is JSON-RPC tool calls with mature SDKs and tool-use-trained model behavior. A custom bus duplicates the work, loses the model's native fluency, and adds a parallel schema registry.
- **Custom Jupyter message types for everything cross-component.** Rejected as the *primary* mechanism — Jupyter messaging stays for run records and lifecycle events (RFC-003), but using it for tool-call traffic loses MCP's typed RPC shape and the agent's native vocabulary. The two protocols coexist; they do not compete.
- **Skip the PTY mediator role and let agents call providers directly.** Rejected — defeats DR-0008's audit and modification properties. The kernel exists *because* every agent interaction must be observable; bypassing it means rebuilding the observability surface elsewhere.

## Source

- **Source merged turn:** 099 (in phase 08)
- **Raw sub-turns:**
  - [turn-111-user.md](../../_ingest/raw/phase-08-blockers-mediator-standards/turn-111-user.md) — kernel-as-MCP-server-and-PTY framing; "we don't really care what the model context does as long as we can control its functionality" as the load-bearing scope claim.
  - [turn-112-assistant.md](../../_ingest/raw/phase-08-blockers-mediator-standards/turn-112-assistant.md) — three-layer kernel responsibilities (MCP server, LiteLLM endpoint, frontend delivery); reverse-MCP interpretation; bidirectional symmetry.
  - [turn-113-user.md](../../_ingest/raw/phase-08-blockers-mediator-standards/turn-113-user.md) — the "paper telephone" naming; LiteLLM as PTY clarification.
  - [turn-114-assistant.md](../../_ingest/raw/phase-08-blockers-mediator-standards/turn-114-assistant.md) — paper telephone architecture lock; full kernel responsibility decomposition; end-to-end flow walkthrough; the kernel as trust, audit, and modification boundary (DR-0015).
- **Dev guide:** [chapter 08](../dev-guide/08-blockers-mediator-standards.md)
