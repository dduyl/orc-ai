import * as net from "node:net";
import type { Socket } from "node:net";
import { createMessageConnection, type MessageConnection } from "vscode-jsonrpc/node";
import { controlPipePath, terminalPipePath, mainPipePath } from "./pipe-name.js";
import { FrameReader } from "./frame-transport.js";
import {
  RpcMethod,
  RpcNotification,
  type AnswerPermissionParams,
  type AnswerPermissionResult,
  type AttachParams,
  type AttachResult,
  type AttachMainResult,
  type CancelMainResult,
  type CancelParams,
  type CancelResult,
  type InputParams,
  type InputResult,
  type PromptMention,
  type PromptParams,
  type PromptResult,
  type SetConfigOptionParams,
  type SetConfigOptionResult,
  type StartParams,
  type StartResult,
  type StopResult,
  type WorkflowCompleteInfo,
} from "./rpc-protocol.js";
import type { RunRecord } from "../persistence/Tracker.js";
import type { ProgressEvent, RunReport } from "../orchestrator/index.js";
import type { PermissionRequest } from "../../agents/acp/permission.js";
import type { PermissionAnswerKind } from "../../agents/acp/types.js";

/**
 * Client for the daemon's control pipe (ADR-025 Phase C step 3).
 *
 * Connects to `controlPipePath(projectDir, override)`, wraps it in a
 * `vscode-jsonrpc` MessageConnection, and exposes typed request helpers plus a
 * terminal-pipe frame reader. Method names and payload types come from
 * `rpc-protocol.js` so both sides always agree on the wire protocol.
 */

export interface PipeClientOptions {
  projectDir?: string;
  pipeOverride?: string;
  /** Receives every `progress` notification broadcast by the daemon. */
  onProgress?: (event: ProgressEvent) => void;
  /** Receives the `workflowComplete` notification. */
  onWorkflowComplete?: (info: WorkflowCompleteInfo) => void;
  /** Receives the ACP main session's `permissionRequested` notifications. */
  onPermissionRequested?: (request: PermissionRequest) => void;
}

export interface TerminalStream {
  socket: Socket;
  close: () => void;
}

export class PipeClient {
  readonly controlPipe: string;
  private readonly projectDir: string;
  private readonly pipeOverride?: string;
  private conn: MessageConnection;
  private sockets = new Set<Socket>();
  private disposed = false;

  private constructor(conn: MessageConnection, opts: PipeClientOptions) {
    this.conn = conn;
    this.projectDir = opts.projectDir ?? process.cwd();
    this.pipeOverride = opts.pipeOverride;
    this.controlPipe = controlPipePath(this.projectDir, opts.pipeOverride);
  }

