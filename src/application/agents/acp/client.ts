import { spawn } from "cross-spawn";
import type { ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Stream,
} from "@agentclientprotocol/sdk";
import type { Usage, ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type {
  AcpSpawnSpec,
  AcpStopReason,
  AcpTurnResult,
  AgentUsage,
  AcpProviderConfig,
  AcpProviderInfo,
  OnProviderQuota,
  ProviderFailoverResult,
  ProviderRouter,
  TokenPaidRequest,
} from "./types.js";
import type { PermissionGate } from "./permission.js";
import type { Tier, ProviderConfig } from "../config.js";
import { MODELS_SNAPSHOT, selectVariantModel } from "../models.js";
import { classifyAgentError, AgentCallError, type EnvAuthMethodInfo } from "../errors.js";
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
  /**
   * ADR-022: model to downgrade to (via a same-session
   * `session/set_config_option` + a second prompt) when the first prompt
   * fails with a quota error. Never touches the child process.
   */
  downgradeTo?: string;
  /**
   * ADR-021: model tier ("cheap" | "strong") decided by the harness for this
   * turn. When a concrete model is not given (`variantModel`), the session
   * model is pre-emptively configured to the cheapest-of-tier advertised
   * model before the first prompt.
   */
  variantTier?: Tier;
  /**
   * ADR-021: concrete model chosen by the harness (the user's
   * `variants.<agent>.<tier>` override). Applied pre-emptively via
   * `session/set_config_option` before the first prompt; honored even when
   * the model is not in the agent's advertised list.
   */
  variantModel?: string;
  /**
   * ADR-021: providers the user has credentials for (the provider filter
   * input). Empty means "unknown" — selection degrades to the agent default.
   */
  configuredProviders?: string[];
  /**
   * ADR-021 (provider failover): seam consulted when a prompt hits a quota
   * error AND the agent advertises the `providers` capability. Runs BEFORE the
   * same-session `downgradeTo` retry; a returned failover switches providers
   * (`providers/list` + `providers/set`), applies the re-resolved model, and
   * re-runs the prompt against the new provider. Returning `undefined` (or
   * throwing) falls through to the downgrade path.
   */
  onProviderQuota?: OnProviderQuota;
  /**
   * ADR-021 (M4): the routing config's `providers` block, surfaced to the
   * `onProviderQuota` context so a seam can build a `providers/set {
   * apiType, baseUrl, headers }` payload without re-reading config.
   */
  providerConfig?: ProviderConfig;
  /**
   * ADR-021 Phase F (token-paid fallback): the harness re-invokes the step once
   * with this set after a quota error when the agent advertised an env-var auth
   * method AND a `tokenPaidApiKey` is configured. The key is injected into the
   * child environment at `envVarName` (overriding any inherited value), the
   * agent is asked to authenticate via `authenticate`, and the prompt is run
   * ONCE with NO failover/downgrade recovery — a second quota surfaces
   * immediately so the harness (token-paid already tried) pauses. The key must
   * never be logged.
   */
  tokenPaid?: TokenPaidRequest;
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

interface ModelSelector {
  /** Config-option id of the agent's model selector (usually "model"). */
  configId: string;
  /** Model ids the agent advertised via `session/new` configOptions. */
  advertised: string[];
}

/**
 * The agent's model selector from the `session/new` response. Per the ACP
 * spec the "model" category is a `select`; the option values are the agent's
 * advertised model list (advertised order carries no signal). Absent a select
 * of category "model", selection degrades to the agent default: configId
 * "model" + an empty advertised list.
 */
function modelSelector(configOptions?: Array<unknown> | null): ModelSelector {
  for (const raw of configOptions ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const option = raw as {
      id?: unknown;
      category?: unknown;
      type?: unknown;
      options?: Array<{ value?: unknown }> | null;
    };
    if (option.category !== "model" || option.type !== "select") continue;
    return {
      configId: typeof option.id === "string" && option.id ? option.id : "model",
      advertised: (option.options ?? [])
        .map(o => (typeof o.value === "string" ? o.value : ""))
        .filter(Boolean),
    };
  }
  return { configId: "model", advertised: [] };
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
  const { spawn: spec, cwd, env, prompt, permissionGate, events, signal, downgradeTo, tokenPaid } = opts;

  const child = spawn(spec.command, spec.args, {
    cwd,
    // ADR-021 Phase F: the token-paid key is injected into the child env before
    // the process starts (explicitly overriding any inherited value — the
    // configured key wins). The agent reads it from `envVarName`.
    env: tokenPaid ? { ...env, [tokenPaid.envVarName]: tokenPaid.key } : env,
    stdio: ["pipe", "pipe", "ignore"],
  });

  let cancelled = false;
  let handshakeDone = false;
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
    const init = await ctx.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { session: { configOptions: {} } },
      clientInfo: { name: "orc", version: "0.1.0" },
    });
    handshakeDone = true;
    // UNSTABLE ACP capability: only agents advertising `providers` will
    // answer `providers/list` / `providers/set`, which the failover seam needs.
    const providerRouting = Boolean(init.agentCapabilities?.providers);
    // ADR-021 Phase F: the env-var auth methods the agent advertises at
    // initialize. These are carried back to the harness on quota errors so it
    // can decide whether a token-paid retry (key via env var + `authenticate`)
    // is possible. Agents without an env-var method get an empty list → the
    // harness skips straight to pause.
    const envVarAuthMethods: EnvAuthMethodInfo[] = (init.authMethods ?? [])
      .map(m => ("type" in m && m.type === "env_var" ? { methodId: m.id, envVarName: m.vars[0]?.name ?? "" } : null))
      .filter((m): m is EnvAuthMethodInfo => m !== null && m.envVarName.length > 0);
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

      const { configId, advertised } = modelSelector(session.newSessionResponse.configOptions);
      const setConfigOption = (modelId: string): Promise<unknown> =>
        ctx.request(methods.agent.session.setConfigOption, {
          sessionId: session.sessionId,
          configId,
          value: modelId,
        });

      // ADR-021 Phase F: the provider id currently in effect, tracked so the
      // quota errors surfaced to the harness let it pick a per-provider
      // `tokenPaidApiKey`. Set only after a successful failover; otherwise
      // undefined (top-level key applies).
      let providerInEffect: string | undefined;

      // ADR-021 Phase F: ask the agent to authenticate with the injected
      // env-var key BEFORE the (single) prompt run. A refusal here surfaces as
      // a quota-kind error immediately — the harness has already marked the
      // token-paid attempt as tried, so it falls through to pause. Deliberately
      // OUTSIDE the prompt try/catch: an authenticate failure must not re-enter
      // the failover/downgrade recovery ladder.
      if (tokenPaid) {
        try {
          await ctx.request(methods.agent.authenticate, { methodId: tokenPaid.methodId });
          log.debug(`acp: token-paid auth ok (method '${tokenPaid.methodId}', env '${tokenPaid.envVarName}')`);
        } catch (authErr) {
          throw new AgentCallError("quota", `token-paid authenticate failed: ${(authErr as Error).message}`, {
            cause: authErr,
            authMethods: envVarAuthMethods,
            providerId: providerInEffect,
          });
        }
      }

      // Pre-emptive seam (ADR-021): configure the session model from the
      // harness-decided tier/selection BEFORE the first prompt, so the whole
      // turn runs on the variant. A rejected config must never halt the step —
      // fall back to the agent default and keep the turn going.
      let configuredModel: string | undefined;
      if (opts.variantModel || opts.variantTier) {
        const candidate =
          opts.variantModel ??
          selectVariantModel(opts.variantTier!, advertised, opts.configuredProviders ?? [], MODELS_SNAPSHOT);
        if (candidate) {
          try {
            await setConfigOption(candidate);
            configuredModel = candidate;
            log.debug(`acp: session model '${candidate}' pre-configured (config '${configId}')`);
          } catch (err) {
            log.warn(`acp: pre-emptive model config rejected (${(err as Error).message}) — using agent default`);
          }
        }
      }

      // One prompt round-trip. Reused for the same-session downgrade retry
      // (ADR-022): the session stays open across both prompts.
      const runPromptOnce = async (): Promise<AcpStopReason> => {
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
        return stopReason;
      };

      try {
        return {
          stopReason: await runPromptOnce(),
          ...(configuredModel ? { configuredModel } : {}),
        };
      } catch (err) {
        const agentErr = classifyAgentError(err);
        if (agentErr.kind !== "quota") throw agentErr;

        // The quota error surfaced to the harness must carry the env-var auth
        // methods (ADR-021 Phase F) and the provider currently in effect, so it
        // can decide whether a token-paid retry is possible and which
        // `tokenPaidApiKey` to use.
        const enriched = (e: AgentCallError, providerId?: string): AgentCallError =>
          new AgentCallError(e.kind, e.message, {
            providerCode: e.providerCode,
            resetAtMs: e.resetAtMs,
            cause: e,
            authMethods: envVarAuthMethods,
            providerId,
          });

        // ADR-021 Phase F (token-paid retry): the prompt was already run once
        // with the key injected + `authenticate` done. Run ONCE, no recovery —
        // a second quota surfaces immediately so the harness (token-paid already
        // tried) pauses. Never infinite: the harness caps this to one attempt.
        if (tokenPaid) {
          throw enriched(agentErr, providerInEffect);
        }

        // ADR-021 provider failover (UNSTABLE ACP `providers/*`). Runs BEFORE
        // the same-session `downgradeTo` retry: switching the provider keeps
        // the session on a stronger tier than a tier downgrade would. A
        // failover re-runs the prompt on the new provider (step loop re-enters
        // without a retry slot); an aborted/absent failover falls through to
        // the downgrade path so the quota ladder is never blocked.
        if (opts.onProviderQuota && providerRouting) {
          const router: ProviderRouter = {
            listProviders: async () => {
              const res = await ctx.request(methods.agent.providers.list, {});
              return (res?.providers ?? []).map<AcpProviderInfo>(p => ({
                providerId: p.providerId,
                supported: p.supported ?? [],
                required: Boolean(p.required),
                ...(p.current ? { current: { apiType: p.current.apiType, baseUrl: p.current.baseUrl } } : {}),
              }));
            },
            setProvider: async (config: AcpProviderConfig) => {
              await ctx.request(methods.agent.providers.set, config);
            },
          };
          let failover: ProviderFailoverResult | undefined;
          try {
            failover = await opts.onProviderQuota(router, {
              advertised,
              ...(opts.variantTier ? { tier: opts.variantTier } : {}),
              ...(opts.variantModel ? { variantModel: opts.variantModel } : {}),
              ...(opts.providerConfig ? { providers: opts.providerConfig } : {}),
            });
          } catch (cbErr) {
            log.warn(`acp: provider-failover seam threw (${(cbErr as Error).message}) — using downgrade path`);
          }
          if (failover) {
            if (failover.model) {
              try {
                await setConfigOption(failover.model);
                configuredModel = failover.model;
              } catch (cfgErr) {
                // Model absent on the new provider: keep the session on the
                // provider and let the agent pick a default (never block the
                // failover because of one config option).
                log.warn(
                  `acp: failover model '${failover.model}' rejected on provider '${failover.providerId}' — using agent default`,
                );
              }
            }
            // The retry prompt is deliberately OUTSIDE the seam's try/catch: a
            // seam throw must not swallow the retry's own outcome. If the
            // retry itself hits quota, surface it enriched with the provider
            // now in effect (so the harness picks the right `tokenPaidApiKey`)
            // rather than rethrowing the stale first error un-enriched.
            providerInEffect = failover.providerId;
            try {
              const stopReason = await runPromptOnce();
              return { stopReason, providerFailover: failover.providerId, ...(configuredModel ? { configuredModel } : {}) };
            } catch (retryErr) {
              throw enriched(classifyAgentError(retryErr), providerInEffect);
            }
          }
        }

        if (downgradeTo) {
          try {
            await setConfigOption(downgradeTo);
          } catch {
            // Config switch refused: the downgrade cannot happen. Surface the
            // ORIGINAL quota error (its reset window is what the harness must
            // act on), not the config-option rejection.
            throw enriched(agentErr, providerInEffect);
          }
          try {
            const stopReason = await runPromptOnce();
            return { stopReason, downgraded: true };
          } catch (retryErr) {
            // A quota on the downgraded model surfaces enriched (authMethods +
            // providerId in effect) so the harness can still attempt a
            // token-paid retry; never swallow it.
            throw enriched(classifyAgentError(retryErr), providerInEffect);
          }
        }
        throw enriched(agentErr, providerInEffect);
      }
    });
  });

  let settled: {
    stopReason: AcpStopReason;
    downgraded?: boolean;
    configuredModel?: string;
    providerFailover?: string;
  } | null = null;
  try {
    settled = await Promise.race([turn, spawnFailed.promise.then(err => Promise.reject(err))]);
  } catch (err) {
    if (cancelled) {
      return {
        stopReason: "cancelled",
        content: content.join(""),
        usage: finalUsage,
        duration: Date.now() - start,
        error: classifyAgentError(err),
      };
    }
    // With cross-spawn a missing command is launched through cmd.exe, which
    // exits before any ACP handshake; the connection-close error and the
    // converted ENOENT error land in the same event-loop turn. Prefer the
    // actionable spawn error when it surfaces within one setImmediate tick.
    // cross-spawn launches a missing command through cmd.exe, which exits
    // before any ACP handshake. The SDK rejects with a generic "connection
    // closed" at the same time cross-spawn converts the failure into an
    // `error` event (~1ms later). Prefer the actionable spawn error, but only
    // while no handshake has completed: a mid-turn connection close must
    // surface immediately without paying the grace window.
    if (!handshakeDone) {
      const spawnErr = await Promise.race([
        spawnFailed.promise,
        new Promise<null>(resolve => setTimeout(() => resolve(null), 50)),
      ]);
      if (spawnErr) throw classifyAgentError(spawnErr);
    }
    throw classifyAgentError(err);
  } finally {
    scheduleKill(child);
    signal?.removeEventListener("abort", onAbort);
  }

  return {
    stopReason: settled!.stopReason,
    content: content.join(""),
    usage: finalUsage,
    duration: Date.now() - start,
    ...(settled!.downgraded ? { downgraded: true } : {}),
    ...(settled!.configuredModel ? { configuredModel: settled!.configuredModel } : {}),
    ...(settled!.providerFailover ? { providerFailover: settled!.providerFailover } : {}),
  };
}