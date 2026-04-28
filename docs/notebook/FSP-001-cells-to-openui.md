# FSP-001: Cells → OpenUI button

**Status**: Future Spec, Issue 1, 2026-04-27
**Targeting**: V2 (UI/utility push) per VERSIONING.md
**Related**: BSP-002 (conversation graph — cells, agents, overlays), RFC-005 (`metadata.rts` zone format), RFC-006 (wire format)
**Defers from**: V1 (core notebook substrate ships first)

## 1. Scope

Operator selects a contiguous (or non-contiguous) set of notebook cells and clicks a toolbar button labeled **"→ OpenUI"** (placeholder name). The selected cells are converted into a self-contained interactive UI surface — a *generated form*, not a re-render — where:

- The cells' free-form parameters become labeled UI controls (text inputs, selects, sliders, file pickers, etc.).
- The cells' outputs become live regions that update when the operator submits the form.
- The agent bindings persist: each control still routes to its origin agent; the form is a thin shell over the existing turn graph.

The button does not delete the source cells. It produces a **derivative artifact** stored alongside the cells in `metadata.rts.zone.openui_views[]` (new sub-tree, additive). The notebook proper continues to render the source cells as normal; the OpenUI view is opened in a side panel or full-tab editor (operator choice).

## 2. Two interpretations of "OpenUI" — flag for operator clarification

This spec accommodates either:

- **A. Generative UI (wandb/openui style).** The cells' content (prompts, expected outputs, tool calls) becomes an LLM-fed prompt that produces a one-shot UI markup (HTML/JSX). The generated UI is editable; subsequent regenerations diff against the prior version. Requires an LLM call at generation time; not RTS-deterministic.
- **B. Structured form generation (no LLM at build time).** The cells are *parsed* — input directives like `@alpha: ${prompt}` with templated holes become form fields, tool-call cells become buttons, output cells become panels. Pure structural transform; no LLM at build time. The form's *behavior* (sending agent turns) is the existing kernel runtime.

V1 of this FSP picks **B as the default** (structural). A is offered as a "rich flavor" toggle that ships behind a feature flag in V2.5+, because it adds an LLM-call dependency at the build step and changes the determinism story.

If the operator's intent is specifically (A), this spec adapts: §4 changes from "structural transform" to "LLM-generated markup with an editable canvas." Flagging here so the choice is explicit before the implementation slice lands.

## 3. UX

| Surface | Behavior |
|---|---|
| Toolbar button | Visible when ≥1 cell is selected. Tooltip: "Convert selected cells to an OpenUI view." Disabled when zero cells selected. |
| Button click | Opens a modal: name the view, pick layout hint (`vertical-form` / `dashboard-grid` / `wizard-steps`), choose cell-binding mode (`live` — submits route back to source cells; `clone` — a copy of cells gets created and the view binds to the copies, leaving sources untouched). |
| Save | A new entry under `metadata.rts.zone.openui_views[]` with `view_id`, `name`, `created_at`, `bound_cell_ids[]`, `layout_hint`, `binding_mode`, `controls[]` (parsed from cells), `panels[]` (output regions). |
| Open | Side panel or full-tab editor renders the view from the spec. Identical determinism to the source cells: same agent, same prompts, same outputs. |
| Modify | The view's `controls[]` and `panels[]` are editable post-creation; edits are versioned via the BSP-002 §12 overlay graph (operator edits as a second git-style layer). The source cells remain immutable per BSP-002 §2. |

## 4. Data model (additive)

New top-level key in `metadata.rts.zone`:

```jsonc
{
  "openui_views": [
    {
      "view_id": "01HZ...",
      "name": "Provisioning wizard",
      "created_at": "2026-04-27T12:00:00Z",
      "bound_cell_ids": ["c01HZ...", "c01HX..."],
      "binding_mode": "live | clone",
      "layout_hint": "vertical-form | dashboard-grid | wizard-steps",
      "controls": [
        {
          "control_id": "01...",
          "label": "Repository URL",
          "kind": "text | select | slider | file | ...",
          "bound_to": { "cell_id": "...", "directive_slot": "${repo_url}" },
          "validation": { "regex": "...", "required": true }
        }
      ],
      "panels": [
        {
          "panel_id": "01...",
          "kind": "stream | artifact | log",
          "bound_to": { "cell_id": "...", "agent_id": "..." }
        }
      ]
    }
  ]
}
```

