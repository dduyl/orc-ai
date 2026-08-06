import * as net from "node:net";
import * as crypto from "node:crypto";
import type { Server, Socket } from "node:net";
import { createMessageConnection, type MessageConnection } from "vscode-jsonrpc/node";
import type { AdapterDef } from "../../agents/adapter.js";
import { getAdapter, BUILTIN_ADAPTERS } from "../../agents/adapter.js";
import { RunHost } from "../run-host.js";
import { startRun, reconcileStaleRuns, type StartRunResult } from "../start-run.js";
import { WorkflowRegistry } from "../../planner/registry.js";
import type { Tracker, RunRecord } from "../persistence/Tracker.js";
import { TerminalStore, type PtyLike } from "./terminal-store.js";
import { controlPipePath, terminalPipePath, mainPipePath } from "./pipe-name.js";
import { MAIN_STEP_ID } from "./frame-transport.js";
import type { ProgressEvent, RunReport } from "../orchestrator/index.js";
import { McpServer } from "../../../adapters/mcp/server.js";
import { setupInfrastructure } from "../persistence/bootstrap.js";
import { registerPtyWriter } from "../signalling/pty-notifier.js";
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
 * The daemon is a RunHost + pipes + (optionally) MCP. By default it hosts no
 * MCP (pipes-only, `--no-mcp`); with `mcp: { port }` it runs the same
 * `McpServer` the GUI used to embed, so the coding agent reaches the run host
 * over `:3100` while the GUI is a pure viewer. It outlives its clients: a
 * crashed GUI leaves in-flight runs running and terminal pipes reachable. When
 * no control client is connected AND no run is active AND (when hosting MCP) no
 * coding agent session is open, it auto-exits after `idleMs` (default ~10 min).
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
  attachMain: "attachMain",
  input: "input",
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

/** Result of the `attachMain` request: the daemon-owned main terminal pipe. */
export interface AttachMainResult {
  terminalPipe: string;
}

/** Payload for the `input` RPC: write `data` to a PTY by step id. */
export interface InputParams {
  /** Omit for the main terminal (`stepId` must be `__main__`). */
  runId?: string;
  /** `__main__` → main PTY; otherwise a step id within `runId`. */
  stepId: string;
  data: string;
}

export interface InputResult {
  ok: true;
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
  /**
   * Host MCP HTTP on the given port (default: no MCP — pipes-only).
   * `McpServer` is a pure HTTP transport; `setupInfrastructure` +
   * `reconcileStaleRuns` run exactly once inside `start()` regardless of MCP
   * mode. `false` is the default; `orc daemon start` passes `{ port }` unless
   * `--no-mcp`.
   */
  mcp?: { port: number } | false;
  adapter?: AdapterDef;
  registry?: WorkflowRegistry;
  tracker?: Tracker;
  terminalStore?: TerminalStore;
  idleMs?: number;
  /**
   * Spawn the daemon-owned main interactive PTY (Phase D D-3). Called once inside
   * `start()`; the returned `PtyLike` is tagged `__main__` and served on the
   * dedicated main terminal pipe. The CLI supplies a node-pty-backed factory
   * (with MCP env pointing at `:3100`); tests inject a fake. When omitted the
   * daemon runs without a main terminal.
   */
  spawnMain?: () => PtyLike;
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
  private readonly mcp?: { port: number } | false;
  private readonly idleMs: number;
  private readonly spawnMain?: () => PtyLike;
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
  /** Present once `start()` hosts MCP (pure transport; setup runs once above). */
  private mcpServer: McpServer | null = null;
  /** The daemon-owned main PTY (tagged `__main__`), if `spawnMain` was provided. */
  private mainPty: PtyLike | null = null;
  private mainTerminalServer: Server | null = null;
  /** runId → (stepId → pty) for `input` routing (populated by feedPty). */
  private stepPtys = new Map<string, Map<string, PtyLike>>();

  constructor(opts: DaemonServerOptions = {}) {
    this.projectDir = opts.projectDir ?? process.cwd();
    this.pipeOverride = opts.pipeOverride;
    this.mcp = opts.mcp ?? false;
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.spawnMain = opts.spawnMain;
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
    // The daemon is the single owner of infrastructure setup + stale-run
    // reconciliation, run exactly once regardless of MCP mode (`--no-mcp`
    // still needs ~/.orc/workflows and orphan cleanup). `McpServer` is a pure
    // transport and must not re-run these.
    setupInfrastructure();
    reconcileStaleRuns(this.host);
    if (this.mcp) {
      this.mcpServer = new McpServer(this.host, () => this.touch());
      await this.mcpServer.startHttp(this.mcp.port);
    }
    this.startMain();
    this.touch();
    return this.controlPipe;
  }

