// PtyKernelClient — RFC-008 §8 reference implementation.
//
// Replaces the R1-era JupyterKernelClient (which used @jupyterlab/services to
// talk to a Jupyter Server). RFC-008 §9 drops that dependency entirely; the
// extension now spawns LLMKernel as a subprocess via `node-pty` and binds two
// transports:
//
//   - Control plane (PTY): boot output, fatal tracebacks, SIGINT/SIGTERM
//     delivery via `proc.kill('...')`. Fed verbatim into the optional
//     `vscode.Pseudoterminal` debug panel (kernel-terminal.ts).
//   - Data plane (socket): RFC-006 v2 wire format as newline-delimited JSON.
//     Three frame shapes, dispatched per RFC-008 §6:
//       * traceId+spanId           → routeRunMime (Family A)
//       * timeUnixNano+severityNum → routeLogRecord (RFC-008 §6 frame B)
//       * type+payload             → router.route (Family B–F)
//
// The `KernelClient` interface stays exactly as the controller uses it
// (`connect?`, `executeCell`); the implementation rotates underneath. Outbound
// envelopes ship via `sendEnvelope()` — same signature the activation glue
// already wires for the StubKernelClient.
//
// Spec references throughout cite RFC-008 §X — see docs/rfcs/RFC-008-*.md.

import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type {
  KernelClient,
  KernelExecuteRequest,
  KernelEventSink
} from './controller.js';
import type { MessageRouter } from '../messaging/router.js';
import type {
  RtsV2Envelope,
  RunMimePayload,
  OtlpLogRecord
} from '../messaging/types.js';
import { encodeAttrs } from '../otel/attrs.js';

// `node-pty` is loaded lazily. The native binding builds at install time and
// may be missing on platforms without a working ConPTY / forkpty. Tests inject
// a fake via `__setPtyModule` before constructing the client; production code
// loads the real module on first spawn.
type PtyModule = typeof import('node-pty');
let _ptyModule: PtyModule | undefined;
let _ptyOverride: PtyModuleLike | undefined;

interface PtyModuleLike {
  spawn(file: string, args: string[], options: PtySpawnOptions): IPtyLike;
}

interface PtySpawnOptions {
  name?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
}

/** Subset of node-pty's IPty surface this module needs. */
export interface IPtyLike {
  readonly pid: number;
  onData(cb: (data: string) => void): { dispose(): void } | void;
  onExit(
    cb: (event: { exitCode: number; signal?: number | undefined }) => void
  ): { dispose(): void } | void;
  write(data: string): void;
  resize?(cols: number, rows: number): void;
  kill(signal?: string): void;
}

/** Test seam (RFC-008 §"Tests"): inject a fake node-pty module so the contract
 *  test suite can run without the native binding. Production code must NOT
 *  call this. */
export function __setPtyModule(mod: PtyModuleLike | undefined): void {
  _ptyOverride = mod;
}

/** Resolve the active node-pty module; lazily require()s the real package. */
function getPtyModule(): PtyModuleLike {
  if (_ptyOverride) {
    return _ptyOverride;
  }
  if (!_ptyModule) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _ptyModule = require('node-pty') as PtyModule;
  }
  return _ptyModule as unknown as PtyModuleLike;
}

/** Configuration injected by extension.ts. Keeps the constructor's surface
 *  stable while letting tests parameterise spawn behaviour. */
export interface PtyKernelConfig {
  /** Stable session id; per RFC-008 §2 this drives socket address allocation
   *  and matches `metadata.rts.session_id` from RFC-005. */
  sessionId: string;
  /** Absolute path to the python interpreter; from `llmnb.kernel.pythonPath`. */
  pythonPath: string;
  /** Process working directory for the kernel; defaults to the workspace
   *  root. */
  cwd?: string;
  /** Override for the socket address. When set, replaces the platform-default
   *  computed in `allocateSocketAddress()`. */
  socketAddress?: string;
  /** Override for the spawn argv tail. Default: `["-m", "llm_kernel", "pty-mode"]`. */
  argv?: string[];
  /** Override the ready-handshake timeout (ms). RFC-008 §4 mandates 30_000 in
   *  production; tests may shorten. */
  readyTimeoutMs?: number;
  /** Override the SIGTERM grace window after `shutdown_request`. RFC-008
   *  §"Failure modes" K11 — 5s before SIGTERM, 10s total before SIGKILL. */
  shutdownGraceMs?: number;
}

