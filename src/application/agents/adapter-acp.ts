import type { IDisposable, IPty } from "node-pty";
import type { AdapterDef, AgentCallResult } from "./adapter.js";
import type { Tier } from "./config.js";
import { HOOK_FILE_ENV, type StepQuotaInfo } from "../../core/hooks.js";
import type { AcpSpawnSpec, OnProviderQuota, TokenPaidRequest } from "./acp/types.js";
import { gateFromEnv } from "./acp/permission.js";
import { runAcpTurn } from "./acp/client.js";
import { getAcpStrategy } from "./strategy.js";
import { getAgentCwd } from "./agent-cwd.js";
import { createHookFile, removeHookFile, appendHookEvent, stepIdFromHookFile } from "../../adapters/hooks/endpoint.js";
import { renderToolCall, renderToolCallUpdate } from "./acp/render.js";
import { log } from "../../core/log.js";
import { AgentCallError, classifyAgentError, toQuotaInfo } from "./errors.js";

/** Env switch that routes supported adapters through ACP instead of the PTY. */
export const ACP_ENABLED_ENV = "ORC_ACP_ENABLED";

/**
 * Whether an adapter should dispatch through ACP for this process.
 * `ORC_ACP_ENABLED=1` opts in; the adapter must also have a registered ACP
 * strategy whose probe succeeded. Absent either, the PTY path stays active.
 */
export function acpEnabledFor(adapterId: string): boolean {
  if (process.env[ACP_ENABLED_ENV] !== "1") return false;
  const strat = getAcpStrategy(adapterId);
  if (!strat) return false;
  if (!strat.available) {
    log.info(`acp: '${adapterId}' strategy unavailable (${strat.label}) — falling back to PTY`);
    return false;
  }
  return true;
}

type DataListener = (data: string) => void;
type ExitListener = (e: { exitCode: number; signal?: number }) => void;

class AcpEvent<T> {
  private listeners = new Set<(value: T) => void>();
  fire(listener: (value: T) => void): IDisposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  emit(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch {
        /* a bad consumer must not break the turn */
      }
    }
  }
}

/**
 * Duck-typed `IPty` facade over an ACP turn.
 *
 * The daemon and step-handler only consume `onData` (terminal feed) and
 * `kill` (abort); the remaining IPty members are inert stubs so the facade can
 * be cast to `IPty` without changing callers.
 */
export class AcpPtyFacade {
  readonly pid = -1;
  readonly cols = 120;
  readonly rows = 40;
  readonly process = "acp";
  handleFlowControl = false;

  readonly onData: (listener: DataListener) => IDisposable;
  readonly onExit: (listener: ExitListener) => IDisposable;

  private dataEvent = new AcpEvent<string>();
  private exitEvent = new AcpEvent<{ exitCode: number; signal?: number }>();
  private controller = new AbortController();
  private killed = false;

  constructor() {
    this.onData = (l: DataListener) => this.dataEvent.fire(l);
    this.onExit = (l: ExitListener) => this.exitEvent.fire(l);
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Emit agent output; wired to the turn's text stream. */
  feed(text: string): void {
    this.dataEvent.emit(text);
  }

  /** Emit completion; resolves waiters watching the facade like a PTY. */
  finish(exitCode: number, signal?: number): void {
    this.exitEvent.emit({ exitCode, signal });
  }

  write(): void {
    throw new Error("write() is not supported over ACP (Phase 1): raw bytes would corrupt the NDJSON stream");
  }

  resize(): void {
    /* the ACP server owns its own terminal sizing */
  }

  clear(): void {
    /* no internal buffer to clear */
  }

  pause(): void {
    /* flow control is not used over ACP */
  }

  resume(): void {
    /* flow control is not used over ACP */
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.controller.abort();
  }
}

export interface AgentACPStreamHandle {
  pty: IPty;
  promise: Promise<AgentCallResult>;
}

/** Serialize a tool's raw input for the hook `ToolCallEvent.input` field. */
function serializeToolInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  try {
    const json = JSON.stringify(input);
    return json.length > 2000 ? json.slice(0, 2000) + "…" : json;
  } catch {
    return String(input);
  }
}