  /**
   * Spawn and wire the daemon-owned main interactive PTY (`spawnMain`), tagged
   * `__main__`. Its bytes feed a shared terminal in the store so `attachMain`
   * clients get replay + live frames. The main PTY is the user's interactive
   * coding-agent shell; the run host reaches agents via MCP on :3100.
   */
  private startMain(): void {
    if (!this.spawnMain) return;
    try {
      this.mainPty = this.spawnMain();
      this.feedStepPty(MAIN_STEP_ID, MAIN_STEP_ID, this.mainPty);
      // Phase D D-4: the daemon now owns the main PTY, so it — not the GUI —
      // becomes the sink for `[ORC]` completion prompts pushed into opencode's
      // input on workflow completion (start-run → notifyMainPty).
      registerPtyWriter((text: string) => {
        const pty = this.mainPty;
        if (!pty?.write) return;
        try { pty.write(text); } catch { /* pty may be dead */ }
      });
      log.info("[daemon] main terminal on");
    } catch (err: any) {
      log.warn(`[daemon] main PTY spawn failed: ${err?.message ?? err}`);
      this.mainPty = null;
    }
  }

  /**
   * Wire a step's PTY into the terminal store AND register it for `input`
   * routing. A redo/repair loop re-dispatches the same step id with a fresh
   * pty, so the map entry is replaced (test seam: tests seed runs this way).
   */
  feedStepPty(runId: string, stepId: string, pty: PtyLike): void {
    this.terminalStore.feedPty(runId, stepId, pty);
    this.stepPtysFor(runId).set(stepId, pty);
  }

  private stepPtysFor(runId: string): Map<string, PtyLike> {
    let m = this.stepPtys.get(runId);
    if (!m) {
      m = new Map<string, PtyLike>();
      this.stepPtys.set(runId, m);
    }
    return m;
  }

  /** True while the control pipe is bound and the daemon has not stopped. */
  get isRunning(): boolean {
    return this.controlServer !== null && !this.stopping;
  }

  /** The hosted MCP server, if `start()` enabled MCP (tests / introspection). */
  getMcpServer(): McpServer | null {
    return this.mcpServer;
  }

