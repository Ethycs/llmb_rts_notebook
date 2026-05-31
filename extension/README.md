# `extension/` — VS Code extension

V1 VS Code extension for `.llmnb` notebooks. Subtractive fork output
of [`vendor/vscode-jupyter`](../vendor/vscode-jupyter/) per
[DR-0011](../docs/decisions/0011-subtractive-fork-vscode-jupyter.md)
and [chapter 07](../docs/dev-guide/07-subtractive-fork-and-storage.md).

## Status — V1 UX feature-complete; V2 lane opened (2026-05-30)

V1 UX is feature-complete on the public VS Code extension API. All
BSP-005 ladder slices either shipped or are formally deferred. Two V2
slices have landed; the rest are queued or genuinely blocked on VS
Code API exposure (see "Blocked" below).

Extension registers a single `NotebookController` for `.llmnb`,
dispatches via the cell-magic vocabulary (`@@spawn`, `@@agent`,
`@@section`, `@@import`, `@@export`, `@<flag>` line-magic), and rides
RFC-006 v2.1.0 wire format on the kernel side. Nineteen
`llmnb.*` commands registered in `package.json`.

Shipped extension surfaces:

- **S1** cell-as-agent identity badges (gutter color + status bar +
  kind label) — [docs/atoms/concepts/cell.md](../docs/atoms/concepts/cell.md).
- **S3** multi-turn `@<agent>` continuations via `agent_continue`
  envelope — [docs/atoms/operations/continue-turn.md](../docs/atoms/operations/continue-turn.md).
- **S5.0** cell-magic dispatcher (`@@<kind>` cell-magic, `@<flag>`
  line-magic) with HMAC injection defense + emission ban + bidirectional
  strip per [PLAN-S5.0.1](../docs/notebook/PLAN-S5.0-cell-magic-vocabulary.md). See [magic atom](../docs/atoms/concepts/magic.md) and
  [discipline/certified-magic-emitter](../docs/atoms/discipline/certified-magic-emitter.md).
- **S5.0.3.x** headless executor support: shares the cell-magic parser +
  HMAC signer + strip code with the extension as the canonical library
  ([discipline/certified-magic-emitter](../docs/atoms/discipline/certified-magic-emitter.md)). Talks to LLMKernel over
  TCP transport ([RFC-008 v1.0.1](../docs/rfcs/RFC-008-kernel-host-integration.md)) with the v2.1.0 wire-handshake envelope
  ([protocols/wire-handshake](../docs/atoms/protocols/wire-handshake.md)).
- **S5.0.4 privileged magic emission** (commit `838aa85`) — promotion
  chip + grant/revoke toolbar + privilege header. Privileged agents
  can emit structural cells via `emit_magic_cell`; unprivileged stream
  emissions stay sanitized. See [PLAN-S5.0.4](../docs/notebook/PLAN-S5.0.4-privileged-magic-emission.md).
- **S5.5 sections** (commits `4c8e8a7` → `8251a5a`) — full state
  machine with dual-rep invariant and auto-flip on the kernel side;
  extension ships section operator commands (`llmnb.section.create` /
  `.rename` / `.delete` / `.setStatus` / `.openActions`), section-header
  decoration, `@@section` recognition, and native VS Code markdown-fold
  collapse so sections behave like Jupyter cell groups without a custom
  panel. See [PLAN-S5.5](../docs/notebook/PLAN-S5.5-sections.md).
- **S7 sidebar activity-bar trees** (commit `8aaa3e3`) — zones tree,
  agents tree, recent-activity tree as
  `vscode.TreeDataProvider`s consuming `metadata.rts.{zone.agents,
  layout, event_log.runs}`. Activity tree paginates via the
  `llmnb.sidebar.activity.loadMore` command. Code under
  [src/sidebar/](src/sidebar/). See [PLAN-S7](../docs/notebook/PLAN-S7-sidebar-trees.md).
- **S8** partial inline `vscode.diff` for `propose_edit` spans
  (production code; contract tests pending).
- **S9** cell-toolbar interrupt button (SIGINT to agent process).
- **S10 (reduced V1)** (commit `b07e6f9`) — streaming/artifact cell
  badges, bulk-collapse cell toolbar buttons
  (`llmnb.collapseAllInputs` / `.collapseAllOutputs` /
  `.expandAllInputs` / `.expandAllOutputs`), find-in-cells wrapper
  command (`llmnb.findInCells`).
- **S10 follow-on** (commit `426051f`) — sidebar
  Find-in-cells WebviewView delivering the full FSP-002 §2.1 search
  UX (search box + result tree + scroll-into-view) since the literal
  "floating search bar above the editor" is blocked on VS Code API.
  See [FSP-002](../docs/notebook/FSP-002-cell-search-collapse.md) and
  [PLAN-S10](../docs/notebook/PLAN-S10-three-pane-search.md).
