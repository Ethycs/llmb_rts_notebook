// Notebook serializer for the .llmnb file type.
//
// .llmnb files are .ipynb-conformant JSON per RFC-005 §"Top-level structure"
// and docs/dev-guide/07-subtractive-fork-and-storage.md ("One file: .llmnb").
// metadata.rts is preserved verbatim — this serializer is intentionally
// shallow because the kernel is the single logical writer of metadata.rts
// (RFC-005 §"Persistence strategy"). The extension's metadata-applier.ts
// (RFC-006 §8) is the only path that mutates metadata.rts from the extension
// side; the serializer's job is to round-trip the payload byte-for-byte
// through deserialize/serialize so neither this module nor any downstream
// step competes with the kernel for ownership.
//
// Cell outputs are serialized through VS Code's NotebookCellOutput shape;
// run-record outputs use MIME type application/vnd.rts.run+json (the bare
// OTLP/JSON span per RFC-006 §1, no envelope).

import * as vscode from 'vscode';
import { RTS_RUN_MIME } from '../notebook/controller.js';

interface IpynbCellRaw {
  cell_type: 'markdown' | 'code' | 'raw';
  source: string | string[];
  metadata?: Record<string, unknown>;
  outputs?: IpynbOutputRaw[];
  execution_count?: number | null;
}