/**
 * Run one agent turn over ACP. Mirrors `callAgentStream`'s contract but the
 * returned `pty` is an {@link AcpPtyFacade} the daemon can feed on.
 */
export function callAcpAgentStream(
  adapter: AdapterDef,
  prompt: string,
  hookFilePath?: string,
  downgradeTo?: string,
  variantTier?: Tier,
  variantModel?: string,
  configuredProviders?: string[],
  onProviderQuota?: OnProviderQuota,
  tokenPaid?: TokenPaidRequest,
): AgentACPStreamHandle {
  const strat = getAcpStrategy(adapter.id);
  if (!strat || !strat.available) {
    throw new Error(`ACP strategy for '${adapter.id}' is unavailable (${strat?.label ?? "none"})`);
  }

  const hookFile = hookFilePath || createHookFile("unknown");
  const stepId = stepIdFromHookFile(hookFile);
  const facade = new AcpPtyFacade();
  const spec: AcpSpawnSpec = strat.buildSpawn(getAgentCwd());
  const gate = gateFromEnv();

  const feedLines = (lines: string[]): void => {
    for (const line of lines) facade.feed(line + "\r\n");
  };
  const appendStepFinish = (
    reason: string,
    tokens?: { total: number; input: number; output: number },
    quota?: StepQuotaInfo,
  ): void => {
    appendHookEvent(hookFile, {
      type: "step_finish",
      timestamp: Date.now(),
      stepId,
      reason,
      tokens,
      ...(quota ? { quota } : {}),
    });
  };

  const start = Date.now();
  const promise = runAcpTurn({
    spawn: spec,
    cwd: getAgentCwd(),
    env: { ...process.env, [HOOK_FILE_ENV]: hookFile } as Record<string, string>,
    prompt,
    permissionGate: gate,
    signal: facade.signal,
    ...(downgradeTo ? { downgradeTo } : {}),
    ...(variantTier ? { variantTier } : {}),
    ...(variantModel ? { variantModel } : {}),
    ...(configuredProviders && configuredProviders.length > 0 ? { configuredProviders } : {}),
    ...(onProviderQuota ? { onProviderQuota } : {}),
    ...(tokenPaid ? { tokenPaid } : {}),
    events: {
      onText: text => facade.feed(text),
      onToolCall: call => {
        try {
          feedLines(renderToolCall(call));
          appendHookEvent(hookFile, {
            type: "tool_call",
            timestamp: Date.now(),
            stepId,
            tool: call.name ?? call.kind ?? "unknown",
            input: serializeToolInput(call.rawInput),
          });
        } catch (err) {
          log.warn(`acp: failed to render tool_call: ${(err as Error).message}`);
        }
      },
      onToolCallUpdate: update => {
        try {
          feedLines(renderToolCallUpdate(update));
        } catch (err) {
          log.warn(`acp: failed to render tool_call_update: ${(err as Error).message}`);
        }
      },
      onUsage: () => {
        /* Phase 2: surface usage to the GUI live */
      },
    },
  })
    .then(turn => {
      facade.finish(turn.stopReason === "cancelled" ? 1 : 0);
      appendStepFinish(turn.stopReason, {
        total: turn.usage.totalTokens,
        input: turn.usage.inputTokens,
        output: turn.usage.outputTokens,
      });
      if (turn.configuredModel) {
        log.info(`acp: '${adapter.id}' running on pre-configured model '${turn.configuredModel}'`);
      }
      if (!hookFilePath) removeHookFile(hookFile);
      return {
        content: turn.content,
        model: adapter.id,
        tokensUsed: turn.usage.totalTokens,
        duration: turn.duration,
        usage: turn.usage,
        ...(turn.downgraded && downgradeTo ? { downgradedTo: downgradeTo } : {}),
      };
    })
    .catch((err: unknown) => {
      facade.finish(1);
      const agentErr = err instanceof AgentCallError ? err : classifyAgentError(err);
      appendStepFinish(agentErr.kind === "quota" ? "quota" : "error", undefined, agentErr.kind === "quota" ? toQuotaInfo(agentErr) : undefined);
      if (!hookFilePath) removeHookFile(hookFile);
      throw err;
    });

  return { pty: facade, promise };
}