- **Inspect mode V1** (commit `92c7412`) — read-only per-cell view of
  the latest RunFrame + ContextManifest produced by the kernel's
  BSP-008 substrate ([atoms/concepts/run-frame.md](../docs/atoms/concepts/run-frame.md),
  [atoms/concepts/context-manifest.md](../docs/atoms/concepts/context-manifest.md)).
  Cell-toolbar status item shows `▶ <run_id> (<status>) · N cells / K
  excluded`; click opens a manifest detail QuickPick rendering the
  inclusion/exclusion trace per [BSP-008 §11](../docs/notebook/BSP-008-contextpacker-runframes.md).
  Surfaced by the `llmnb.inspect.openManifestDetail` command. Read-only
  in V1; no mutation paths. Code under [src/inspect/](src/inspect/);
  33 unit + 6 contract tests at [test/unit/inspect/](test/unit/inspect/)
  and [test/contract/inspect-cell-status.test.ts](test/contract/inspect-cell-status.test.ts).
- **V2 — branch-switching UX** (commit `667dd68`) — sidebar Branches
  subnode under each agent that has forked descendants. Lineage
  recovered from `metadata.rts.zone.event_log[*]` `fork_agent`
  envelopes (no kernel changes). See [PLAN-V2-branch-switching-ux](../docs/notebook/PLAN-V2-branch-switching-ux.md).
- **V2 — output-kind lens UI** (commit `85bd5e4`) — 5th sidebar view
  grouping every tagged span across the active notebook by `output_kind`.
  Pure read-side. Code under [src/sidebar/output-kind-lens/](src/sidebar/output-kind-lens/).
  See [PLAN-V2-output-kind-lens](../docs/notebook/PLAN-V2-output-kind-lens.md).

**Deferred:** S5.0.6 (nvim driver) deferred to whenever nvim operator
dogfooding pressure justifies the per-cell affordance — the headless
`llmnb execute --connect` CLI (commit `df95ad4`) covers file-level
operation for nvim users in the interim.

**Blocked on VS Code API:**

- Per-cell gutter color decoration — `notebookCellDecoration` is not
  even a Microsoft API proposal, per a probe against the vendored
  `vscode-jupyter`'s `enabledApiProposals`. S1 identity badges are
  surfaced via status-bar + kind-label fallback.
- The literal "floating search bar above the editor" is the same
  ceiling — no overlay-above-editor API. FSP-002 search UX shipped
  as a sidebar WebviewView instead.

See [docs/notebook/BSP-005-cell-roadmap.md §6.5](../docs/notebook/BSP-005-cell-roadmap.md#65-slice-ladder-totals-after-issue-2--and-observed-velocity-2026-05-02-update) for the
full slice ladder + observed velocity.

## Build

```
pixi run -e kernel npm --prefix extension install
pixi run -e kernel npm --prefix extension run build      # tsc → out/
pixi run -e kernel npm --prefix extension run package    # esbuild → dist/extension.js + dist/run-renderer.js
```

## Tests

Three layers ([details](test/README.md)):

```
pixi run -e kernel npm --prefix extension run test:contract   # in-Extension-Host contract tests
pixi run -e kernel npm --prefix extension run test:e2e        # WebdriverIO + real VS Code
```

The headless executor adds a fourth tier between contract and e2e —
~ms-per-test runs of the magic dispatcher + signer + wire path,
sharing the extension's actual code via the `@llmnb/cell-magic` library
boundary (no parallel implementation; see
[discipline/certified-magic-emitter](../docs/atoms/discipline/certified-magic-emitter.md)).

## Manual smoke

The extension talks to LLMKernel over the [RFC-008](../docs/rfcs/RFC-008-kernel-host-integration.md) PTY+socket transport
by default; TCP transport is the v1.0.1 alternative used by the
headless executor.

```
# 1. Open VS Code on a workspace containing a .llmnb file.
# 2. The extension registers .llmnb; opening the file activates the
#    NotebookController.
# 3. Author a cell:
#       @@spawn alpha task:"design recipe schema"
#       @pin
# 4. Run the cell — alpha spawns; OTLP spans stream into cell output.
# 5. New cell: @@agent alpha — continues the conversation via S3 stdin.
```

For offline development without a real LLMKernel, the `StubKernelClient`
is preserved behind `llmnb.kernel.useStub = true`.

## Related docs

- [docs/atoms/concepts/cell.md](../docs/atoms/concepts/cell.md) — what cells are post-S5.0.
- [docs/atoms/concepts/magic.md](../docs/atoms/concepts/magic.md) — the `@@`/`@` vocabulary.
- [docs/notebook/PLAN-S5.0-cell-magic-vocabulary.md](../docs/notebook/PLAN-S5.0-cell-magic-vocabulary.md) — the cell-magic + injection-defense plan.
- [docs/rfcs/RFC-006-kernel-extension-wire-format.md](../docs/rfcs/RFC-006-kernel-extension-wire-format.md) — kernel↔extension wire (v2.1.0).
- [docs/rfcs/RFC-008-kernel-host-integration.md](../docs/rfcs/RFC-008-kernel-host-integration.md) — host integration + TCP transport (v1.0.1).
