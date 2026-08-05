import * as net from "node:net";
import * as crypto from "node:crypto";
import type { Server, Socket } from "node:net";
import { createMessageConnection, type MessageConnection } from "vscode-jsonrpc/node";
import type { AdapterDef } from "../../agents/adapter.js";
import { getAdapter, BUILTIN_ADAPTERS } from "../../agents/adapter.js";
import { RunHost } from "../run-host.js";
import { startRun, type StartRunResult } from "../start-run.js";
import { WorkflowRegistry } from "../../planner/registry.js";
import type { Tracker, RunRecord } from "../persistence/Tracker.js";
import { TerminalStore } from "./terminal-store.js";
import { controlPipePath, terminalPipePath } from "./pipe-name.js";
import type { ProgressEvent, RunReport } from "../orchestrator/index.js";
import { log } from "../../../core/log.js";

/**
 * Headless run daemon over named pipes (ADR-025 Phase C step 3).
 *
 * Binds ONE control pipe derived deterministically from `projectDir`
 * (`\\.\pipe\orc-agent-<hash>` on win32, an AF_UNIX `.sock` on POSIX). At most
 * one daemon may bind a name — a second bind fails with EADDRINUSE, so two
 * processes sharing a project always find the same daemon.
 *
 * The control channel carries JSON-RPC (`vscode-jsonrpc`) requests
 * `start|list|status|cancel|attach|stop` and notifications `progress` /
 * `workflowComplete` fanned out to every control client. Terminal bytes flow
 * on separate per-run raw length-prefixed pipes (see TerminalStore + frame
 * transport), created lazily on the first `attach`.
 *
 * The daemon is a RunHost + pipes ONLY — it never binds the MCP HTTP port
 * (the GUI keeps its embedded MCP server). It outlives its clients: a crashed
 * GUI leaves in-flight runs running and terminal pipes reachable. When no
 * control client is connected AND no run is active it auto-exits after
 * `idleMs` (default ~10 min).
 */

export const DEFAULT_IDLE_MS = 10 * 60 * 1000;

/** Control-plane JSON-RPC request method names. */
export const RpcMethod = {
  start: "start",
  list: "list",
  status: "status",
  cancel: "cancel",
  attach: "attach",
  stop: "stop",
} as const;

/** Control-plane JSON-RPC notifications (server → client). */
export const RpcNotification = {
  progress: "progress",
  workflowComplete: "workflowComplete",
} as const;

export interface StartParams {
  task: string;
  workflowId: string;
  resume?: boolean;
}

/** Result of the `start` request. */
export type StartResult = StartRunResult;

export interface AttachParams {
  runId: string;
}

export interface AttachResult {
  runId: string;
  /** Path of the run's terminal pipe; connect + read length-prefixed frames. */
  terminalPipe: string;
}

export interface CancelParams {
  runId: string;
}

export interface CancelResult {
  cancelled: boolean;
  reason?: string;
}

export interface StopResult {
  ok: true;
}

export interface WorkflowCompleteInfo {
  runId?: string;
  status?: string;
  report?: RunReport;
}

export interface DaemonServerOptions {
  projectDir?: string;
  /** Overrides the derived control/terminal pipe base (--pipe / ORC_PIPE). */
  pipeOverride?: string;
  adapter?: AdapterDef;
  registry?: WorkflowRegistry;
  tracker?: Tracker;
  terminalStore?: TerminalStore;
  idleMs?: number;
  /** Invoked once after the daemon has fully shut down (tests / CLI exit). */
  onShutdown?: () => void;
}

export class DaemonServer {
  readonly host: RunHost;
  readonly terminalStore: TerminalStore;
  /** The control pipe path this daemon binds (derived or overridden). */
  readonly controlPipe: string;

  private readonly projectDir: string;
  private readonly pipeOverride?: string;
  private readonly idleMs: number;
  private readonly onShutdown?: () => void;
  /** True when the daemon (not a caller) created the Tracker, so it closes it. */
  private readonly ownsTracker: boolean;

  private controlServer: Server | null = null;
  private controlConnections = new Set<MessageConnection>();
  private controlSockets = new Set<Socket>();
  private terminalServers = new Map<string, Server>();
  private terminalSockets = new Set<Socket>();
  private controllers = new Map<string, AbortController>();
  private activeRunIds = new Set<string>();
  private idleTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private shutdownFired = false;

  constructor(opts: DaemonServerOptions = {}) {
    this.projectDir = opts.projectDir ?? process.cwd();
    this.pipeOverride = opts.pipeOverride;
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.onShutdown = opts.onShutdown;
    this.ownsTracker = !opts.tracker;
    this.controlPipe = controlPipePath(this.projectDir, opts.pipeOverride);
    this.terminalStore = opts.terminalStore ?? new TerminalStore();

    const adapter = opts.adapter ?? getAdapter("opencode") ?? BUILTIN_ADAPTERS[0];
    this.host = new RunHost(adapter, {
      projectDir: this.projectDir,
      tracker: opts.tracker,
      registry: opts.registry,
    });
  }

