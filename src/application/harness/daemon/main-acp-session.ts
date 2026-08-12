import { spawn } from "node:child_process";
import type { Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Stream,
  type ClientContext,
  type ActiveSession,
  type ActiveSessionMessage,
  type ToolCall,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk";

import { log } from "../../../core/log.js";
import { normalizeUsage } from "../../agents/acp/client.js";
import type { AgentUsage, AcpStopReason } from "../../agents/acp/types.js";
import { autoPermissionMode, gateFromEnv, PermissionGate, type PermissionRequest } from "../../agents/acp/permission.js";
import type { PermissionAnswerKind } from "../../agents/acp/types.js";
import { MAIN_STEP_ID, writeEofFrame, writeFrame } from "./frame-transport.js";
import { encodeMainFrame, type MainFrame } from "./main-frame-codec.js";

/**
 * Persistent ACP-backed main session (ADR-026, Phase 3).
 *
 * Owns one long-lived agent child + `session/new`, and converts every prompt
 * turn's ACP events into `__main__` {@link MainFrame} frames fanned out over
 * the daemon's main pipe (see {@link DaemonServer.attachMainStream}).
 *
 * Lifecycle / concurrency model:
 * - `start()` launches the child and runs a single connectWith operation whose
 *   `withSession` block drives an internal prompt queue. Prompts submitted via
 *   `prompt()` are serialized: exactly one turn is in flight at a time.
 * - Turns are cancellable (`cancelTurn()`) via `session/cancel`; the next
 *   queued prompt runs once the cancelled turn drains.
 * - `attach(socket)` is the same replay+live contract as {@link attachMainStream}:
 *   a late client gets buffered frames then live frames; an EOF frame + close on
 *   socket end.
 * - `close()` unblocks the queue loop, emits EOF to every client, and kills the
 *   child. This is the only terminal state.
 *
 * The session only exists while the ACP child does. Permissions stay on the
 * control pipe: the permission gate forwards `permissionRequested` to the
 * daemon, and {@link answerPermission} routes `answerPermission` back in.
 */
export interface MainAcpSessionOptions {
  /** Working directory for the child and the ACP session. */
  cwd: string;
  /** Resolved spawn spec (command + args) for the persistent agent. */
  spawn: { command: string; args: string[] };
  /** Full environment for the child. */
  env: Record<string, string>;
  /** Called for every `session/request_permission` (daemon → control pipe). */
  onPermission?: (request: PermissionRequest) => void;
  /** Fired once the session has fully closed (child dead, clients EOFed). */
  onExit?: () => void;
}

export class MainAcpSession {
  static readonly MAX_REPLAY_FRAMES = 5000;

  readonly kind = "acp" as const;

  private readonly opts: MainAcpSessionOptions;
  private readonly gate: PermissionGate;
  private readonly queue = new PromptQueue();
  private readonly exits = new ExitEvent();

  private clients = new Set<Socket>();
  private replay: Buffer[] = [];

  private bootPromise: Promise<void> | null = null;
  private child: ReturnType<typeof spawn> | null = null;
  private ctx: ClientContext | null = null;
  private sessionId: string | null = null;
  private cancelCurrent: (() => void) | null = null;
  private closed = false;

  constructor(opts: MainAcpSessionOptions) {
    this.opts = opts;
    this.gate = gateFromEnv();
    if (autoPermissionMode() === "safe_hold" && opts.onPermission) {
      this.gate.setHandler({ onPermission: opts.onPermission });
    }
  }

  get active(): boolean {
    return !this.closed && this.child !== null;
  }

  get exited(): boolean {
    return this.closed;
  }

  get session(): string | null {
    return this.sessionId;
  }

  /** Spawn the agent and drive the session loop; resolves once the loop exits. */
  start(): Promise<void> {
    if (!this.bootPromise) this.bootPromise = this.boot();
    return this.bootPromise;
  }

  /** Register a listener fired exactly once when the session closes. */
  onExit(listener: () => void): () => void {
    return this.exits.fire(listener);
  }

  /** Queue a user prompt turn. Throws once the session is closed. */
  prompt(text: string): void {
    if (this.closed) throw new Error("main ACP session is closed");
    this.queue.push(text);
  }

  /** Cancel the in-flight turn (no-op when idle or closed). */
  cancelTurn(): void {
    this.cancelCurrent?.();
  }

  /**
   * Answer the permission request identified by `requestId`. Returns false when
   * the requestId is unknown (already answered / never existed), so a stale or
   * mistargeted answer is a no-op instead of resolving a newer request.
   */
  answerPermission(requestId: string, kind: PermissionAnswerKind): boolean {
    return this.gate.answer(requestId, kind) !== null;
  }

  /** Replay + live `__main__` frames to a main-pipe client. */
  attach(socket: Socket): void {
    socket.on("error", () => {});
    for (const buf of this.replay) writeFrame(socket, MAIN_STEP_ID, buf);
    if (this.closed) {
      writeEofFrame(socket);
      socket.end();
      return;
    }
    this.clients.add(socket);
    const cleanup = (): void => {
      this.clients.delete(socket);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  }

  /** Teardown: unblock the loop, EOF + close clients, kill the child. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.close();
    this.gate.cancel();
    for (const sock of [...this.clients]) {
      if (!sock.destroyed) {
        writeEofFrame(sock);
        sock.end();
      }
      this.clients.delete(sock);
    }
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    this.exits.emit();
  }

  private async boot(): Promise<void> {
    const { spawn: spec, cwd, env } = this.opts;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.command, spec.args, { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitError(`Failed to spawn ACP agent '${spec.command}': ${message}`);
      this.close();
      return;
    }
    this.child = child;

    const spawnFailed = new Promise<Error>((resolve) => {
      child.once("error", (err) =>
        resolve(new Error(`Failed to spawn ACP agent '${spec.command}': ${err.message}`)),
      );
    });
    child.on("error", () => {
      /* consumed above; connectWith reports the failure */
    });
    child.once("exit", () => {
      if (!this.closed) {
        log.warn(`[main-acp] agent '${spec.command}' exited`);
        this.close();
      }
    });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    ) as Stream;

    const app = client({ name: "orc" })
      .onRequest(methods.client.session.requestPermission, (ctx) => this.gate.handle(ctx.params))
      .onRequest(methods.client.fs.writeTextFile, () => {
        throw new Error("fs/write_text_file is not supported by the orc ACP client (Phase 1)");
      })
      .onRequest(methods.client.fs.readTextFile, () => {
        throw new Error("fs/read_text_file is not supported by the orc ACP client (Phase 1)");
      })
      .onRequest(methods.client.elicitation.create, () => {
        throw new Error("elicitation/create is not supported by the orc ACP client (Phase 1)");
      });

    try {
      await app.connectWith(stream, async (ctx) => {
        this.ctx = ctx;
        await ctx.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { session: {} },
          clientInfo: { name: "orc", version: "0.1.0" },
        });
        await ctx.buildSession(cwd).withSession(async (session) => {
          this.sessionId = session.sessionId;
          log.info(`[main-acp] session ${session.sessionId} open (${spec.command})`);
          for (;;) {
            const text = await this.queue.take();
            if (text === null || this.closed) break;
            await this.runTurn(ctx, session, text);
          }
        });
      });
    } catch (err) {
      if (!this.closed) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`[main-acp] session error: ${message}`);
        this.emitError(message);
      }
    } finally {
      this.close();
    }
  }

  private async runTurn(ctx: ClientContext, session: ActiveSession, text: string): Promise<void> {
    let cancelSent = false;
    this.cancelCurrent = () => {
      if (cancelSent || this.closed) return;
      cancelSent = true;
      void ctx
        .notify(methods.agent.session.cancel, { sessionId: session.sessionId })
        .catch(() => {});
    };
    // The stop message already carries the PromptResponse; we only keep this
    // promise to avoid an unhandled rejection if the turn is cancelled.
    const promptPromise = session.prompt(text).catch(() => undefined);
    let stopReason: AcpStopReason = "end_turn";
    try {
      for (;;) {
        const msg: ActiveSessionMessage = await session.nextUpdate();
        if (msg.kind === "stop") {
          stopReason = msg.stopReason;
          const usage = normalizeUsage(msg.response.usage);
          if (usage.totalTokens > 0) this.emit({ kind: "usage", usage });
          this.emit({ kind: "turn", stopReason });
          break;
        }
        this.forwardUpdate(msg.update);
      }
      await promptPromise;
    } catch (err) {
      if (!this.closed) {
        const message = err instanceof Error ? err.message : String(err);
        this.emitError(message);
        // Close the turn sequence too (divider + counter) so the next user
        // turn isn't numbered as a re-run of the errored one.
        this.emit({ kind: "turn", stopReason: "error" });
      }
    } finally {
      this.cancelCurrent = null;
    }
  }

  private forwardUpdate(update: NonNullable<unknown> & { sessionUpdate?: string }): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = (update as { content?: { type?: string; text?: string } }).content;
        if (content?.type === "text" && typeof content.text === "string") {
          this.emit({ kind: "text", text: content.text });
        }
        break;
      }
      case "tool_call":
        this.emit({ kind: "tool", call: update as unknown as ToolCall });
        break;
      case "tool_call_update":
        this.emit({ kind: "tool_update", update: update as unknown as ToolCallUpdate });
        break;
      case "usage_update": {
        const used = (update as { used?: number }).used;
        if (typeof used === "number") {
          this.emit({ kind: "usage", usage: { totalTokens: used, inputTokens: 0, outputTokens: 0 } });
        }
        break;
      }
      default:
        break;
    }
  }

  private emit(frame: MainFrame): void {
    if (this.closed) return;
    const buf = encodeMainFrame(frame);
    if (this.replay.length >= MainAcpSession.MAX_REPLAY_FRAMES) this.replay.shift();
    this.replay.push(buf);
    for (const sock of [...this.clients]) {
      if (sock.destroyed) {
        this.clients.delete(sock);
        continue;
      }
      writeFrame(sock, MAIN_STEP_ID, buf);
    }
  }

  private emitError(message: string): void {
    this.emit({ kind: "error", message });
  }
}

/** FIFO of user prompts; `null` from `take()` signals the session is closing. */
class PromptQueue {
  private items: string[] = [];
  private waiters: ((text: string | null) => void)[] = [];

  push(text: string): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(text);
      return;
    }
    this.items.push(text);
  }

  take(): Promise<string | null> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.items.length = 0;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }
}

/** Tiny event emitter for the single-shot exit notification. */
class ExitEvent {
  private listeners = new Set<() => void>();

  fire(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        /* listener errors must not break teardown */
      }
    }
  }
}
