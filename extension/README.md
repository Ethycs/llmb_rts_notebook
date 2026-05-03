# `extension/` — VS Code extension

V1 VS Code extension for `.llmnb` notebooks. Subtractive fork output
of [`vendor/vscode-jupyter`](../vendor/vscode-jupyter/) per
[DR-0011](../docs/decisions/0011-subtractive-fork-vscode-jupyter.md)
and [chapter 07](../docs/dev-guide/07-subtractive-fork-and-storage.md).

## Status — operationally functional (2026-05-02)

V1 substrate is shipped. Extension registers a single
`NotebookController` for `.llmnb`, dispatches via the cell-magic
vocabulary (`@@spawn`, `@@agent`, `@<flag>` line-magic), and rides
RFC-006 v2.1.0 wire format on the kernel side.

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
- **S8** partial inline `vscode.diff` for `propose_edit` spans
  (production code; contract tests pending).
- **S9** cell-toolbar interrupt button (SIGINT to agent process).

Queued: S5.5 sections, S6 cell↔turn binding write-back + RunFrame
minimal, S7 sidebar trees, S8 finishing, S10 three-pane mental model +
FSP-002 search/collapse.

S5c-stop (`/stop` semantics) is in flight on the kernel submodule
branch `vendor/LLMKernel @ wip/s5c-stop`.

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
