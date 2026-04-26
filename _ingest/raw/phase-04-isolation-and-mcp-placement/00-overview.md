# Phase 04: Zone isolation primitives and MCP placement

**Merged turn range:** 029–035  
**Sub-turns:** 7  
**Slug:** `isolation-and-mcp-placement`

## Summary

Details the isolation primitive ladder (chroot through bubblewrap), formalizes zones-as-filesystem, and resolves MCP server placement strategy. Lands on per-zone MCP server instances as the default model. Ends at the cliff before V1 scope reduction.

## Decisions in this phase

- **DR-0004** [LOCK-IN] — Per-zone MCP server instances chosen over host-shared servers (turns 034)

## Sub-turn table of contents

| Turn | Role | Source lines | Chars | File |
| ---- | ---- | ------------ | ----- | ---- |
| 041 | user | 2798–2803 | 133 | [turn-041-user.md](turn-041-user.md) |
| 042 | assistant | 2804–3073 | 19843 | [turn-042-assistant.md](turn-042-assistant.md) |
| 043 | user | 3074–3079 | 57 | [turn-043-user.md](turn-043-user.md) |
| 044 | assistant | 3080–3320 | 20941 | [turn-044-assistant.md](turn-044-assistant.md) |
| 045 | user | 3321–3326 | 58 | [turn-045-user.md](turn-045-user.md) |
| 046 | assistant | 3327–3690 | 23180 | [turn-046-assistant.md](turn-046-assistant.md) |
| 047 | user | 3691–3696 | 51 | [turn-047-user.md](turn-047-user.md) |

## Reconciliation notes

Kept the 035->036 seam intact: this phase is the last 'expand the design' phase before the V1 contraction.
