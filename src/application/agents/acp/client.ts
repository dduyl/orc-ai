import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Stream,
} from "@agentclientprotocol/sdk";
import type { Usage, ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { AcpSpawnSpec, AcpStopReason, AcpTurnResult, AgentUsage } from "./types.js";
import type { PermissionGate } from "./permission.js";
import { log } from "../../../core/log.js";

export interface AcpClientEvents {
  /** Streamed agent text (emitted as it arrives). */
  onText?(text: string): void;
  /** A tool call started (ACP `tool_call` session update). */
  onToolCall?(call: ToolCall): void;
  /** A tool call updated (ACP `tool_call_update` session update). */
  onToolCallUpdate?(update: ToolCallUpdate): void;
  /** Normalized usage so far (from `usage_update` notifications). */
  onUsage?(usage: AgentUsage): void;
}

export interface AcpTurnOptions {
  spawn: AcpSpawnSpec;
  cwd: string;
  env: Record<string, string>;
  prompt: string;
  permissionGate: PermissionGate;
  events?: AcpClientEvents;
  /** Abort → sends `session/cancel` and settles with the partial content. */
  signal?: AbortSignal;
}

export function normalizeUsage(input?: Usage | null): AgentUsage {
  return {
    totalTokens: input?.totalTokens ?? 0,
    inputTokens: input?.inputTokens ?? 0,
    outputTokens: input?.outputTokens ?? 0,
    thoughtTokens: input?.thoughtTokens ?? undefined,
    cachedReadTokens: input?.cachedReadTokens ?? undefined,
    cachedWriteTokens: input?.cachedWriteTokens ?? undefined,
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Best-effort post-turn cleanup so a per-step ACP server never lingers. */
function scheduleKill(child: ChildProcess): void {
  setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }, 150).unref();
}

/**
 * Run one ACP prompt turn over a stdio-spawned agent server.
 *
 * Returns a full `AcpTurnResult`; resolves (not rejects) on cancellation so a
 * caller that raced cancellation elsewhere never sees an unhandled rejection.
 */
export async function runAcpTurn(opts: AcpTurnOptions): Promise<AcpTurnResult> {
  const start = Date.now();
  const { spawn: spec, cwd, env, prompt, permissionGate, events, signal } = opts;

  const child = spawn(spec.command, spec.args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "ignore"],
  });

  let cancelled = false;
  const killChild = (): void => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  };
  // Register before any round-trip so an abort landing during initialize or
  // session/new still settles as cancelled (harness invariant: handle.promise
  // must resolve after cancellation, never reject). An already-aborted signal
  // fires onAbort on the next microtask.
  const onAbort = (): void => {
    cancelled = true;
    killChild();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  // child.kill() is a no-op before the process materializes; retry at spawn.
  child.once("spawn", () => {
    if (cancelled) killChild();
  });

  // Spawn failures (ENOENT etc.) surface asynchronously; capture them so the
  // turn rejects with an actionable message instead of a raw stream error.
  const spawnFailed = deferred<Error>();
  child.once("error", err => {
    spawnFailed.resolve(new Error(`Failed to spawn ACP agent '${spec.command}': ${err.message}`));
  });
  child.on("error", () => {
    /* consumed above; stream layer reports the same failure */
  });

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  ) as Stream;

  const content: string[] = [];
  let finalUsage: AgentUsage = { totalTokens: 0, inputTokens: 0, outputTokens: 0 };

  const app = client({ name: "orc" })
    .onRequest(methods.client.session.requestPermission, ctx => permissionGate.handle(ctx.params))
    .onRequest(methods.client.fs.writeTextFile, () => {
      throw new Error("fs/write_text_file is not supported by the orc ACP client (Phase 1)");
    })
    .onRequest(methods.client.fs.readTextFile, () => {
      throw new Error("fs/read_text_file is not supported by the orc ACP client (Phase 1)");
    })
    .onRequest(methods.client.elicitation.create, () => {
      throw new Error("elicitation/create is not supported by the orc ACP client (Phase 1)");
    });

  const turn = app.connectWith(stream, async ctx => {
    await ctx.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { session: {} },
      clientInfo: { name: "orc", version: "0.1.0" },
    });
    return ctx.buildSession(cwd).withSession(async session => {
      let cancelSent = false;
      signal?.addEventListener(
        "abort",
        () => {
          if (cancelSent) return;
          cancelSent = true;
          void ctx.notify(methods.agent.session.cancel, { sessionId: session.sessionId }).catch(() => {});
        },
        { once: true },
      );

      const promptPromise = session.prompt(prompt);
      let stopReason: AcpStopReason = "end_turn";
      for (;;) {
        const msg = await session.nextUpdate();
        if (msg.kind === "stop") {
          stopReason = msg.stopReason;
          finalUsage = normalizeUsage(msg.response.usage);
          break;
        }
        const update = msg.update;
        switch (update.sessionUpdate) {
          case "agent_message_chunk": {
            if (update.content?.type === "text") {
              content.push(update.content.text);
              events?.onText?.(update.content.text);
            }
            break;
          }
          case "tool_call":
            events?.onToolCall?.(update);
            break;
          case "tool_call_update":
            events?.onToolCallUpdate?.(update);
            break;
          default:
            // plans / session_info / usage_update pass through as no-ops.
            break;
        }
      }
      const promptResponse = await promptPromise;
      const promptUsage = normalizeUsage(promptResponse.usage);
      if (promptUsage.totalTokens > 0) finalUsage = promptUsage;
      return { stopReason };
    });
  });

  let settled: { stopReason: AcpStopReason } | null = null;
  try {
    settled = await Promise.race([turn, spawnFailed.promise.then(err => Promise.reject(err))]);
  } catch (err) {
    if (cancelled) {
      return {
        stopReason: "cancelled",
        content: content.join(""),
        usage: finalUsage,
        duration: Date.now() - start,
        error: (err as Error).message,
      };
    }
    throw err;
  } finally {
    scheduleKill(child);
    signal?.removeEventListener("abort", onAbort);
  }

  return {
    stopReason: settled!.stopReason,
    content: content.join(""),
    usage: finalUsage,
    duration: Date.now() - start,
  };
}