  /** Connect to the control pipe of the daemon owning `projectDir`. */
  static async connect(opts: PipeClientOptions = {}): Promise<PipeClient> {
    const controlPipe = controlPipePath(opts.projectDir, opts.pipeOverride);
    const sock = net.connect(controlPipe);
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", () => resolve());
      sock.once("error", (err) => {
        sock.destroy();
        reject(err);
      });
    });
    const conn = createMessageConnection(sock, sock);
    const client = new PipeClient(conn, opts);
    // Track the control socket so dispose() actually closes it: conn.dispose()
    // stops the JSON-RPC reader/writer but leaves the socket open, which would
    // leave the daemon's server.close() waiting on a half-open connection.
    client.sockets.add(sock);
    if (opts.onProgress) {
      conn.onNotification(RpcNotification.progress, (e: ProgressEvent) => opts.onProgress?.(e));
    }
    if (opts.onWorkflowComplete) {
      conn.onNotification(RpcNotification.workflowComplete, (e: WorkflowCompleteInfo) => opts.onWorkflowComplete?.(e));
    }
    if (opts.onPermissionRequested) {
      conn.onNotification(RpcNotification.permissionRequested, (e: PermissionRequest) =>
        opts.onPermissionRequested?.(e),
      );
    }
    conn.listen();
    sock.on("close", () => client.dispose());
    return client;
  }

  async start(params: StartParams): Promise<StartResult> {
    return this.conn.sendRequest(RpcMethod.start, params) as Promise<StartResult>;
  }

  async list(): Promise<RunRecord[]> {
    return this.conn.sendRequest(RpcMethod.list) as Promise<RunRecord[]>;
  }

  async status(runId: string): Promise<RunRecord> {
    return this.conn.sendRequest(RpcMethod.status, { runId }) as Promise<RunRecord>;
  }

  async cancel(runId: string): Promise<CancelResult> {
    return this.conn.sendRequest(RpcMethod.cancel, { runId } satisfies CancelParams) as Promise<CancelResult>;
  }

  /** Ask the daemon to ensure the run's terminal pipe exists; returns its path. */
  async attach(runId: string): Promise<AttachResult> {
    return this.conn.sendRequest(RpcMethod.attach, { runId } satisfies AttachParams) as Promise<AttachResult>;
  }

  async stop(): Promise<StopResult> {
    return this.conn.sendRequest(RpcMethod.stop) as Promise<StopResult>;
  }

  /** Ask the daemon to bind the main-terminal pipe; returns its path. */
  async attachMain(): Promise<AttachMainResult> {
    return this.conn.sendRequest(RpcMethod.attachMain) as Promise<AttachMainResult>;
  }

  /** Route keyboard input to a PTY: `__main__` or a step within a run. */
  async writeInput(params: InputParams): Promise<InputResult> {
    return this.conn.sendRequest(RpcMethod.input, params satisfies InputParams) as Promise<InputResult>;
  }

  /** Queue a user prompt turn on the ACP main session. */
  async prompt(text: string, mentions?: PromptMention[]): Promise<PromptResult> {
    const params: PromptParams = mentions?.length ? { text, mentions } : { text };
    return this.conn.sendRequest(RpcMethod.prompt, params) as Promise<PromptResult>;
  }

  /** Cancel the ACP main session's in-flight turn. */
  async cancelMain(): Promise<CancelMainResult> {
    return this.conn.sendRequest(RpcMethod.cancelMain) as Promise<CancelMainResult>;
  }

  /** Answer the ACP main session's permission request that carries `requestId`. */
  async answerPermission(requestId: string, kind: PermissionAnswerKind): Promise<AnswerPermissionResult> {
    return this.conn.sendRequest(
      RpcMethod.answerPermission,
      { requestId, kind } satisfies AnswerPermissionParams,
    ) as Promise<AnswerPermissionResult>;
  }

  /** Set an ACP main session config option (e.g. the model). */
  async setConfigOption(configId: string, value: string): Promise<SetConfigOptionResult> {
    return this.conn.sendRequest(
      RpcMethod.setConfigOption,
      { configId, value } satisfies SetConfigOptionParams,
    ) as Promise<SetConfigOptionResult>;
  }

  /**
   * Open the daemon-owned main-terminal pipe and stream frames (replay + live
   * + EOF), mirroring `attachTerminal`. Use `attachMain()` first to lazily bind
   * the pipe.
   */
  attachMainStream(
    onFrame: (stepId: string, payload: Buffer) => void,
    onEof?: () => void,
  ): Promise<TerminalStream> {
    return new Promise((resolve, reject) => {
      const path = mainPipePath(this.projectDir, this.pipeOverride);
      const sock = net.connect(path);
      const reader = new FrameReader();
      reader.onFrame = (f) => onFrame(f.stepId, f.payload);
      reader.onEof = () => onEof?.();
      sock.on("data", (chunk: Buffer) => reader.feed(chunk));
      // A connect failure is an error, not a graceful end-of-stream: `onEof`
      // must fire only on the server-written EOF frame, or an unbound pipe
      // would surface as a clean "exit" to the consumer.
      sock.once("error", (err) => reject(err));
      sock.once("connect", () => {
        this.sockets.add(sock);
        sock.on("close", () => this.sockets.delete(sock));
        resolve({ socket: sock, close: () => sock.destroy() });
      });
    });
  }

  /**
   * Open the run's terminal pipe and stream length-prefixed frames. Call
   * `attach(runId)` first so the daemon lazily binds the pipe. Resolves once
   * connected; `onFrame` receives each decoded frame's stepId + payload (see
   * `TerminalFrame`), `onEof` fires on the zero-length EOF frame.
   */
  attachTerminal(
    runId: string,
    onFrame: (stepId: string, payload: Buffer) => void,
    onEof?: () => void,
  ): Promise<TerminalStream> {
    return new Promise((resolve, reject) => {
      const path = terminalPipePath(this.projectDir, runId, this.pipeOverride);
      const sock = net.connect(path);
      const reader = new FrameReader();
      reader.onFrame = (f) => onFrame(f.stepId, f.payload);
      reader.onEof = () => onEof?.();
      sock.on("data", (chunk: Buffer) => reader.feed(chunk));
      sock.once("error", (err) => reject(err));
      sock.once("connect", () => {
        this.sockets.add(sock);
        sock.on("close", () => this.sockets.delete(sock));
        resolve({ socket: sock, close: () => sock.destroy() });
      });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { this.conn.dispose(); } catch { /* ignore */ }
    for (const sock of this.sockets) sock.destroy();
    this.sockets.clear();
  }
}