/** Inbound Comm sink used by the activation glue: the kernel client forwards
 *  decoded thin envelopes here so the router can dispatch by `type`. Mirrors
 *  the historical CommEnvelopeSink shape from JupyterKernelClient. */
export interface CommEnvelopeSink {
  emit(envelope: RtsV2Envelope<unknown>): void;
}

/** Drift event surfaced from the ready handshake (RFC-005 §"Resume-time RFC
 *  version check"). The activation glue forwards these to the metadata-applier
 *  surface; tests inspect them directly. */
export interface KernelDriftEvent {
  /** Wire field name, e.g. `llmnb.kernel.rfc_006_version`. */
  attribute: string;
  /** Version string the extension expects to see. */
  expected: string;
  /** Version string observed on the wire. */
  observed: string;
  /** Severity classification per RFC-005 — major mismatches are blocking. */
  severity: 'major_mismatch' | 'minor_mismatch' | 'unknown';
}

/** What the client tells listeners when the PTY emits text (boot banner,
 *  fatal traceback, REPL output). The Pseudoterminal panel subscribes here. */
export type PtyDataListener = (chunk: string) => void;

/** Frame parser dispatch table (per RFC-008 §6). The kernel client owns this
 *  but exposes the type so tests can assert dispatch precedence. */
export type FrameKind = 'span' | 'log_record' | 'envelope' | 'malformed';

/** Per-RFC version expectation map. The extension declares the RFC versions
 *  it implements; the ready handshake's `llmnb.kernel.rfc_NNN_version` keys
 *  are compared one-by-one. */
export const EXTENSION_RFC_VERSIONS: Record<string, string> = {
  // Keep in sync with the RFC docket; extension implements RFC-005..008 v1/v2.
  rfc_005_version: '1.0.0',
  rfc_006_version: '2.0.0',
  rfc_007_version: '1.0.0',
  rfc_008_version: '1.0.0'
};

/** Default ready-handshake timeout (RFC-008 §4). */
const DEFAULT_READY_TIMEOUT_MS = 30_000;
/** Default shutdown grace window (RFC-008 §"Failure modes" K11). */
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

export class PtyKernelClient implements KernelClient {
  /** Driven by §8 — a single PTY for the kernel subprocess. */
  private ptyProcess: IPtyLike | undefined;
  /** Listening server; accepts the kernel's first (and only) connection. */
  private server: net.Server | undefined;
  /** Active duplex stream from the kernel. RFC-008 §2 forbids multi-client. */
  private socket: net.Socket | undefined;
  /** Buffer for incoming bytes; framed on `\n`. */
  private incomingBuffer: string = '';
  /** Resolves when the kernel emits the `kernel.ready` LogRecord. */
  private readyPromise: Promise<void> | undefined;
  private readyResolve: (() => void) | undefined;
  private readyReject: ((err: Error) => void) | undefined;
  private readyTimer: NodeJS.Timeout | undefined;
  /** Buffer envelopes queued for send while the socket is still connecting. */
  private outboundBuffer: RtsV2Envelope<unknown>[] = [];
  /** PTY-data listeners; the kernel-terminal panel subscribes here. */
  private readonly ptyDataListeners: PtyDataListener[] = [];
  /** Drift events captured on the ready handshake. */
  private driftEvents: KernelDriftEvent[] = [];
  /** Inbound Comm forwarder; activation glue plumbs the router's `route()` here. */
  private commSink: CommEnvelopeSink | undefined;
  /** V1: at most one inflight cell. Multi-cell parallelism deferred. */
  private activeRunSink: KernelEventSink | undefined;
  /** Last span emission per traceId — used to find the right cell sink for
   *  a streaming run. V1 only inspects the most-recent traceId. */
  private lastTraceId: string | undefined;
  /** Set when shutdown() has been called; stops the readyTimer from firing. */
  private disposed = false;
  /** Resolved socket address (UDS path / pipe / tcp:host:port). */
  private readonly socketAddress: string;
  private readonly readyTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private readonly emitter = new vscode.EventEmitter<KernelDriftEvent>();
  /** Public driftSurface so the activation glue can fan drift events into
   *  the metadata-applier (RFC-005 §"Resume-time RFC version check"). */
  public readonly onDrift = this.emitter.event;

