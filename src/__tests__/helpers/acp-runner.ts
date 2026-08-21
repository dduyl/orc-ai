import type { IPty } from "node-pty";
import { runAcpTurn } from "../../application/agents/acp/client.js";
import { gateFromEnv } from "../../application/agents/acp/permission.js";
import type { OnProviderQuota, TokenPaidRequest } from "../../application/agents/acp/types.js";
import type { AdapterDef } from "../../application/agents/adapter.js";
import type { Tier } from "../../application/agents/config.js";
import { spawnAcpSpec } from "./acp-mock-server.js";

/**
 * Mutable per-test state shared with the mocked `callAgentStream`. The test
 * fills `env` with the mock-server knobs before each run; the runner records
 * what the harness actually threaded through (tier/variant model).
 */
export interface MockAcpState {
  env: Record<string, string>;
  records: {
    calls: number;
    variantTiers: (Tier | undefined)[];
    variantModels: (string | undefined)[];
  };
}

export function mockAcpStream(
  state: MockAcpState,
  adapter: AdapterDef,
  _prompt: string,
  downgradeTo?: string,
  variantTier?: Tier,
  variantModel?: string,
  _configuredProviders?: string[],
  onProviderQuota?: OnProviderQuota,
  tokenPaid?: TokenPaidRequest,
): { pty: IPty; promise: Promise<unknown> } {
  state.records.calls++;
  state.records.variantTiers.push(variantTier);
  state.records.variantModels.push(variantModel);

  const controller = new AbortController();
  const promise = runAcpTurn({
    spawn: spawnAcpSpec(),
    cwd: process.cwd(),
    env: { ...process.env, ...state.env } as Record<string, string>,
    prompt: _prompt,
    permissionGate: gateFromEnv(),
    signal: controller.signal,
    ...(downgradeTo ? { downgradeTo } : {}),
    ...(variantTier ? { variantTier } : {}),
    ...(variantModel ? { variantModel } : {}),
    ...(onProviderQuota ? { onProviderQuota } : {}),
    ...(tokenPaid ? { tokenPaid } : {}),
    events: {
      onText: () => {},
      onToolCall: () => {},
      onToolCallUpdate: () => {},
      onUsage: () => {},
    },
  })
    .then(turn => ({
      content: turn.content,
      model: adapter.id,
      tokensUsed: turn.usage.totalTokens,
      duration: turn.duration,
      ...(turn.downgraded && downgradeTo ? { downgradedTo: downgradeTo } : {}),
      ...(turn.providerFailover ? { providerFailover: turn.providerFailover } : {}),
    }))
    .catch((err: unknown) => {
      throw err;
    });

  const pty = {
    onData: () => {},
    onExit: () => {},
    write: () => {},
    resize: () => {},
    clear: () => {},
    pause: () => {},
    resume: () => {},
    kill: () => controller.abort(),
    pid: -1,
    cols: 120,
    rows: 40,
    process: "mock-acp",
    handleFlowControl: false,
  } as unknown as IPty;

  return { pty, promise };
}