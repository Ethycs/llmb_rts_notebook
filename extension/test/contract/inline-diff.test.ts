// Contract tests for BSP-005 S8 — inline `vscode.diff` for `propose_edit`.
//
// S8 production code shipped in commit 8d9bd39 across:
//   - extension/src/renderers/components/approval.ts (`renderProposeEdit`)
//   - extension/src/renderers/components/index.ts    (registration)
//   - extension/src/renderers/run-renderer.ts        (`propose_edit` dispatch
//                                                     + `approval_id` /
//                                                     `proposed_content` param
//                                                     wiring in collectParams)
//
// This suite locks the operator-visible contract for that slice:
//   1. A `propose_edit` span renders a "Review diff" affordance.
//   2. The Review-diff button carries the data attributes the host bridge
//      needs to hand off to `vscode.commands.executeCommand("vscode.diff",
//      left, right, title)` (see FLAG below — the host bridge that
//      translates `propose_edit_review` → `vscode.diff` does NOT exist in
//      the shipped code; the renderer side of the contract is asserted
//      here, with the bridge slated for a follow-up slice).
//   3+4. Approve / Reject buttons render the `approval_response` envelope
//        encoding (action_type, decision, run_id, approval_id) so that
//        `installDelegatedHandlers` + `collectParams` in run-renderer.ts
//        will post the locked operator.action shape on click.
//   5. When the kernel re-emits the span with `decision_recorded: true`
//      (surfaced via `llmnb.approval.decision_recorded` attribute), the
//      buttons are hidden — re-renders are idempotent.
//
// Spec references:
//   docs/atoms/concepts/span.md            — span IS-A run record
//   docs/atoms/concepts/tool-call.md       — args at `input.value` JSON
//   docs/atoms/protocols/operator-action.md — `approval_response` envelope
//                                             ({run_id, decision, modification?})
//   docs/notebook/BSP-005-cell-roadmap.md §S8 — slice scope
//
// Test style mirrors mime-renderer.test.ts and agent-emit-renderer.test.ts:
// load the built renderer bundle and assert on the produced HTML. Click
// dispatch is NOT simulated end-to-end because the Extension Host runtime
// has no DOM (no jsdom/happy-dom dep) and the contract test file is
// forbidden from introducing util files. Instead, the data-attribute
// surface that drives `installDelegatedHandlers` is asserted directly —
// that surface is the renderer's externally-visible contract with the
// host bridge.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import type { OtlpSpan } from '../../src/otel/attrs.js';
import { encodeAttrs } from '../../src/otel/attrs.js';

/** extension/dist/run-renderer.js, regardless of compiled-out depth. */
const RENDERER_BUNDLE: string = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'dist',
  'run-renderer.js'
);

interface RendererModule {
  activate: (ctx: unknown) => {
    renderOutputItem: (item: OutputItemLike, element: HTMLElement) => void;
  };
}

interface OutputItemLike {
  mime: string;
  json(): unknown;
  text(): string;
  data: Uint8Array;
}

function makeStubItem(payload: unknown): OutputItemLike {
  const text = JSON.stringify(payload);
  return {
    mime: 'application/vnd.rts.run+json',
    json: (): unknown => payload,
    text: (): string => text,
    data: new TextEncoder().encode(text)
  };
}

function makeStubElement(): { innerHTML: string; textContent: string } {
  return { innerHTML: '', textContent: '' };
}

const SAMPLE_TRACE_ID = 'a'.repeat(32);
const SAMPLE_SPAN_ID = 'b'.repeat(16);
const APPROVAL_ID = 'apr_01HZX8S8R3VIEWDIFF';

/** Build an open `propose_edit` tool span. The renderer reads `tool.name`
 *  and the `input.value` JSON for tool args; `llmnb.approval.decision_recorded`
 *  is the kernel-managed flag the run-renderer projects into args as
 *  `decision_recorded: true` for the propose_edit renderer to honor. */