interface IpynbOutputRaw {
  output_type: string;
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface IpynbDocumentRaw {
  cells: IpynbCellRaw[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformat_minor?: number;
}

export class LlmnbNotebookSerializer implements vscode.NotebookSerializer {
  public async deserializeNotebook(
    content: Uint8Array,
    _token: vscode.CancellationToken
  ): Promise<vscode.NotebookData> {
    const text = new TextDecoder('utf-8').decode(content).trim();
    const raw: IpynbDocumentRaw = text.length === 0
      ? { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }
      : (JSON.parse(text) as IpynbDocumentRaw);

    const cells: vscode.NotebookCellData[] = (raw.cells ?? []).map((c) => {
      const source = Array.isArray(c.source) ? c.source.join('') : c.source;
      const kind = c.cell_type === 'markdown'
        ? vscode.NotebookCellKind.Markup
        : vscode.NotebookCellKind.Code;
      const lang = c.cell_type === 'markdown' ? 'markdown' : 'llmnb-cell';
      const cellData = new vscode.NotebookCellData(kind, source, lang);
      // BSP-005 M1 / atoms/concepts/cell-kinds.md per-kind invariant:
      // `markdown` MUST NOT carry `bound_agent_id`. A hand-edited or
      // legacy `.llmnb` may have leaked one in; strip it on load so
      // downstream consumers (cell-badge, ContextPacker) never see a
      // markdown cell pretending to be an agent dispatch site. The
      // metadata.rts.cell.kind field, if absent on a Markup cell, is
      // resolved to "markdown" so save→reopen carries the typed value.
      cellData.metadata = c.metadata ?? {};
      if (kind === vscode.NotebookCellKind.Markup) {
        cellData.metadata = sanitizeMarkdownCellMetadata(cellData.metadata);
      }
      cellData.outputs = (c.outputs ?? []).map((o) => decodeOutput(o));
      return cellData;
    });

    const data = new vscode.NotebookData(cells);
    // Preserve metadata.rts namespace verbatim; do not rewrite or normalize.
    data.metadata = raw.metadata ?? {};
    return data;
  }

  public async serializeNotebook(
    data: vscode.NotebookData,
    _token: vscode.CancellationToken
  ): Promise<Uint8Array> {
    const raw: IpynbDocumentRaw = {
      cells: data.cells.map((c) => encodeCell(c)),
      metadata: data.metadata ?? {},
      nbformat: 4,
      nbformat_minor: 5
    };
    return new TextEncoder().encode(JSON.stringify(raw, null, 2));
  }
}

function decodeOutput(raw: IpynbOutputRaw): vscode.NotebookCellOutput {
  const items: vscode.NotebookCellOutputItem[] = [];
  const data = (raw.data ?? {}) as Record<string, unknown>;
  for (const [mime, value] of Object.entries(data)) {
    if (mime === RTS_RUN_MIME || mime.endsWith('+json') || mime === 'application/json') {
      items.push(vscode.NotebookCellOutputItem.json(value, mime));
    } else if (typeof value === 'string') {
      items.push(vscode.NotebookCellOutputItem.text(value, mime));
    } else {
      items.push(vscode.NotebookCellOutputItem.json(value, mime));
    }
  }
  return new vscode.NotebookCellOutput(items, raw.metadata ?? {});
}

function encodeCell(cell: vscode.NotebookCellData): IpynbCellRaw {
  // Symmetric to deserialize: Markup cells must not carry a leaked
  // bound_agent_id when written back to disk. The kind is also force-set
  // to "markdown" so a save→reopen cycle round-trips the typed value
  // without depending on the deserializer's defaulting fallback.
  const isMarkup = cell.kind === vscode.NotebookCellKind.Markup;
  const metadata = isMarkup
    ? sanitizeMarkdownCellMetadata(cell.metadata ?? {})
    : (cell.metadata ?? {});
  return {
    cell_type: isMarkup ? 'markdown' : 'code',
    source: cell.value,
    metadata,
    outputs: (cell.outputs ?? []).map((o) => encodeOutput(o))
  };
}

/** Strip `bound_agent_id` from a markdown cell's `metadata.rts.cell` slot
 *  per atoms/concepts/cell-kinds.md ("`markdown` MUST NOT carry
 *  `bound_agent_id`"). Also ensures `kind` resolves to `"markdown"` on
 *  the slot so cell-kinds round-trip without depending on the load-side
 *  default. Tolerates the legacy flat shape (`metadata.rts.kind`) and
 *  the namespaced shape (`metadata.rts.cell.kind`) — see
 *  cell-badge.ts:readCellMetadataSlot. Returns a new object; does not
 *  mutate the input. */
function sanitizeMarkdownCellMetadata(
  meta: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...meta };
  const rtsRaw = out['rts'];
  const rts: Record<string, unknown> =
    rtsRaw && typeof rtsRaw === 'object' && !Array.isArray(rtsRaw)
      ? { ...(rtsRaw as Record<string, unknown>) }
      : {};
  // Namespaced shape: metadata.rts.cell.{kind,bound_agent_id,...}
  const cellRaw = rts['cell'];
  if (cellRaw && typeof cellRaw === 'object' && !Array.isArray(cellRaw)) {
    const cell = { ...(cellRaw as Record<string, unknown>) };
    delete cell['bound_agent_id'];
    cell['kind'] = 'markdown';
    rts['cell'] = cell;
  } else {
    // No namespaced cell slot yet — write a minimal one so the kind is
    // explicit on disk. The cell-kinds invariant says pre-Issue-2 cells
    // default to "agent" on load when `kind` is absent; for Markup cells
    // we write the kind eagerly so VS Code's native Markup → atoms
    // `markdown` mapping survives cleanly across rounds.
    rts['cell'] = { kind: 'markdown' };
  }
  // Legacy flat shape: metadata.rts.{kind,bound_agent_id,...}
  if ('bound_agent_id' in rts) {
    delete rts['bound_agent_id'];
  }
  if (typeof rts['kind'] === 'string') {
    rts['kind'] = 'markdown';
  }
  out['rts'] = rts;
  return out;
}

function encodeOutput(out: vscode.NotebookCellOutput): IpynbOutputRaw {
  const data: Record<string, unknown> = {};
  for (const item of out.items) {
    const mime = item.mime;
    const text = new TextDecoder('utf-8').decode(item.data);
    if (mime === RTS_RUN_MIME || mime.endsWith('+json') || mime === 'application/json') {
      try {
        data[mime] = JSON.parse(text);
      } catch {
        data[mime] = text;
      }
    } else {
      data[mime] = text;
    }
  }
  return {
    output_type: 'display_data',
    data,
    metadata: out.metadata ?? {}
  };
}
