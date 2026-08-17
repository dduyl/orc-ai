import { spawn } from "cross-spawn";
import type { Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Stream,
  type ClientContext,
  type ActiveSession,
  type ActiveSessionMessage,
  type ContentBlock,
  type SessionConfigOption,
  type ToolCall,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk";

import { log } from "../../../core/log.js";
import { normalizeUsage } from "../../agents/acp/client.js";
import type { AgentUsage, AcpStopReason } from "../../agents/acp/types.js";
import { autoPermissionMode, gateFromEnv, PermissionGate, type PermissionRequest } from "../../agents/acp/permission.js";
import type { PermissionAnswerKind } from "../../agents/acp/types.js";
import type { PromptMention } from "./rpc-protocol.js";
import { MAIN_STEP_ID, writeEofFrame, writeFrame } from "./frame-transport.js";
import { encodeMainFrame, type AgentCommand, type AgentConfigOption, type MainFrame } from "./main-frame-codec.js";

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
  /**
   * Reader handed over by `drainInitialUpdates` when its grace window expired
   * with a `nextUpdate()` still pending. `runTurn` consumes it before issuing a
   * fresh read so the timed-out reader never lingers and swallows a real turn
   * update (the SDK queue is FIFO; an abandoned waiter steals the next value).
   */
  private pendingIdleUpdate: Promise<ActiveSessionMessage> | null = null;
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
  prompt(text: string, mentions?: PromptMention[]): void {
    if (this.closed) throw new Error("main ACP session is closed");
    this.queue.push({ text, mentions: mentions ?? [] });
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

  /**
   * Set a session config option (e.g. the model) via `session/set_config_option`.
   * The full refreshed option set is re-emitted as a `config` frame. Throws once
   * the session is closed; rejects if the agent does not support the option.
   */
  async setConfigOption(configId: string, value: string): Promise<void> {
    if (this.closed || !this.ctx || !this.sessionId) {
      throw new Error("main ACP session is not open");
    }
    const res = await this.ctx.request(methods.agent.session.setConfigOption, {
      sessionId: this.sessionId,
      configId,
      value,
    });
    this.emit({ kind: "config", options: normalizeConfigOptions(res.configOptions) });
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
          const sessionConfig = session.newSessionResponse.configOptions;
          if (sessionConfig) this.emit({ kind: "config", options: normalizeConfigOptions(sessionConfig) });
          await this.drainInitialUpdates(session);
          for (;;) {
            const turn = await this.queue.take();
            if (turn === null || this.closed) break;
            await this.runTurn(ctx, session, turn);
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

  /**
   * Drain the session-update burst emitted right after `session/new` (e.g.
   * opencode's `available_commands_update` at session create) so commands and
   * config are available before the user's first prompt. Bounded by a grace
   * window; when it expires mid-read the still-pending reader is parked in
   * {@link pendingIdleUpdate} for {@link runTurn} to consume first — a pending
   * `nextUpdate()` must never be abandoned, or it would consume the next real
   * turn update out of turn.
   */
  private async drainInitialUpdates(session: ActiveSession): Promise<void> {
    const deadline = Date.now() + 300;
    let next: Promise<ActiveSessionMessage> | null = session.nextUpdate();
    for (;;) {
      const remaining = deadline - Date.now();
      const msg = await Promise.race([
        next,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(remaining, 0))),
      ]);
      if (msg === null) {
        if (!this.closed) this.pendingIdleUpdate = next;
        return;
      }
      if (msg.kind === "stop") return;
      this.forwardUpdate(msg.update);
      next = session.nextUpdate();
    }
  }

  private async runTurn(ctx: ClientContext, session: ActiveSession, turn: PromptTurn): Promise<void> {
    const blocks = this.toContentBlocks(turn);
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
    const promptPromise = session.prompt(blocks).catch(() => undefined);
    let stopReason: AcpStopReason = "end_turn";
    let nextMsg: Promise<ActiveSessionMessage> | null = this.pendingIdleUpdate;
    this.pendingIdleUpdate = null;
    try {
      for (;;) {
        const msg: ActiveSessionMessage = nextMsg ? await nextMsg : await session.nextUpdate();
        nextMsg = null;
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

  /**
   * Build the `session/prompt` content blocks for a user turn: the text chunk
   * plus one `resource_link` per `@path` mention (file:// URI). Without
   * mentions this is just the plain-text block, keeping the common case
   * identical to the pre-mention wire format.
   */
  private toContentBlocks(turn: PromptTurn): ContentBlock[] {
    const blocks: ContentBlock[] = [{ type: "text", text: turn.text }];
    for (const mention of turn.mentions) {
      if (!mention.path) continue;
      blocks.push({
        type: "resource_link",
        name: mention.path,
        uri: mentionUri(mention.path, this.opts.cwd),
      });
    }
    return blocks;
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
      case "available_commands_update": {
        const list = (update as { availableCommands?: Array<{ name?: string; description?: string; input?: { hint?: string } | null } | null> }).availableCommands;
        if (Array.isArray(list)) {
          const commands: AgentCommand[] = [];
          for (const raw of list) {
            if (!raw || typeof raw.name !== "string") continue;
            commands.push({ name: raw.name, description: raw.description ?? "", input: raw.input?.hint });
          }
          this.emit({ kind: "commands", commands });
        }
        break;
      }
      case "config_option_update": {
        const list = (update as { configOptions?: SessionConfigOption[] }).configOptions;
        if (Array.isArray(list)) this.emit({ kind: "config", options: normalizeConfigOptions(list) });
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

/**
 * Build the `file://` URI for a mention path. Absolute paths are used as-is;
 * relative paths resolve against `cwd`.
 */
function mentionUri(path: string, cwd: string): string {
  const resolved = path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) ? path : `${cwd}/${path}`;
  return pathToFileURL(resolved).href;
}

/** FIFO of user prompts; `null` from `take()` signals the session is closing. */
class PromptQueue {
  private items: PromptTurn[] = [];
  private waiters: ((turn: PromptTurn | null) => void)[] = [];

  push(turn: PromptTurn): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(turn);
      return;
    }
    this.items.push(turn);
  }

  take(): Promise<PromptTurn | null> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.items.length = 0;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }
}

/** One queued user turn: the composer text plus any `@`-mention attachments. */
interface PromptTurn {
  text: string;
  mentions: PromptMention[];
}

/**
 * Normalize the ACP `SessionConfigOption` union into renderer-facing selectors.
 * Select groups are flattened; unknown/unsupported option shapes are skipped.
 */
function normalizeConfigOptions(options: SessionConfigOption[]): AgentConfigOption[] {
  const out: AgentConfigOption[] = [];
  for (const opt of options) {
    if (opt.type === "boolean") {
      out.push({
        id: opt.id,
        name: opt.name,
        category: opt.category,
        type: "boolean",
        currentValue: opt.currentValue,
      });
    } else if (opt.type === "select") {
      const choices: Array<{ value: string; name: string }> = [];
      for (const item of opt.options) {
        if ("options" in item) {
          for (const sub of item.options) choices.push({ value: sub.value, name: sub.name });
        } else {
          choices.push({ value: item.value, name: item.name });
        }
      }
      out.push({
        id: opt.id,
        name: opt.name,
        category: opt.category,
        type: "select",
        currentValue: typeof opt.currentValue === "string" ? opt.currentValue : null,
        options: choices,
      });
    }
  }
  return out;
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