  /** Bind the control pipe. Rejects if another daemon already owns it. */
  async start(): Promise<string> {
    if (this.controlServer) return this.controlPipe;
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((sock) => this.onControlConnection(sock));
      server.once("error", (err) => {
        this.controlServer = null;
        reject(err);
      });
      server.listen(this.controlPipe, () => {
        server.removeListener("error", reject);
        server.on("error", (err) => log.warn(`[daemon] control pipe error: ${err.message}`));
        this.controlServer = server;
        log.info(`[daemon] control pipe on ${this.controlPipe}`);
        resolve();
      });
    });
    this.touch();
    return this.controlPipe;
  }

  /** True while the control pipe is bound and the daemon has not stopped. */
  get isRunning(): boolean {
    return this.controlServer !== null && !this.stopping;
  }

  /** Clean shutdown: abort runs, close pipes, dispose terminals. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.activeRunIds.clear();

    // Await in-flight runs BEFORE closing an owned tracker: the abort path's
    // updateRunStatus("cancelled") write must land on a live DB, not throw into
    // a closed one (where it would also swallow the completion notification).
    const bg = [...this.host.bgRuns.values()];

    // Force-close the control pipe. Destroy sockets FIRST: the per-connection
    // onDispose cleanup deletes the socket from controlSockets, so disposing
    // connections first leaves an empty set to iterate and server.close() hangs
    // waiting on a live socket.
    const sockets = [...this.controlSockets];
    for (const sock of sockets) sock.destroy();
    this.controlSockets.clear();
    for (const conn of [...this.controlConnections]) {
      try { conn.dispose(); } catch { /* ignore */ }
    }
    this.controlConnections.clear();

    for (const server of this.terminalServers.values()) {
      try { server.close(); } catch { /* ignore */ }
    }
    this.terminalServers.clear();
    for (const sock of [...this.terminalSockets]) sock.destroy();
    this.terminalSockets.clear();
    this.terminalStore.disposeAll();

    await new Promise<void>((resolve) => {
      const server = this.controlServer;
      this.controlServer = null;
      if (!server) {
        resolve();
        this.fireShutdown();
        return;
      }
      server.close(() => {
        this.fireShutdown();
        resolve();
      });
    });

    if (bg.length > 0) await Promise.allSettled(bg);

    if (this.ownsTracker) {
      try { this.host.tracker.close(); } catch { /* ignore */ }
    }
  }

  /** Whether shutdown has fully completed (for tests that await stop()). */
  get isStopped(): boolean {
    return this.stopping && this.controlServer === null;
  }

  private fireShutdown(): void {
    if (this.shutdownFired) return;
    this.shutdownFired = true;
    this.onShutdown?.();
  }

  // --- control plane -------------------------------------------------------

  private onControlConnection(sock: Socket): void {
    // A socket accepted after stop() captured its peers must never survive
    // into server.close(): it would keep the close callback (and thus
    // onShutdown) from ever firing, hanging stop() forever.
    if (this.stopping) {
      sock.destroy();
      return;
    }
    // A half-open control client must never crash the daemon.
    sock.on("error", () => {});
    this.controlSockets.add(sock);

    const conn = createMessageConnection(sock, sock);
    this.controlConnections.add(conn);
    conn.onRequest(RpcMethod.start, (params: StartParams) => this.handleStart(params));
    conn.onRequest(RpcMethod.list, () => this.handleList());
    conn.onRequest(RpcMethod.status, (params: { runId: string }) => this.handleStatus(params));
    conn.onRequest(RpcMethod.cancel, (params: CancelParams) => this.handleCancel(params));
    conn.onRequest(RpcMethod.attach, (params: AttachParams) => this.handleAttach(params));
    conn.onRequest(RpcMethod.stop, () => this.handleStop());

    const cleanup = (): void => {
      this.controlConnections.delete(conn);
      this.controlSockets.delete(sock);
      this.touch();
    };
    conn.onDispose(cleanup);
    sock.on("close", cleanup);

    conn.listen();
    this.touch();
  }

  private async handleStart(params: StartParams): Promise<StartRunResult> {
    const task = params?.task;
    const workflowId = params?.workflowId;
    if (!task || !workflowId) throw new Error("Missing task or workflowId");
    const controller = new AbortController();
    const runId = crypto.randomUUID();
    // Register the run's controller + active marker BEFORE the run can
    // complete. If the workflow finishes before startRun's await resolves, the
    // workflow_complete fan-out removes the registration — re-registering after
    // the await (as a naive post-await add would) would resurrect it as a
    // permanently-active run: idle auto-exit then never fires, and a later
    // cancel would lie {cancelled:true} about an already-finished run.
    this.controllers.set(runId, controller);
    this.activeRunIds.add(runId);
    const result = await startRun(this.host, task, workflowId, params?.resume === true, {
      signal: controller.signal,
      runId,
      onEvent: (event) => this.onRunEvent(event),
    });
    this.touch();
    return result;
  }

  private handleList(): RunRecord[] {
    return this.host.tracker.listRuns();
  }

  private handleStatus(params: { runId: string }): RunRecord {
    const runId = params?.runId;
    const run = this.host.tracker.getRun(runId);
    if (!run) throw new Error(`Unknown runId: ${runId}`);
    return run;
  }

  private handleCancel(params: CancelParams): CancelResult {
    const controller = this.controllers.get(params?.runId);
    if (!controller) {
      return { cancelled: false, reason: `no active run: ${params?.runId}` };
    }
    controller.abort();
    return { cancelled: true };
  }

  private async handleAttach(params: AttachParams): Promise<AttachResult> {
    const runId = params?.runId;
    if (!runId) throw new Error("Missing runId");
    const run = this.host.tracker.getRun(runId);
    if (!run) throw new Error(`Unknown runId: ${runId}`);
    await this.ensureTerminalServer(runId);
    return { runId, terminalPipe: terminalPipePath(this.projectDir, runId, this.pipeOverride) };
  }

  private handleStop(): StopResult {
    // Reply before tearing down, or the client never receives the response.
    setImmediate(() => { void this.stop(); });
    return { ok: true };
  }

  // --- run event fan-out ---------------------------------------------------

  private onRunEvent(event: ProgressEvent): void {
    if (event.type === "step_pty") {
      if (event.runId && event.stepId && event.pty) {
        this.terminalStore.feedPty(event.runId, event.stepId, event.pty);
      }
      return;
    }
    if (event.type === "workflow_complete") {
      if (event.runId) {
        this.terminalStore.complete(event.runId);
        // Evict the run's terminal and close its pipe server. Leaving them in
        // place would grow memory/handles without bound on a long-lived daemon.
        this.evictTerminal(event.runId);
        this.activeRunIds.delete(event.runId);
        this.controllers.delete(event.runId);
      }
      this.broadcast(RpcNotification.workflowComplete, {
        runId: event.runId,
        status: event.status,
        report: event.report,
      } satisfies WorkflowCompleteInfo);
      this.touch();
      return;
    }
    this.broadcast(RpcNotification.progress, event);
  }

  private broadcast(method: string, params: unknown): void {
    for (const conn of this.controlConnections) {
      try { conn.sendNotification(method, params); } catch { /* ignore */ }
    }
  }

  // --- terminal pipes ------------------------------------------------------

  /** Bind the per-run terminal pipe lazily on first attach. */
  private async ensureTerminalServer(runId: string): Promise<void> {
    if (this.terminalServers.has(runId)) return;
    const path = terminalPipePath(this.projectDir, runId, this.pipeOverride);
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((sock) => this.onTerminalConnection(runId, sock));
      server.once("error", reject);
      server.listen(path, () => {
        server.removeListener("error", reject);
        server.on("error", (err) => log.warn(`[daemon] terminal pipe (${runId}) error: ${err.message}`));
        this.terminalServers.set(runId, server);
        log.debug(`[daemon] terminal pipe ${runId} on ${path}`);
        resolve();
      });
    });
  }

  private onTerminalConnection(runId: string, sock: Socket): void {
    sock.on("error", () => {});
    this.terminalSockets.add(sock);
    sock.on("close", () => this.terminalSockets.delete(sock));
    this.terminalStore.attach(runId, sock);
  }

  /**
   * Release a run's terminal resources once it completes: close its pipe
   * server (freeing the bound name/handle) and evict the terminal from the
   * store (disposing the headless screen and any live client links). Keeps a
   * long-lived daemon from accumulating finished runs' terminals.
   */
  private evictTerminal(runId: string): void {
    const server = this.terminalServers.get(runId);
    if (server) {
      try { server.close(); } catch { /* ignore */ }
      this.terminalServers.delete(runId);
    }
    this.terminalStore.delete(runId);
  }

  // --- idle exit -----------------------------------------------------------

  /**
   * (Re)arm the idle auto-exit. A timer is only scheduled when no control
   * client is connected AND no run is active; any client, in-flight run, or
   * explicit stop clears it. `unref()` keeps the timer from holding the
   * process open in CLI mode, but the bound control pipe keeps it alive until
   * the daemon decides to stop.
   */
  private touch(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.stopping) return;
    if (this.controlConnections.size > 0 || this.activeRunIds.size > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      log.info("[daemon] idle — shutting down");
      void this.stop();
    }, this.idleMs);
    this.idleTimer.unref?.();
  }
}
