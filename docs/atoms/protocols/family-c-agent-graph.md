# Protocol: Family C — Agent graph

**Status**: `protocol` (V1 shipped, RFC-006 v2)
**Family**: RFC-006 Family C (agent graph state + commands)
**Direction**: bidirectional request/response — `agent_graph.query` extension → kernel; `agent_graph.response` kernel → extension; correlated by `correlation_id`
**Source specs**: [RFC-006 §5](../../rfcs/RFC-006-kernel-extension-wire-format.md#5--family-c-agent-graph), [RFC-005 §`metadata.rts.agents`](../../rfcs/RFC-005-llmnb-file-format.md#metadatartsagents--agent-state-graph)
**Related atoms**: [agent](../concepts/agent.md), [contracts/metadata-writer](../contracts/metadata-writer.md), [contracts/agent-supervisor](../contracts/agent-supervisor.md), [contracts/messaging-router](../contracts/messaging-router.md)

## Definition

Family C is the **agent-graph query channel**. The extension's map view (and any V2+ branch-switching UX) needs to inspect the per-zone agent graph — the [agent](../concepts/agent.md) refs and the edges between them (spawned-by, in-zone, etc.) — without requesting the entire `metadata.rts` snapshot. Family C provides four scoped query types over the same Comm and pairs each query to one response by `correlation_id`.

## Wire shape

### `agent_graph.query` (extension → kernel)

```jsonc
{
  "type": "agent_graph.query",
  "correlation_id": "<UUIDv4>",
  "payload": {
    "query_type":     "neighbors | paths | subgraph | full_snapshot",
    "node_id":        "alpha",                  // required for neighbors / paths / subgraph
    "target_node_id": "beta",                   // required for paths
    "hops":           1,                        // 1..16; required for neighbors / subgraph
    "edge_filters":   ["spawned", "in_zone"]    // optional; restricts edge kinds
  }
}
```

### `agent_graph.response` (kernel → extension)

```jsonc
{
  "type": "agent_graph.response",
  "correlation_id": "<same as query>",
  "payload": {
    "nodes":     [ /* agent / zone / cell nodes per RFC-005 §metadata.rts.agents */ ],
    "edges":     [ /* edges */ ],
    "truncated": false
  }
}
```

Node and edge schemas are exactly those in [RFC-005 §`metadata.rts.agents`](../../rfcs/RFC-005-llmnb-file-format.md#metadatartsagents--agent-state-graph). The response's `correlation_id` MUST equal the originating query's; the extension's pending-query table is keyed on it.

## Schema-version handshake

Comm target name `llmnb.rts.v2`. Within v2.x, new `query_type` and `edge_filters[]` enum values are additive. Receivers MUST tolerate unknown enum values from forward-version producers (W4 log + discard for `query_type`; ignore unknown filter strings).

## Error envelope

Failures: W4 (unknown `query_type`), W5 (missing required field), W6 (response with no matching query — log + discard; could indicate stale kernel re-issue), W11 (oversized response — RFC-005 §F13 says blob-store large data instead). The response payload itself does NOT carry an error code — a query that the kernel cannot answer returns `{ "nodes": [], "edges": [], "truncated": true }`.

## V1 vs V2+

- **V1**: read-only queries. Mutations to the agent graph (spawn, branch, revert) flow through `operator.action` (Family D) and observed agent state changes flow back as full Family F snapshots.
- **V2+**: streamed subscription mode (server-side push when the graph changes); typed mutations against the graph (e.g., `agent_graph.command` with explicit reordering for branch-switching UX).

## See also

- [agent](../concepts/agent.md) — the entity nodes returned in the response.
- [contracts/metadata-writer](../contracts/metadata-writer.md) — kernel side answers queries via `apply_agent_graph_command` (read-only sub-commands `neighbors / paths / subgraph`).
- [contracts/agent-supervisor](../contracts/agent-supervisor.md) — owns the live agent runtime state that nodes reflect.
- [contracts/messaging-router](../contracts/messaging-router.md) — extension-side correlator that pairs query → response.
