# Plan: V2 output-kind lens UI

**Status**: shipped 2026-05-29 (slice 1, partial — sidebar grouping; per-cell lens deferred)
**Audience**: an LLM (or operator) picking this up cold. Self-contained.
**Goal**: turn the V1-shipped OTLP attribute `llmnb.output.kind` into an operator-visible lens — a sidebar view that groups every tagged span across the active notebook by kind, with click-to-reveal navigation. Second V2 slice, after branch-switching UX (`667dd68`).

---

## §1. Why this work exists

V1 ships the tag stream — every `agent_emit` span the kernel emits can carry an OTLP attribute `llmnb.output.kind` from a 12-value enum (prose / code / diff / patch / decision / plan / artifact_ref / test_result / diagnostic / checkpoint / question / warning). The operator-side payoff was always the *lens*: "show me only the decisions", "I'm triaging — surface every diagnostic across the notebook". V1 has the tag; V2 needs the UI.

The V1 vs V2+ split is pinned in [`output-kind` atom](../04%20-%20Reference/atoms/concepts/output-kind.md) §"V1 vs V2+": V1 ships the tag; V2 ships the lens. This slice closes the V2 promise on the **sidebar surface** — operator-facing without touching the renderer or the wire.

## §2. Goals and non-goals

### Goals

- A new sidebar view `llmnb.outputKinds` (5th view in the `llmnb` activity-bar container, sibling to Zones / Agents / Activity / Search).
- Top-level rows: one `kind-group` per output kind that has at least one tagged span. Rows show the kind label + a span count.
- Render order: high-attention kinds (`decision`, `question`, `warning`, `diagnostic`) first, then plan / patch / diff / test_result / checkpoint, then code / prose / artifact_ref. Unknown values (forward-compat per the atom) bucket under a synthetic `<other>` group rendered last.
- Each `kind-group` expands to `tagged-span` rows — one per matching span. Row label is a short snippet from `llmnb.emit_content` (or the span `name` as fallback). Row description shows the cell index + the originating agent id.
- Click a `tagged-span` row → `llmnb.revealCell` reveals the source cell (mirrors the existing S7 / S10 reveal pattern).
- Pure read-side. No kernel changes. No new envelope types. The tag stream V1 already emits is the source.

### Non-goals (V2 slice 1 — explicit)

- **No per-cell filter widget.** The decoration approach ("dim cells whose outputs don't match the active kind") would need either `notebookCellDecoration` (not in v1.92) or a fork of the run-renderer. Both belong to V2 slice 2.
- **No operator-defined custom lenses.** The `outputKind` enum is the lens vocabulary; operator-saved filter sets ("my triage lens") are V2.5+.
- **No lens persistence.** The view re-derives from the live notebook each open; there's no "remember my active filter" state because the V1 slice doesn't have a filter.
- **No multi-notebook aggregation.** The view shows tags from the active notebook only. Workspace-wide aggregation is a V3+ ergonomic.

## §3. Concrete work

### §3.1 Extractor (pure)

`extension/src/sidebar/output-kind-lens/extractor.ts`:

- `extractTaggedSpans(notebook)` — walks every code cell's `outputs`, decodes each `application/vnd.rts.run+json` item as JSON, yields each OTLP span via `iterateSpans` (tolerant: handles V1 single-span shape AND future `{spans: [...]}` / `{scopeSpans: [...]}` bundled shapes), calls `toTaggedSpan` which extracts `llmnb.output.kind` (+ `llmnb.agent_id` / `llmnb.emit_content` for the snippet).
- `groupByKind(spans)` — bucket the flat list by `outputKind`, preserving insertion order within each bucket.
- `buildSnippet(span)` — `emit_content` → `name` → `<span:short>` fallback chain; whitespace-compressed; truncated to 80 chars with ellipsis.
- Forward-compat: unknown `outputKind` values bucket under the synthetic `<other>` key (`OTHER_KIND_KEY`).

### §3.2 Tree provider

`extension/src/sidebar/output-kind-lens/lens-tree.ts`:

- `OutputKindLensTreeProvider implements vscode.TreeDataProvider<LensNode>` — pulls spans via a `SpansResolver` (defaults to walking the live `NotebookDocument`; tests inject synthetic `TaggedSpan[]`).
- Top-level `getChildren()`: empty-state node when no tagged spans, otherwise one `kind-group` per non-empty bucket (canonical order, `<other>` last).
- `kind-group` children: `tagged-span` rows with `command: llmnb.revealCell` for click navigation.
- Per-kind codicon: `check` (decision), `warning`, `alert` (diagnostic), `question`, `list-ordered` (plan), `git-pull-request` (patch), `diff`, `beaker` (test_result), `bookmark` (checkpoint), `code`, `comment` (prose), `file-symlink-directory` (artifact_ref).

### §3.3 Wiring

- `extension/package.json` — 5th view registered: `{ id: "llmnb.outputKinds", name: "Output kinds" }`.
- `extension/src/extension.ts` — register the provider via `vscode.window.createTreeView` against the same `SidebarMetadataSource` the other sidebar trees share; expose on `ExtensionApi.getOutputKindLensProvider`.

### §3.4 Test surface

| File | Tests |
|---|---|
| `extension/test/contract/sidebar-output-kind-extractor.test.ts` | 12 pure-unit tests covering single-span / bundled-batch span iteration, forward-compat bucketing, snippet truncation, insertion-order preservation, malformed-input tolerance. |
| `extension/test/contract/sidebar-output-kind-lens-tree.test.ts` | 8 provider tests using the `SpansResolver` seam: empty state, canonical kind ordering, click-to-reveal command, `<other>` bucket placement, singular/plural span count, cell-index + agent-id description, no-active-zone empty render, change-event firing. |

Total: 20 new tests.

## §4. Interface contracts

No wire changes. Pure read-side from cell `outputs`. The OTLP attribute key is `llmnb.output.kind` per [RFC-006 §1 / output-kind atom](../04%20-%20Reference/atoms/concepts/output-kind.md#wire-shape).

## §5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `NotebookCellData.outputs` doesn't reliably populate `NotebookCell.outputs` after `openNotebookDocument` in tests | Provider exposes a `SpansResolver` constructor seam; tests inject synthetic spans directly. Pure extractor logic is covered separately. |
| Forward-compat: a future kernel adds a 13th output kind | Unknown values bucket under `<other>` (forward-compat per the atom invariant). The UI still surfaces them rather than dropping. |
| Performance on notebooks with thousands of spans | The extractor re-walks the notebook on every `getChildren()` call. Acceptable at V2 scale; if the lens becomes the operator's primary triage surface and notebook span counts hit the multi-thousands, V2.5 may add a snapshot-version cache key. |

## §6. Atom + doc updates

- `docs/atoms/concepts/output-kind.md` — V1 vs V2+ section: lens UI moves to "V2 partial-ship" with back-reference to this PLAN.

## §7. Definition of done

- [x] All 20 new extension tests authored (12 extractor + 8 tree).
- [x] Empty-state copy pinned (`LENS_EMPTY`).
- [x] High-attention kinds render first per the operator's expected triage order.
- [x] Click-to-reveal wired through `llmnb.revealCell`.
- [x] Forward-compat `<other>` bucket renders last.
- [x] output-kind atom V1-vs-V2+ section updated.
- [ ] Per-cell decoration (dim non-matching cells) — explicitly V2 slice 2 (deferred).
- [ ] Operator-defined custom lenses — V2.5+ (queued).