  public constructor(
    private readonly config: PtyKernelConfig,
    private readonly router: MessageRouter,
    private readonly logger: vscode.LogOutputChannel
  ) {
    this.socketAddress = config.socketAddress ?? this.allocateSocketAddress();
    this.readyTimeoutMs = config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.shutdownGraceMs = config.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  }

  /** RFC-008 §2 — allocate the socket address per platform. UDS path on
   *  POSIX, named pipe on Windows. The fallback to loopback TCP is reserved
   *  for future use; V1 sticks with UDS / pipe. */
  public allocateSocketAddress(): string {
    if (process.platform === 'win32') {
      return `\\\\.\\pipe\\llmnb-${this.config.sessionId}`;
    }
    const dir = process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
    return path.join(dir, `llmnb-${this.config.sessionId}.sock`);
  }

  public getSocketAddress(): string {
    return this.socketAddress;
  }

  public getDriftEvents(): readonly KernelDriftEvent[] {
    return this.driftEvents.slice();
  }

  /** Activation glue forwards inbound Comm envelopes into the router via
   *  this sink. Mirrors the JupyterKernelClient surface. */
  public setCommSink(sink: CommEnvelopeSink): void {
    this.commSink = sink;
  }

  /** Subscribe to PTY data; the kernel-terminal panel uses this to mirror
   *  the kernel's stdout/stderr into the operator-facing terminal. */
  public onPtyData(listener: PtyDataListener): vscode.Disposable {
    this.ptyDataListeners.push(listener);
    return new vscode.Disposable(() => {
      const idx = this.ptyDataListeners.indexOf(listener);
      if (idx >= 0) {
        this.ptyDataListeners.splice(idx, 1);
      }
    });
  }

  /** Forward an operator keystroke into the kernel's PTY stdin. V1 the
   *  kernel discards these; V2 wires up a REPL. */
  public writePtyInput(data: string): void {
    this.ptyProcess?.write(data);
  }

  // --- KernelClient implementation -----------------------------------------

  public async connect(): Promise<void> {
    return this.start();
  }

