# Protocol: kernel.handshake envelope

**Status**: V1.5 reserved (concept locked; slice queued as PLAN-S5.0.3, not yet dispatched)
**Family**: `kernel.handshake` — pre-family transport bring-up (precedes A/B/C/F/G framing)
**Direction**: bidirectional, request-response — driver → kernel, then kernel → driver
**Source specs**: [PLAN-S5.0.3 §4.3](../../notebook/PLAN-S5.0.3-driver-extraction-and-external-runnability.md#43-handshake-envelope-new--first-envelope-on-any-connection), [PLAN-S5.0.3 §5.2](../../notebook/PLAN-S5.0.3-driver-extraction-and-external-runnability.md#52-tcp-server) (TCP auth model), [PLAN-S5.0.3 §7.1](../../notebook/PLAN-S5.0.3-driver-extraction-and-external-runnability.md#71-round-0-operator-30min) (RFC-006 v2.1.0 amendment), [RFC-006](../../rfcs/RFC-006-kernel-extension-wire-format.md), [RFC-008](../../rfcs/RFC-008-pty-transport.md)
**Related atoms**: [discipline/wire-as-public-api](../discipline/wire-as-public-api.md), [concepts/driver](../concepts/driver.md), [concepts/transport-mode](../concepts/transport-mode.md), [protocols/family-f-notebook-metadata](family-f-notebook-metadata.md)

## Definition

The `kernel.handshake` envelope is the **first envelope on any connection**, regardless of [transport](../concepts/transport-mode.md). It negotiates wire version, declares the [driver's](../concepts/driver.md) name + capabilities, and (for TCP) carries bearer-token auth. The kernel responds with its own version + a session id + the accepted capability set. On mismatched `WIRE_MAJOR` or auth failure, the kernel sends an error envelope and closes the transport — no Family A/B/C/F/G frames flow until handshake succeeds.

## Wire shape

### Driver → kernel (request)

```jsonc
{
  "type": "kernel.handshake",
  "payload": {
    "client_name":     "llmnb-cli | vscode-extension | <custom>",
    "client_version":  "<semver>",
    "wire_version":    "1.0.0",
    "transport":       "pty | unix | tcp",
    "auth": {
      "scheme": "bearer",
      "token":  "<token>"
    },                                          // present iff transport == "tcp"; absent for pty/unix
    "capabilities": ["family_a", "family_b", "family_c", "family_f", "family_g"]
  }
}
```

### Kernel → driver (response)

```jsonc
{
  "type": "kernel.handshake",
  "payload": {
    "kernel_version":         "<semver>",
    "wire_version":           "1.0.0",
    "session_id":             "<uuid>",
    "accepted_capabilities":  ["family_a", "family_b", "family_c", "family_f", "family_g"],
    "warnings":               ["minor_version_skew"]   // optional
  }
}
```

## Role per transport

| Transport | Handshake role | Why |
|---|---|---|
| **TCP** | Mandatory; bearer token validated; session refused on missing/wrong token | Network-reachable; auth required to prevent unauthorized control |
| **Unix socket** | Mandatory for capability negotiation; token in companion `<pid>.token` (mode 0600) | Same-user trust via filesystem perms; token still verified to defeat a confused-deputy local attacker |
| **PTY** | Advisory — implicit parent-child trust; handshake still emitted to negotiate `wire_version` and `session_id` | No auth needed (parent spawned the child); version-skew check still useful |

The envelope contract is invariant across transports per [transport-mode](../concepts/transport-mode.md); only the `auth` block presence differs.

## Version-skew semantics

Per [PLAN-S5.0.3 §4.2](../../notebook/PLAN-S5.0.3-driver-extraction-and-external-runnability.md#42-version-constants-locked):

| Comparison | Outcome |
|---|---|
| `WIRE_MAJOR` differs | Kernel sends error envelope, closes transport. No degraded mode. |
| `WIRE_MINOR` differs (newer kernel, older driver) | `warnings: ["minor_version_skew"]` in response; both sides proceed. Newer minor is backward-compatible per RFC-006. |
| `WIRE_MINOR` differs (newer driver, older kernel) | Driver SHOULD warn but proceed if features used are within the kernel's minor. Kernel may reject unknown `action_type` values via W4 (RFC-006). |
| `WIRE_PATCH` differs | Ignored. |

## Auth failure behavior

For TCP only: token comparison uses `hmac.compare_digest` (constant-time). On mismatch or missing token:

```jsonc
{
  "type": "kernel.handshake",
  "payload": {
    "error": "auth_failed",
    "wire_version": "1.0.0"
  }
}
```

…then `transport.close()`. The kernel does not retry; the driver gets one chance per connection.

## Multi-client (V1: single)

Per [PLAN-S5.0.3 §5.2](../../notebook/PLAN-S5.0.3-driver-extraction-and-external-runnability.md#52-tcp-server), V1 kernel accepts one connection at a time. A second client mid-session receives `error: "kernel_busy"` and the connection closes. Multi-client is V2+; the handshake's `session_id` is forward-compatible with that work but V1 always issues a fresh session per accepted connection.

## Invariants

- **Handshake is the first envelope on any transport.** No Family A/B/C/F/G frame flows before a successful handshake response.
- **Exactly one handshake per connection.** A second `kernel.handshake` envelope on the same connection is rejected as a `wire-failure` LogRecord; the connection stays open (the kernel MAY tolerate it as a no-op, but the additive contract is "ignore + log").
- **`session_id` is kernel-issued, immutable for the connection.** Drivers MUST echo it on subsequent envelopes that require session correlation.
- **Capability handshake is informational in V1.** Both sides advertise all five families. V2+ may reduce capability sets per driver (e.g., a tests-as-notebooks driver opting out of Family C).
- **Token MUST NOT appear on argv.** Loaded from `LLMNB_AUTH_TOKEN` env or `.env`. Argv leakage to `ps` is a documented threat.

## Schema-version handshake (this is it)

This envelope IS the schema-version handshake for the wire layer. It supersedes the older "comm target name suffix" trick (`llmnb.rts.v2`) for negotiating major version once S5.0.3 lands. The comm target name remains the layer-1 identifier; `wire_version` in the handshake payload is the source of truth for compatibility.

## Error envelope

| Error code | Trigger | Recovery |
|---|---|---|
| `version_mismatch_major` | `WIRE_MAJOR` differs between driver and kernel | Driver upgrades / downgrades; reconnect. No graceful degradation. |
| `auth_failed` | TCP: missing or invalid bearer token | Driver fixes `LLMNB_AUTH_TOKEN`; reconnect. |
| `kernel_busy` | Second client connecting to a single-client kernel (V1) | Driver waits or operator stops the first client. |
| `wire-failure` (RFC-006) | Malformed handshake payload | Logged; transport closed. |

## See also

- [discipline/wire-as-public-api](../discipline/wire-as-public-api.md) — why this envelope exists at all.
- [concepts/driver](../concepts/driver.md) — every driver sends this.
- [concepts/transport-mode](../concepts/transport-mode.md) — handshake invariance across transports.
- [protocols/family-f-notebook-metadata](family-f-notebook-metadata.md) — the first family-frame typically flowing post-handshake (extension `mode:"hydrate"` on `.llmnb` open).