  /** Clean shutdown: abort runs, close pipes, dispose terminals. */
  async stop(requesterSocket?: Socket): Promise<void> {
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
    //
    // Exception: when a stop RPC arrived over `requesterSocket`, that client is
    // still waiting for its reply. end() (instead of destroy()) flushes the
    // queued reply bytes and half-closes with FIN so the response makes it
    // through; every other socket is hard-destroyed.
    const sockets = [...this.controlSockets];
    for (const sock of sockets) {
      if (sock === requesterSocket) {
        try { sock.end(); } catch { /* ignore */ }
      } else {
        sock.destroy();
      }
    }
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

    // Kill the daemon-owned main PTY (if any). `feedPty` holds an onData
    // reference into the store; disposing the store then killing the pty is the
    // right order so no callback fires into a disposed terminal.
    const main = this.mainPty;
    this.mainPty = null;
    try { main?.kill?.(); } catch { /* ignore */ }
    this.stepPtys.clear();
    if (this.mainTerminalServer) {
      try { this.mainTerminalServer.close(); } catch { /* ignore */ }
      this.mainTerminalServer = null;
    }

    if (this.mcpServer) {
      const httpServer = this.mcpServer.getHttpServer();
      if (httpServer) {
        // MCP sessions hold long-lived SSE streams; force-close them or
        // server.close() hangs forever waiting on open connections.
        try { httpServer.closeAllConnections?.(); } catch { /* ignore */ }
        try { await new Promise<void>((r) => httpServer.close(() => r())); } catch { /* ignore */ }
      }
      this.mcpServer = null;
    }

    await new Promise<void>((resolve) => {
      const server = this.controlServer;
      this.controlServer = null;
      if (!server) {
        resolve();
        this.fireShutdown();
        return;
      }
      // The requester was end()ed (not destroyed) so its reply flushes first,
      // but server.close() waits for every connection to fully close. If the
      // client lingers without closing its side, force-destroy the socket after
      // a short grace period (unref'd so it never keeps the process alive).
      const grace = setTimeout(() => {
        if (requesterSocket && !requesterSocket.destroyed) requesterSocket.destroy();
      }, 1000);
      grace.unref();
      requesterSocket?.once("close", () => clearTimeout(grace));
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
    conn.onRequest(RpcMethod.attachMain, () => this.handleAttachMain());
    conn.onRequest(RpcMethod.input, (params: InputParams) => this.handleInput(params));
    conn.onRequest(RpcMethod.stop, () => this.handleStop(sock));

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
    try {
      const result = await startRun(this.host, task, workflowId, params?.resume === true, {
        signal: controller.signal,
        runId,
        onEvent: (event) => this.onRunEvent(event),
      });
      this.touch();
      return result;
    } catch (err) {
      // startRun threw before a workflow_complete fan-out could clean up (e.g.
      // an unknown workflowId fails before any background job starts). Without
      // this, the pre-registered marker leaks forever: idle auto-exit never
      // arms (activeRunIds is non-empty) and a later cancel would lie
      // {cancelled:true} about a run that never started.
      this.controllers.delete(runId);
      this.activeRunIds.delete(runId);
      this.touch();
      throw err;
    }
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

  private async handleAttachMain(): Promise<AttachMainResult> {
    if (!this.spawnMain) throw new Error("daemon has no main terminal");
    await this.ensureMainTerminalServer();
    return { terminalPipe: mainPipePath(this.projectDir, this.pipeOverride) };
  }

  /**
   * Route an `input` write to the matching PTY. `stepId === __main__` → the
   * daemon-owned main PTY; otherwise a step PTY within `runId` (registered by
   * `feedPty` on each `step_pty` event). Unknown targets reject — a client can
   * never silently write into thin air.
   */
  private handleInput(params: InputParams): InputResult {
    const stepId = params?.stepId;
    if (!stepId) throw new Error("Missing stepId");
    if (typeof params?.data !== "string") throw new Error("Missing data");
    if (stepId === MAIN_STEP_ID) {
      if (!this.mainPty?.write) throw new Error("Main terminal unavailable");
      this.mainPty.write(params.data);
      return { ok: true };
    }
    if (!params.runId) throw new Error("Missing runId for step input");
    const pty = this.stepPtys.get(params.runId)?.get(stepId);
    if (!pty?.write) throw new Error(`Unknown step: ${params.runId}/${stepId}`);
    pty.write(params.data);
    return { ok: true };
  }

  private handleStop(requesterSocket?: Socket): StopResult {
    // Reply before tearing down, or the client never receives the response.
    // Nested setImmediate: vscode-jsonrpc flushes the reply itself on a single
    // deferred setImmediate (via its write semaphore), so we must run the
    // teardown strictly AFTER that — one extra macrotask guarantees the reply
    // bytes are written to the socket before it is closed.
    setImmediate(() => { setImmediate(() => { void this.stop(requesterSocket); }); });
    return { ok: true };
  }

  // --- run event fan-out ---------------------------------------------------

  private onRunEvent(event: ProgressEvent): void {
    if (event.type === "step_pty") {
      if (event.runId && event.stepId && event.pty) {
        this.feedStepPty(event.runId, event.stepId, event.pty);
      }
      return;
    }
    if (event.type === "workflow_complete") {
      if (event.runId) {
        this.terminalStore.complete(event.runId);
        // Evict the run's terminal and close its pipe server. Leaving them in
        // place would grow memory/handles without bound on a long-lived daemon.
        this.evictTerminal(event.runId);
        this.stepPtys.delete(event.runId);
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

  /** Bind the dedicated main-terminal pipe lazily on first `attachMain`. */
  private async ensureMainTerminalServer(): Promise<void> {
    if (this.mainTerminalServer) return;
    const path = mainPipePath(this.projectDir, this.pipeOverride);
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((sock) => this.onTerminalConnection(MAIN_STEP_ID, sock));
      server.once("error", reject);
      server.listen(path, () => {
        server.removeListener("error", reject);
        server.on("error", (err) => log.warn(`[daemon] main terminal pipe error: ${err.message}`));
        this.mainTerminalServer = server;
        log.debug(`[daemon] main terminal pipe on ${path}`);
        resolve();
      });
    });
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
   * client is connected AND no run is active AND (when hosting MCP) no coding
   * agent holds a session on :3100; any such activity, or an explicit stop,
   * clears it. `unref()` keeps the timer from holding the process open in CLI
   * mode, but the bound control pipe keeps it alive until the daemon decides
   * to stop.
   *
   * MCP sessions are checked so a *standalone* `orc mcp` (a coding agent
   * attached over HTTP) is not mistaken for idle and killed after the grace
   * period — idle-exit only fires when genuinely abandoned.
   */
  private touch(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.stopping) return;
    if (this.controlConnections.size > 0 || this.activeRunIds.size > 0) return;
    if (this.mcpServer && this.mcpServer.getActiveSessionCount() > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      log.info("[daemon] idle — shutting down");
      void this.stop();
    }, this.idleMs);
    this.idleTimer.unref?.();
  }
}