The view spec is **additive** — V1 readers (without OpenUI awareness) ignore the key; V2+ readers parse it. RFC-005 §"unknown keys are preserved" is the forward-compat guarantee.

## 5. Wire (RFC-006 additions)

New envelope `openui_view.*` family (Family G — to be allocated in RFC-006 v2.1+):

| `type` | Direction | Purpose |
|---|---|---|
| `openui_view.create` | extension → kernel | Operator clicked the button; here are the bound cell IDs and layout hint. |
| `openui_view.created` | kernel → extension | View persisted with `view_id`. |
| `openui_view.invoke` | extension → kernel | Operator filled in the form and clicked Run; here is the form payload. |
| `openui_view.update` | kernel → extension | Live updates while the form's bound agents are emitting. |
| `openui_view.archive` | extension → kernel | Operator deleted the view (soft-delete; `archived_at` timestamp). |

All envelopes route through the BSP-003 intent envelope pattern — the writer is the single canonical author of `openui_views[]`.

## 6. Failure modes (F-codes — separate namespace from K)

| Code | Symptom | Marker | Operator action |
|---|---|---|---|
| F60 | Cells selected but parse fails (no directive holes detected; cells aren't form-shaped) | `openui_parse_failed` with `cell_ids[]` | Surface "These cells don't expose any parameters; nothing to convert." |
| F61 | View bound to a cell that was deleted | `openui_view_dangling` with `view_id`, `missing_cell_id` | Mark view as orphaned; offer to rebind or archive. |
| F62 | Generative-mode (interpretation A) LLM call failed | `openui_generative_failed` with `error` | Fall back to structural mode (B); surface the error. |

## 7. Forward-compat with V3+

- **V3 RTS:** the OpenUI view becomes a *control surface*. Operator edits a slider; the bound agent receives `move_agent_head + append_turn` intents in real-time. The view is the operator's RTS HUD over the agent fleet.
- **V4 multi-everything:** views are sharable across operators. The `view_id` becomes a coordination key; intent-envelope serialization (BSP-003 §3) handles concurrent edits to the same view spec.

## 8. What this is NOT

- Not a replacement for cells. The notebook stays cell-shaped; views are derivative.
- Not an LLM-only feature in V1 of this FSP — interpretation B is structural and deterministic.
- Not a workflow engine. Views compose existing cell behaviors; they don't add new control flow primitives. (DAG-shaped multi-step views are V3 work.)

## 9. Implementation slice (when V2 reaches this FSP)

V2.x slice X-OPENUI:

1. Extension: toolbar button + cell-selection plumbing (~1 day)
2. Extension: structural parser (cell directive → control spec) (~2 days)
3. Extension: view renderer (vertical-form layout for V2.0; grid + wizard layouts queued for V2.5) (~3 days)
4. Kernel: `openui_view.create` / `.invoke` / `.update` / `.archive` envelope handlers (~1 day; mostly delegates to MetadataWriter via BSP-003 intents)
5. K-MW: register four new intent kinds (`create_openui_view`, `invoke_openui_view`, `update_openui_view`, `archive_openui_view`); apply functions for each (~1 day)
6. Tests: new round-trip test per envelope; visual regression for the renderer (~2 days)

Estimate: ~10 working days for V2.0 (interpretation B only). Interpretation A adds ~5 days for the LLM integration + canvas editor.

## 10. Why this is V2, not V1

V1's job is to make the substrate solid: cells that are agent-bound, multi-turn, branchable, persistent. OpenUI views require all of that to already work — without persistent agents, the form's "Run" button has nothing to bind to; without the writer registry (BSP-003), the view spec has no safe way to be authored; without overlays (BSP-002 §12), edits to the view spec have no versioning.

When V1 ships, this FSP becomes implementable as a derivative layer. Until then, the spec sits here so the substrate decisions don't accidentally close off the design space.

## Changelog

- **Issue 1, 2026-04-27**: initial. Two interpretations flagged (generative vs structural); structural picked as V2 default. Data model additive under `metadata.rts.zone.openui_views[]`. Wire family G allocated in concept; RFC-006 amendment is V2 work.