  /** RFC-008 §4 — full lifecycle: listen → spawn → wait for ready handshake. */
  public async start(): Promise<void> {
    if (this.readyPromise) {
      return this.readyPromise;
    }
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    try {
      await this.listenSocket();
      this.spawnKernel();
      this.armReadyTimeout();
    } catch (err) {
      this.failReady(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
    return this.readyPromise;
  }

  /** RFC-008 §5 — operator interrupt. SIGINT over the PTY foreground process
   *  semantics. The kernel's handler emits a structured
   *  `kernel.interrupt_handled` LogRecord on the data plane. */
  public interrupt(): void {
    if (!this.ptyProcess) {
      this.logger.warn('[pty-kernel] interrupt(): no PTY process');
      return;
    }
    try {
      this.ptyProcess.kill('SIGINT');
    } catch (err) {
      this.logger.error(`[pty-kernel] SIGINT delivery threw: ${String(err)}`);
    }
  }

  /** RFC-008 §"Failure modes" K11 + §4 — clean shutdown sequence:
   *
   *    1. send `kernel.shutdown_request` envelope on the data plane;
   *    2. wait for the kernel's final snapshot + `shutting_down` LogRecord;
   *    3. SIGTERM the PTY if no clean exit within `shutdownGraceMs`;
   *    4. SIGKILL after the full grace window (10s total).
   */
  public async shutdown(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelReadyTimeout();

    // Best-effort: send the shutdown envelope. The router-side path will be
    // wired by extension.ts; here we ship through our own writer.
    try {
      this.writeFrame({ type: 'kernel.shutdown_request', payload: {} } as RtsV2Envelope<unknown>);
    } catch (err) {
      this.logger.warn(`[pty-kernel] shutdown_request write threw: ${String(err)}`);
    }

    const exitPromise = new Promise<void>((resolve) => {
      const proc = this.ptyProcess;
      if (!proc) {
        resolve();
        return;
      }
      const handler = proc.onExit(() => resolve());
      // node-pty's onExit returns void on some platforms; guard-cast.
      if (handler && typeof (handler as { dispose?: () => void }).dispose === 'function') {
        // Disposable cleanup is implicit on process exit.
      }
    });

    const sigtermTimer = setTimeout(() => {
      try {
        this.ptyProcess?.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }, this.shutdownGraceMs);
    const sigkillTimer = setTimeout(() => {
      try {
        this.ptyProcess?.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, this.shutdownGraceMs * 2);

    try {
      await exitPromise;
    } finally {
      clearTimeout(sigtermTimer);
      clearTimeout(sigkillTimer);
      this.dispose();
    }
  }

  public async disconnect(): Promise<void> {
    return this.shutdown();
  }

  public dispose(): void {
    this.cancelReadyTimeout();
    try {
      this.socket?.end();
      this.socket?.destroy();
    } catch {
      /* ignore */
    }
    try {
      this.server?.close();
    } catch {
      /* ignore */
    }
    this.socket = undefined;
    this.server = undefined;
    this.emitter.dispose();
  }

  /** RFC-008 §8 — outbound envelope serializer: JSON-stringify, append `\n`,
   *  write to the socket. Single-threaded (Node), so no locking. */
  public async sendEnvelope(envelope: RtsV2Envelope<unknown>): Promise<void> {
    this.writeFrame(envelope);
  }

  /** Execute one cell. Translates to an `operator.action` envelope on the
   *  data plane (RFC-006 Family D). The kernel-side dispatcher resolves the
   *  cell into runs and emits Family A spans back via the same socket.
   *
   *  When the cell carries a parsed `directive` (e.g. `/spawn`), we ship a
   *  structured `agent_spawn` action_type that the kernel's K-MCP handler
   *  routes to AgentSupervisor.spawn. Otherwise we ship a `cell_edit`
   *  no-op (logged kernel-side; spans still flow if the agent is already
   *  active in the zone).
   *
   *  RFC-006 §6 v2.0.3 amends the operator.action enum to include
   *  `agent_spawn` (additive). The kernel handler that drives this is
   *  K-MCP's _route_operator_action dispatch table.
   *
   *  Returns once a terminal Family A span (`endTimeUnixNano` set, status
   *  not UNSET) has been observed for the dispatched directive — this
   *  blocks the controller's runOne until the cell is actually complete,
   *  preventing the "exec.end(false) before any span arrives" race that
   *  the live e2e test exposed. */
  public async executeCell(
    input: KernelExecuteRequest,
    sink: KernelEventSink
  ): Promise<void> {
    if (!this.readyPromise) {
      await this.start();
    } else {
      await this.readyPromise;
    }
    // Wrap the controller's sink so we can observe the terminal span and
    // resolve the pending promise. Forward every emission through.
    const terminalReached = new Promise<void>((resolve) => {
      this.activeRunSink = {
        emit: (payload) => {
          sink.emit(payload);
          // Identify terminal: a closed span has `endTimeUnixNano` non-null
          // (a string) AND `status.code !== STATUS_CODE_UNSET`.
          if (
            payload &&
            'endTimeUnixNano' in payload &&
            typeof (payload as { endTimeUnixNano?: unknown }).endTimeUnixNano ===
              'string' &&
            (payload as { status?: { code?: string } }).status?.code !==
              'STATUS_CODE_UNSET'
          ) {
            resolve();
          }
        }
      };
    });

    let envelope: RtsV2Envelope<unknown>;
    if (input.directive && input.directive.kind === 'spawn') {
      envelope = {
        type: 'operator.action',
        payload: {
          action_type: 'agent_spawn',
          parameters: {
            agent_id: input.directive.agent_id,
            task: input.directive.task,
            cell_id: input.cellUri
          },
          originating_cell_id: input.cellUri
        }
      };
    } else {
      // No directive recognized: ship the cell edit notification (logged
      // kernel-side per K-MCP). Resolve immediately — no span will arrive.
      envelope = {
        type: 'operator.action',
        payload: {
          action_type: 'cell_edit',
          parameters: { cell_id: input.cellUri, source: input.text },
          originating_cell_id: input.cellUri
        }
      };
      this.writeFrame(envelope);
      return;
    }
    this.writeFrame(envelope);

    // Cap the wait to avoid infinite hangs if the kernel never emits a
    // terminal. 60s aligns with the agent-spawn smoke timeout.
    const timeout = new Promise<void>((_resolve, reject) =>
      setTimeout(() => reject(new Error('agent_spawn timed out (60s) waiting for terminal span')), 60000)
    );
    await Promise.race([terminalReached, timeout]);
  }

  // --- internals -----------------------------------------------------------

  /** RFC-008 §2 — listen on the allocated address. Cleans up stale UDS files
   *  before binding. Sets mode `0600` after creation per §"Permissions and
   *  security". */
  private async listenSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Pre-emptively unlink stale UDS files (POSIX only; Windows pipes are
      // ephemeral).
      if (process.platform !== 'win32' && fs.existsSync(this.socketAddress)) {
        try {
          fs.unlinkSync(this.socketAddress);
        } catch (err) {
          this.logger.warn(
            `[pty-kernel] unlink stale socket failed: ${String(err)}`
          );
        }
      }

      const server = net.createServer((sock) => {
        if (this.socket) {
          // RFC-008 §"Failure modes" K10: reject second connections.
          this.logger.warn('[pty-kernel] K10 second client rejected');
          sock.end();
          return;
        }
        this.socket = sock;
        sock.setEncoding('utf8');
        sock.on('data', (buf: string | Buffer) => this.onSocketData(buf));
        sock.on('end', () => this.onSocketEnd());
        sock.on('error', (err) =>
          this.logger.error(`[pty-kernel] socket error: ${String(err)}`)
        );
        // Flush any frames buffered before the connection landed.
        for (const env of this.outboundBuffer) {
          this.writeFrameDirect(env);
        }
        this.outboundBuffer = [];
      });
      server.on('error', (err) => {
        // K1: bind failure.
        reject(new Error(`socket bind failed: ${String(err)}`));
      });
      server.listen(this.socketAddress, () => {
        // K1 hardening: tighten UDS permissions to 0600.
        if (process.platform !== 'win32') {
          try {
            fs.chmodSync(this.socketAddress, 0o600);
          } catch (err) {
            this.logger.warn(
              `[pty-kernel] chmod 0600 on UDS failed: ${String(err)}`
            );
          }
        }
        resolve();
      });
      this.server = server;
    });
  }

  /** RFC-008 §3 — spawn the kernel subprocess via node-pty. The kernel reads
   *  `LLMKERNEL_IPC_SOCKET` to find the data-plane address. */
  private spawnKernel(): void {
    const argv = this.config.argv ?? ['-m', 'llm_kernel', 'pty-mode'];
    const cwd =
      this.config.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LLMKERNEL_IPC_SOCKET: this.socketAddress,
      LLMKERNEL_PTY_MODE: '1'
    };
    let mod: PtyModuleLike;
    try {
      mod = getPtyModule();
    } catch (err) {
      // K2: spawn-side failure (binary not loadable).
      throw new Error(`node-pty load failed: ${String(err)}`);
    }
    let proc: IPtyLike;
    try {
      proc = mod.spawn(this.config.pythonPath, argv, {
        name: 'xterm-256color',
        cwd,
        env,
        cols: 120,
        rows: 30
      });
    } catch (err) {
      // K2: spawn failure (executable not found, bad argv).
      throw new Error(`pty.spawn failed: ${String(err)}`);
    }
    this.ptyProcess = proc;
    proc.onData((data) => this.dispatchPtyData(data));
    proc.onExit(({ exitCode }) => this.onPtyExit(exitCode));
  }

  /** RFC-008 §4 — 30s ready-handshake timeout. K3: if the kernel never
   *  connects, kill it and surface the error. */
  private armReadyTimeout(): void {
    this.readyTimer = setTimeout(() => {
      this.failReady(
        new Error(
          `kernel ready handshake timed out after ${this.readyTimeoutMs}ms`
        )
      );
      try {
        this.ptyProcess?.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }, this.readyTimeoutMs);
  }

  private cancelReadyTimeout(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
    }
  }

  private completeReady(): void {
    this.cancelReadyTimeout();
    if (this.readyResolve) {
      const r = this.readyResolve;
      this.readyResolve = undefined;
      this.readyReject = undefined;
      r();
    }
  }

  private failReady(err: Error): void {
    this.cancelReadyTimeout();
    if (this.readyReject) {
      const r = this.readyReject;
      this.readyResolve = undefined;
      this.readyReject = undefined;
      r(err);
    }
  }

  /** Buffer-and-frame the incoming bytes; dispatch each complete line per
   *  RFC-008 §6. */
  private onSocketData(buf: string | Buffer): void {
    const text = typeof buf === 'string' ? buf : buf.toString('utf8');
    this.incomingBuffer += text;
    let nl = this.incomingBuffer.indexOf('\n');
    while (nl >= 0) {
      const line = this.incomingBuffer.slice(0, nl);
      this.incomingBuffer = this.incomingBuffer.slice(nl + 1);
      const trimmed = line.replace(/\r$/, '');
      if (trimmed.length > 0) {
        this.dispatchLine(trimmed);
      }
      nl = this.incomingBuffer.indexOf('\n');
    }
  }

  /** RFC-008 §6 dispatch table. Order matters: span check first (most
   *  distinctive shape), then log record, then envelope. */
  public dispatchLine(line: string): FrameKind {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      // K8: malformed frame. Log and discard.
      this.logger.warn(
        `[pty-kernel] K8 malformed JSON on data plane: ${String(err)}`
      );
      return 'malformed';
    }
    if (typeof parsed !== 'object' || parsed === null) {
      this.logger.warn('[pty-kernel] K8 frame is not an object');
      return 'malformed';
    }
    const f = parsed as Record<string, unknown>;
    // OTel Span: traceId + spanId
    if (typeof f.traceId === 'string' && typeof f.spanId === 'string') {
      this.routeSpan(f as unknown as RunMimePayload);
      return 'span';
    }
    // OTel LogRecord: timeUnixNano + severityNumber
    if (typeof f.timeUnixNano === 'string' && typeof f.severityNumber === 'number') {
      this.routeLogRecord(f as unknown as OtlpLogRecord);
      return 'log_record';
    }
    // RFC-006 Comm envelope: type + payload
    if (typeof f.type === 'string' && f.payload !== undefined && f.payload !== null) {
      this.routeEnvelope(f as unknown as RtsV2Envelope<unknown>);
      return 'envelope';
    }
    this.logger.warn(
      `[pty-kernel] K8 frame had no recognized shape: keys=${Object.keys(f).join(',')}`
    );
    return 'malformed';
  }

  private routeSpan(span: RunMimePayload): void {
    // Cache the traceId so streaming run-events can find their cell.
    if (typeof (span as { traceId?: string }).traceId === 'string') {
      this.lastTraceId = (span as { traceId: string }).traceId;
    }
    if (this.activeRunSink) {
      try {
        this.activeRunSink.emit(span);
      } catch (err) {
        this.logger.error(`[pty-kernel] sink.emit threw: ${String(err)}`);
      }
    } else {
      // No active cell; route through the router so observers still see it.
      this.router.routeRunMime(span);
    }
  }

  /** Inspect the ready handshake; otherwise forward to the router. */
  private routeLogRecord(record: OtlpLogRecord): void {
    const eventName = readAttr(record.attributes, 'event.name');
    if (eventName === 'kernel.ready' && this.readyResolve) {
      this.handleReadyRecord(record);
    }
    this.router.routeLogRecord(record);
  }

  private routeEnvelope(env: RtsV2Envelope<unknown>): void {
    if (this.commSink) {
      this.commSink.emit(env);
    } else {
      // Fallback: feed the router directly.
      this.router.route(env);
    }
  }

  /** RFC-008 §4 / RFC-005 §"Resume-time RFC version check" — validate the
   *  ready record's `rfc_*_version` attributes. Mismatches produce drift
   *  events. */
  private handleReadyRecord(record: OtlpLogRecord): void {
    const observedSession = readAttr(record.attributes, 'llmnb.kernel.session_id');
    if (observedSession && observedSession !== this.config.sessionId) {
      this.logger.warn(
        `[pty-kernel] K4 ready session_id mismatch: observed="${observedSession}" expected="${this.config.sessionId}"`
      );
    }
    for (const [shortKey, expected] of Object.entries(EXTENSION_RFC_VERSIONS)) {
      const fullKey = `llmnb.kernel.${shortKey}`;
      const observed = readAttr(record.attributes, fullKey);
      if (typeof observed !== 'string' || observed.length === 0) {
        continue;
      }
      const drift = compareVersions(expected, observed);
      if (drift) {
        const ev: KernelDriftEvent = {
          attribute: fullKey,
          expected,
          observed,
          severity: drift
        };
        this.driftEvents.push(ev);
        try {
          this.emitter.fire(ev);
        } catch {
          /* ignore */
        }
        const rec = `[pty-kernel] drift on ${fullKey}: expected=${expected} observed=${observed} severity=${drift}`;
        if (drift === 'major_mismatch') {
          this.logger.error(rec);
        } else {
          this.logger.warn(rec);
        }
      }
    }
    this.completeReady();
  }

  /** Write one frame to the socket. Buffers if not connected yet. */
  private writeFrame(frame: object): void {
    if (!this.socket) {
      this.outboundBuffer.push(frame as RtsV2Envelope<unknown>);
      return;
    }
    this.writeFrameDirect(frame);
  }

  private writeFrameDirect(frame: object): void {
    if (!this.socket) {
      return;
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(frame);
    } catch (err) {
      this.logger.error(`[pty-kernel] outbound JSON.stringify failed: ${String(err)}`);
      return;
    }
    this.socket.write(`${serialized}\n`);
  }

  private dispatchPtyData(chunk: string): void {
    for (const l of this.ptyDataListeners) {
      try {
        l(chunk);
      } catch (err) {
        this.logger.error(`[pty-kernel] pty-data listener threw: ${String(err)}`);
      }
    }
  }

  private onPtyExit(exitCode: number): void {
    this.logger.info(`[pty-kernel] PTY EOF; exitCode=${exitCode}`);
    if (this.readyReject) {
      // K7: PTY EOF before ready handshake.
      this.failReady(
        new Error(`kernel exited before ready handshake (code=${exitCode})`)
      );
    }
    this.dispose();
  }

  private onSocketEnd(): void {
    // K6: data-plane EOF mid-session.
    this.logger.warn('[pty-kernel] K6 data-plane socket EOF');
    if (this.readyReject) {
      this.failReady(new Error('data-plane socket closed before ready handshake'));
    }
  }
}

// --- helpers ---------------------------------------------------------------

interface OtlpAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string; [k: string]: unknown };
}

