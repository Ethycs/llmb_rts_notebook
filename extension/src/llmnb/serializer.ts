// Notebook serializer for the .llmnb file type.
//
// .llmnb files are .ipynb-conformant JSON per
// docs/dev-guide/07-subtractive-fork-and-storage.md ("One file: .llmnb").
// metadata.rts is preserved verbatim — this serializer is intentionally
// shallow because the kernel is the single logical writer of metadata.rts.
//
// Cell outputs are serialized through VS Code's NotebookCellOutput shape;
// the run-record outputs use MIME type application/vnd.rts.run+json.

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
      cellData.metadata = c.metadata ?? {};
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
  return {
    cell_type: cell.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'code',
    source: cell.value,
    metadata: cell.metadata ?? {},
    outputs: (cell.outputs ?? []).map((o) => encodeOutput(o))
  };
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
