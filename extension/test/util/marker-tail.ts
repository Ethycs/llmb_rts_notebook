// FSP-003 Pillar A — marker-file tail helper.
//
// The extension and kernel both append JSONL diagnostic events to the
// marker file (path exposed via `LLMNB_MARKER_FILE`, with backward-
// compatible fallback to `LLMNB_E2E_MARKER_FILE`) during their
// lifecycles. Each event is `{ts, component, event, ...}` per FSP-003 §1.
// When a typed-wait helper times out, it reads the last N lines via
// `readMarkerTail` and embeds them in the K-coded failure message so
// the operator sees what the test infra last observed before the
// deadline expired.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Default tail length per FSP-003 §1 ("last 50 lines"). */
export const DEFAULT_MARKER_TAIL_LINES = 50;

/** Resolve the active marker-file path. Returns `undefined` when neither
 *  env var is set (production builds; not a test context). */
export function getMarkerFilePath(): string | undefined {
  return process.env.LLMNB_MARKER_FILE ?? process.env.LLMNB_E2E_MARKER_FILE;
}

/** Allocate a fresh marker file under the OS tempdir and set
 *  `LLMNB_MARKER_FILE` for child processes (PtyKernelClient inherits via
 *  node-pty's env spread). The path is suite-scoped so two tiers running
 *  serially don't read each other's events. The `LLMNB_E2E_MARKER_FILE`
 *  alias stays in sync for the legacy kernel writer (`_diagnostics.mark()`). */
export function ensureMarkerFile(sessionId: string): string {
  const existing = getMarkerFilePath();
  if (existing) {
    return existing;
  }
  const target = path.join(
    os.tmpdir(),
    `llmnb-marker-${sessionId}-${process.pid}.jsonl`
  );
  process.env.LLMNB_MARKER_FILE = target;
  process.env.LLMNB_E2E_MARKER_FILE = target;
  return target;
}

export interface MarkerEvent {
  ts: number | undefined;
  component: string | undefined;
  event: string | undefined;
  /** The kernel writer historically uses `stage` instead of `event`; the
   *  reader normalizes both into `event` so test consumers don't branch. */
  stage?: string;
  [k: string]: unknown;
}

/** Return the last `n` parsed events from the marker file. Unparseable
 *  lines are surfaced as `{event: '(unparseable)', raw: <line>}` so the
 *  test infra can still print them in a failure dump. Returns `[]` if
 *  the file doesn't exist or no env var is set. */
export function readMarkerTail(n: number = DEFAULT_MARKER_TAIL_LINES): MarkerEvent[] {
  const target = getMarkerFilePath();
  if (!target) {
    return [];
  }
  let raw: string;
  try {
    raw = fs.readFileSync(target, 'utf-8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter((l) => l.length > 0);
  const slice = lines.slice(-n);
  const out: MarkerEvent[] = [];
  for (const line of slice) {
    try {
      const parsed = JSON.parse(line) as MarkerEvent;
      // Normalize legacy `stage` field into `event` for typed-wait dumps.
      if (parsed.event === undefined && typeof parsed.stage === 'string') {
        parsed.event = parsed.stage;
      }
      out.push(parsed);
    } catch {
      out.push({
        ts: undefined,
        component: undefined,
        event: '(unparseable)',
        raw: line
      });
    }
  }
  return out;
}

/** Pretty-print marker tail for inclusion in a K-coded error message.
 *  Each line is prefixed with the elapsed time relative to the first
 *  event in the slice so the operator sees relative ordering at a glance. */
export function formatMarkerTail(events: MarkerEvent[]): string {
  if (events.length === 0) {
    const target = getMarkerFilePath();
    return target
      ? `(marker file ${target} empty or unreadable)`
      : '(no marker file env var set)';
  }
  const baseTs = events[0].ts;
  const lines: string[] = [];
  for (const e of events) {
    const dt =
      typeof e.ts === 'number' && typeof baseTs === 'number'
        ? `+${(e.ts - baseTs).toString().padStart(5, ' ')}ms`
        : '       ';
    const comp = e.component ?? '?';
    const ev = e.event ?? '?';
    const rest: Record<string, unknown> = { ...e };
    delete rest.ts;
    delete rest.component;
    delete rest.event;
    delete rest.stage;
    const restStr = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
    lines.push(`  ${dt} ${comp}/${ev}${restStr}`);
  }
  return lines.join('\n');
}