/** Read a string-typed OTLP attribute from a LogRecord (best effort). */
function readAttr(
  attrs: OtlpLogRecord['attributes'] | undefined,
  key: string
): string | undefined {
  if (!attrs) {
    return undefined;
  }
  for (const a of attrs) {
    if (a && typeof a === 'object' && (a as OtlpAttribute).key === key) {
      const v = (a as OtlpAttribute).value;
      if (v && typeof v.stringValue === 'string') {
        return v.stringValue;
      }
      if (v && typeof v.intValue === 'string') {
        return v.intValue;
      }
    }
  }
  return undefined;
}

/** Compare semver-like x.y.z strings; returns the drift severity, or
 *  undefined if equal. Major mismatch is blocking per RFC-008 §"Failure
 *  modes" K5. */
function compareVersions(
  expected: string,
  observed: string
): KernelDriftEvent['severity'] | undefined {
  if (expected === observed) {
    return undefined;
  }
  const [eMaj, eMin] = expected.split('.');
  const [oMaj, oMin] = observed.split('.');
  if (!eMaj || !oMaj) {
    return 'unknown';
  }
  if (eMaj !== oMaj) {
    return 'major_mismatch';
  }
  if (eMin !== oMin) {
    return 'minor_mismatch';
  }
  return 'unknown';
}

/** Re-export the encodeAttrs helper at this module so test fixtures can
 *  build LogRecord attributes without reaching across packages. */
export { encodeAttrs };
