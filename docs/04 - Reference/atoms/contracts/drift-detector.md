# Contract: DriftDetector

**Status**: `contract` (V1 shipped 2026-06-30 — signature ratified per PLAN-substrate-gap-closure G12 Option A; the earlier spec-vs-impl drift is closed by taking the shipped shape as normative)
**Module**: `vendor/LLMKernel/llm_kernel/drift_detector.py` — `class DriftDetector`
**Source specs**: [RFC-005 §`metadata.rts.drift_log`](../../../05%20-%20Standards/rfcs/RFC-005-llmnb-file-format.md#metadatartsdrift_log--persisted-drift-events), [RFC-005 §"Resume-time RFC version check"](../../../05%20-%20Standards/rfcs/RFC-005-llmnb-file-format.md), [RFC-006 §8](../../../05%20-%20Standards/rfcs/RFC-006-kernel-extension-wire-format.md#8--family-f-notebook-metadata-bidirectional-in-v202) (called during hydrate)
**Related atoms**: [contracts/metadata-writer](metadata-writer.md), [contracts/agent-supervisor](agent-supervisor.md), [protocols/family-f-notebook-metadata](../protocols/family-f-notebook-metadata.md)

## Definition

The `DriftDetector` runs on file-load (during the kernel's `notebook.metadata mode:hydrate` handler) and produces a list of drift events comparing the persisted `metadata.rts` snapshot against the current environment. Detected events feed into `metadata.rts.drift_log` (RFC-005 schema); the operator surfaces them via the extension's drift surface. The module is **stateless across calls** — every comparison takes the persisted snapshot + current-env values as input and returns a fresh event list.

## Public method signatures

```python
class DriftDetector:
    def compare(
        self,
        persisted: dict,
        *,
        current_kernel:       Optional[dict] = None,           # config.volatile.kernel.*
        current_agents:       Optional[Iterable[dict]] = None, # config.volatile.agents[]
        current_mcp_servers:  Optional[Iterable[dict]] = None, # config.volatile.mcp_servers[]
        current_agent_status: Optional[dict[str, str]] = None, # {agent_id: "alive"|"idle"|"crashed"|...}
    ) -> list[dict]:
        """Return drift events ready to append to metadata.rts.drift_log.

        Order: kernel-volatile → per-agent volatile → MCP-server transports
        → in-progress span truncation → agent-process status drift.
        """

# Module-level helper (also part of the contract):
def truncate_in_progress_spans(
    runs: list[dict],
    *,
    detected_at: Optional[str] = None,
) -> list[dict]:
    """Truncate UNSET in-progress spans in place. Returns one drift event
    per truncated span (severity: 'info')."""
```

## Severity classification (RFC-005)

```python
SEVERITY_INFO  = "info"     # benign drift (e.g., span truncation on restart)
SEVERITY_WARN  = "warn"     # behavior-affecting (model change, model_default change, minor RFC bump)
SEVERITY_ERROR = "error"    # resume-blocking (RFC major mismatch, MCP server gone, model unavailable)
```

Severity classifier `_classify_version_drift(prev, current)` follows RFC-005 §"Resume-time RFC version check":
- `prev == current` → INFO.
- Major mismatch → ERROR.
- Minor mismatch → WARN.

## Invariants

- **Stateless.** No fields persist across `compare(...)` calls. Each call is a fresh comparison.
- **Order matches RFC-005 enumeration** so the operator sees the most-impactful drift first.
- **`None` skips a category.** Passing `current_kernel=None` skips the kernel-volatile pass entirely; this lets callers opt out of categories they cannot observe.
- **Does not mutate `persisted`** except via the in-place truncation helper, which is opt-in.
- **Does not write to disk** and does not emit on the wire. The `MetadataWriter` is responsible for routing drift events into the next snapshot per [protocols/family-f-notebook-metadata](../protocols/family-f-notebook-metadata.md).
- **In-progress span truncation** stamps `endTimeUnixNano` to wall-clock now, sets `status.code = STATUS_CODE_ERROR` with message `"kernel restart truncated"`, and produces one INFO drift event per span.

## K-class error modes

The detector itself does not have a dedicated K-class — its outputs feed the writer's drift_log. Severity escalation is the surface:

- ERROR drift events MAY block the kernel from emitting Family F until the operator acknowledges via `acknowledge_drift` (see [contracts/metadata-writer](metadata-writer.md)).
- WARN events surface a non-blocking banner.
- INFO events are recorded but do not surface unless the operator opens the drift panel.

## Callers

- `vendor/LLMKernel/llm_kernel/custom_messages.py` — the `notebook.metadata mode:hydrate` handler invokes `DriftDetector.compare(persisted_volatile, current_volatile)` and appends results to the in-memory `drift_log`.
- After the writer commits, drift events ride out on the next Family F snapshot.

## Design notes (post-G12 ratification)

- **Return shape**: `list[dict]` (drift events), not a `DriftReport` aggregate wrapper. The earlier RFC-005 narrative sketched a `DriftReport` class; the implementation ships the per-event list because every consumer (currently `custom_messages.py`'s hydrate handler) iterates the events one-by-one and appends to `drift_log`. Per [Engineering_Guide.md §11.2](../../../../Engineering_Guide.md) — don't ship wrappers for hypothetical consumers. A future consumer that genuinely needs `.severities` / `.summary()` accessors can add a thin `DriftReport` wrapper without changing the module's public surface.
- **Named kwargs on `compare`**: `current_kernel=`, `current_agents=`, `current_mcp_servers=`, `current_agent_status=`. Chosen over a single `current` dict so callers can opt out of categories they cannot observe (`None` skips a pass); the invariant "`None` skips a category" above is the load-bearing property.
- **Severity as module-level constants**: `SEVERITY_INFO` / `SEVERITY_WARN` / `SEVERITY_ERROR` rather than a class-level `Severity` enum. Same rationale — no consumer needs enum-shaped dispatch; every read is a string comparison.

## See also

- [contracts/metadata-writer](metadata-writer.md) — caller during hydrate; routes drift events into `drift_log`.
- [contracts/agent-supervisor](agent-supervisor.md) — populates `current_agent_status` (alive / idle / crashed) for the per-agent pass.
- [protocols/family-f-notebook-metadata](../protocols/family-f-notebook-metadata.md) — the wire that delivers the snapshot containing drift events to the extension.
- [anti-patterns/path-propagation](../anti-patterns/path-propagation.md) — drift surfaces this kind of misconfiguration on hydrate.