function proposeEditSpan(opts: {
  path: string;
  proposedContent: string;
  approvalId?: string;
  summary?: string;
  decisionRecorded?: boolean;
}): OtlpSpan {
  const args: Record<string, unknown> = {
    path: opts.path,
    proposed_content: opts.proposedContent,
    approval_id: opts.approvalId ?? APPROVAL_ID
  };
  if (opts.summary !== undefined) args['summary'] = opts.summary;
  const baseAttrs: Record<string, string> = {
    'llmnb.run_type': 'tool',
    'tool.name': 'propose_edit',
    'input.value': JSON.stringify(args),
    'input.mime_type': 'application/json'
  };
  if (opts.decisionRecorded) {
    baseAttrs['llmnb.approval.decision_recorded'] = 'true';
  }
  return {
    traceId: SAMPLE_TRACE_ID,
    spanId: SAMPLE_SPAN_ID,
    name: 'propose_edit',
    kind: 'SPAN_KIND_INTERNAL',
    startTimeUnixNano: '1745588938302000000',
    endTimeUnixNano: null,
    attributes: encodeAttrs(baseAttrs),
    status: { code: 'STATUS_CODE_UNSET', message: '' }
  };
}

suite('contract: BSP-005 S8 — inline vscode.diff for propose_edit', () => {
  let renderer: ReturnType<RendererModule['activate']> | undefined;

  suiteSetup(async function (): Promise<void> {
    if (!fs.existsSync(RENDERER_BUNDLE)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[inline-diff.test] ${RENDERER_BUNDLE} missing — run \`npm run package:renderer\` first; skipping`
      );
      this.skip();
      return;
    }
    const mod = (await import(url.pathToFileURL(RENDERER_BUNDLE).href)) as RendererModule;
    renderer = mod.activate({});
  });

  // --------------------------------------------------------------------------
  // 1. Review-diff affordance present
  // --------------------------------------------------------------------------

  test('test_propose_edit_span_renders_review_button', () => {
    // Fixture: an open `propose_edit` span with a path and proposed bytes.
    // The renderer MUST surface a "Review diff" affordance that the host
    // bridge can wire to `vscode.diff`.
    assert.ok(renderer);
    const span = proposeEditSpan({
      path: 'src/foo.ts',
      proposedContent: 'export const answer = 42;\n',
      summary: 'src/foo.ts: +1 -0'
    });
    const el = makeStubElement() as unknown as HTMLElement;
    renderer!.renderOutputItem(makeStubItem(span), el);
    assert.ok(el.innerHTML.length > 0, 'innerHTML must be non-empty');
    // The button label is the operator-visible affordance per BSP-005 §S8.
    assert.ok(
      el.innerHTML.includes('Review diff'),
      `expected "Review diff" affordance in ${el.innerHTML}`
    );
    // The card is tagged with the propose_edit tool name so CSS / future
    // host bridges can locate it. (Hidden in the run-renderer dispatch via
    // `data-rts-tool="propose_edit"`.)
    assert.ok(
      el.innerHTML.includes('data-rts-tool="propose_edit"'),
      `expected data-rts-tool="propose_edit" in ${el.innerHTML}`
    );
    // The path appears in the card title for operator orientation.
    assert.ok(
      el.innerHTML.includes('src/foo.ts'),
      `expected path "src/foo.ts" in ${el.innerHTML}`
    );
  });

  // --------------------------------------------------------------------------
  // 2. Review-diff button carries the data the host bridge needs
  // --------------------------------------------------------------------------

  test('test_review_button_click_opens_vscode_diff', () => {
    // CONTRACT FLAG:
    //   The original brief asked us to mock `vscode.commands.executeCommand`
    //   and verify a `vscode.diff` invocation. The shipped production code
    //   does NOT contain a host-side bridge that translates the renderer-
    //   emitted `propose_edit_review` operator.action into a `vscode.diff`
    //   call (the comment in approval.ts references a `propose-edit-host.ts`
    //   that doesn't exist in the tree as of commit 8d9bd39). What ships is
    //   the renderer half: the Review-diff button posts a `propose_edit_review`
    //   envelope with the path + proposed_content payload, and a future
    //   slice will add the host bridge that consumes it.
    //
    //   This test therefore asserts the renderer half of the contract: the
    //   "Review diff" button carries the data attributes that
    //   `installDelegatedHandlers` + `collectParams` in run-renderer.ts will
    //   read on click to produce the operator.action envelope. If those
    //   attributes drift, the host bridge — once added — would fire
    //   `vscode.diff` with the wrong URIs/title, regardless of unit tests
    //   it ships with.
    assert.ok(renderer);
    const span = proposeEditSpan({
      path: 'src/foo.ts',
      proposedContent: 'export const answer = 42;\n'
    });
    const el = makeStubElement() as unknown as HTMLElement;
    renderer!.renderOutputItem(makeStubItem(span), el);
    const html = el.innerHTML;
    // The Review-diff button is the action source. It MUST tag itself with
    // a kernel-bound `data-rts-action` so the delegated click handler emits
    // an operator.action envelope. The action_type is the V1 placeholder
    // until the host bridge ships; do NOT regress this string without
    // updating the bridge in lockstep.
    assert.ok(
      /<button[^>]+data-rts-action="propose_edit_review"[^>]*>Review diff<\/button>/.test(html),
      `expected Review-diff button with data-rts-action="propose_edit_review" in ${html}`
    );
    // Path is required for the LEFT URI of `vscode.diff` (current file
    // on disk). Approval-id correlates back to the kernel-issued decision.
    assert.ok(
      html.includes('data-rts-path="src/foo.ts"'),
      `expected data-rts-path="src/foo.ts" in ${html}`
    );
    assert.ok(
      html.includes(`data-rts-approval-id="${APPROVAL_ID}"`),
      `expected data-rts-approval-id on Review-diff button in ${html}`
    );
    // The proposed bytes for the RIGHT pane of `vscode.diff` are stashed
    // in a hidden textarea with the `rts-propose-edit-payload` class —
    // collectParams() reads it through `data-rts-input-id` and surfaces
    // it under `parameters.proposed_content` so the eventual host bridge
    // doesn't need to round-trip back to the kernel for the bytes.
    assert.ok(
      /data-rts-input-id="[^"]*propose_edit[^"]*"/.test(html),
      `expected data-rts-input-id pointing at the proposed-content textarea in ${html}`
    );
    assert.ok(
      /<textarea[^>]+class="rts-propose-edit-payload"[^>]+hidden[^>]*>export const answer = 42;\n<\/textarea>/.test(
        html
      ),
      `expected hidden textarea carrying the proposed bytes in ${html}`
    );
  });

  // --------------------------------------------------------------------------
  // 3. Approve button encodes the `approval_response` envelope
  // --------------------------------------------------------------------------

  test('test_approve_posts_approval_response_envelope', () => {
    // CONTRACT FLAG (same as test 2):
    //   The Extension Host test runtime has no DOM, so the click event is
    //   not dispatched here. The assertions below cover the data-attribute
    //   surface that `installDelegatedHandlers` + `collectParams` in
    //   run-renderer.ts read to produce the
    //   `{type: "operator.action", payload: {action_type: "approval_response",
    //     parameters: {run_id, decision: "approve", approval_id}}}` envelope
    //   that ships to the kernel. The atom catalogue
    //   (`docs/atoms/protocols/operator-action.md`) names approval_response
    //   parameters as `{run_id, decision, modification?}`; `approval_id` is
    //   the BSP-005 §S8 addition for correlating the decision back to the
    //   originating tool call.
    assert.ok(renderer);
    const span = proposeEditSpan({
      path: 'src/foo.ts',
      proposedContent: 'export const answer = 42;\n'
    });
    const el = makeStubElement() as unknown as HTMLElement;
    renderer!.renderOutputItem(makeStubItem(span), el);
    const html = el.innerHTML;
    // The Approve button MUST be present (no decision yet) and MUST encode
    // action_type=approval_response + decision=approve + the approval_id.
    assert.ok(
      /<button[^>]+class="rts-button-approve"[^>]+data-rts-action="approval_response"[^>]+data-rts-decision="approve"[^>]*>Approve<\/button>/.test(
        html
      ),
      `expected Approve button with approval_response/approve attributes in ${html}`
    );
    // approval_id is on the Approve button so collectParams attaches it to
    // the outbound envelope's parameters.approval_id (per the BSP-005 §S8
    // collectParams branch in run-renderer.ts).
    const approveMatch = html.match(
      /<button[^>]+class="rts-button-approve"[^>]+data-rts-action="approval_response"[^>]*>/
    );
    assert.ok(approveMatch, 'approve button must be findable');
    assert.ok(
      approveMatch![0].includes(`data-rts-approval-id="${APPROVAL_ID}"`),
      `approve button must carry data-rts-approval-id="${APPROVAL_ID}" — got ${approveMatch![0]}`
    );
    // run_id is the OTLP spanId — the renderer threads it through as the
    // `data-rts-run-id` attribute the click handler reads first when
    // populating the envelope's parameters.run_id slot.
    assert.ok(
      approveMatch![0].includes(`data-rts-run-id="${SAMPLE_SPAN_ID}"`),
      `approve button must carry data-rts-run-id (span id) — got ${approveMatch![0]}`
    );
  });

  // --------------------------------------------------------------------------
  // 4. Reject button encodes the `approval_response` envelope
  // --------------------------------------------------------------------------

  test('test_reject_posts_approval_response_envelope', () => {
    // Mirror of test 3 for decision=reject. Same FLAG re: no DOM in the
    // Extension Host runtime — the assertions cover the data-attribute
    // contract that drives the click → envelope translation.
    assert.ok(renderer);
    const span = proposeEditSpan({
      path: 'src/foo.ts',
      proposedContent: 'export const answer = 42;\n'
    });
    const el = makeStubElement() as unknown as HTMLElement;
    renderer!.renderOutputItem(makeStubItem(span), el);
    const html = el.innerHTML;
    assert.ok(
      /<button[^>]+class="rts-button-reject"[^>]+data-rts-action="approval_response"[^>]+data-rts-decision="reject"[^>]*>Reject<\/button>/.test(
        html
      ),
      `expected Reject button with approval_response/reject attributes in ${html}`
    );
    const rejectMatch = html.match(
      /<button[^>]+class="rts-button-reject"[^>]+data-rts-action="approval_response"[^>]*>/
    );
    assert.ok(rejectMatch, 'reject button must be findable');
    assert.ok(
      rejectMatch![0].includes(`data-rts-approval-id="${APPROVAL_ID}"`),
      `reject button must carry data-rts-approval-id="${APPROVAL_ID}" — got ${rejectMatch![0]}`
    );
    assert.ok(
      rejectMatch![0].includes(`data-rts-run-id="${SAMPLE_SPAN_ID}"`),
      `reject button must carry data-rts-run-id (span id) — got ${rejectMatch![0]}`
    );
  });

  // --------------------------------------------------------------------------
  // 5. Idempotent re-render: already-decided propose_edit hides buttons
  // --------------------------------------------------------------------------

  test('test_already_decided_propose_edit_hides_buttons', () => {
    // The kernel re-emits the propose_edit span with the
    // `llmnb.approval.decision_recorded=true` attribute once it observes
    // the operator's Approve / Reject. The run-renderer dispatch projects
    // that into args as `decision_recorded: true`, and renderProposeEdit
    // swaps the button row for a "decision recorded." stub — so re-renders
    // (last-writer-wins, RFC-006 §1) are idempotent and the operator can't
    // double-click an already-resolved approval.
    assert.ok(renderer);
    const span = proposeEditSpan({
      path: 'src/foo.ts',
      proposedContent: 'export const answer = 42;\n',
      decisionRecorded: true
    });
    const el = makeStubElement() as unknown as HTMLElement;
    renderer!.renderOutputItem(makeStubItem(span), el);
    const html = el.innerHTML;
    // Buttons MUST be absent.
    assert.ok(
      !/data-rts-action="propose_edit_review"/.test(html),
      `Review-diff button MUST be hidden after decision recorded — got ${html}`
    );
    assert.ok(
      !/<button[^>]+class="rts-button-approve"/.test(html),
      `Approve button MUST be hidden after decision recorded — got ${html}`
    );
    assert.ok(
      !/<button[^>]+class="rts-button-reject"/.test(html),
      `Reject button MUST be hidden after decision recorded — got ${html}`
    );
    // The card is tagged so CSS / inspectors can recognise the
    // already-decided state (set by renderProposeEdit when args
    // .decision_recorded is true).
    assert.ok(
      html.includes('data-rts-decision-recorded="true"'),
      `expected data-rts-decision-recorded="true" on the card in ${html}`
    );
    // Operator-visible "decision recorded." stub remains so the cell does
    // not just go blank.
    assert.ok(
      html.includes('decision recorded.'),
      `expected "decision recorded." stub in ${html}`
    );
  });
});
