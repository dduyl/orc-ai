import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { AutoPermissionMode, PermissionAnswerKind } from "./types.js";
import { log } from "../../../core/log.js";

export const ACP_PERMISSION_ENV = "ORC_ACP_PERMISSION";

/** What the agent wants to run. Exposed to any attached resolver (Phase 2: GUI). */
export interface PermissionRequest {
  /**
   * Correlation id for this request. The resolver MUST echo it back through
   * {@link PermissionGate.answer} so a decision lands on the exact request the
   * user saw — never on whatever request happens to be pending at the time.
   */
  requestId: string;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
}

/** Attachable decision-maker. Phase 1 ships no resolver — see safe-hold below. */
export interface PermissionHandler {
  onPermission(request: PermissionRequest): void;
}

/** Pick an option by kind, falling back to the closest matching option. */
export function pickOption(
  options: PermissionOption[],
  kind: PermissionAnswerKind,
): PermissionOption | undefined {
  const exact = options.find(o => o.kind === kind);
  if (exact) return exact;
  if (kind === "allow_always" || kind === "reject_always") {
    const want = kind === "allow_always" ? "allow_once" : "reject_once";
    return options.find(o => o.kind === want);
  }
  return undefined;
}

/**
 * One permission decision per tool call, keyed by its correlation id.
 *
 * A stale answer (unknown requestId) is a no-op so a late/duplicate decision can
 * never resolve a newer request it was not meant for.
 */
class PendingPermission {
  constructor(
    readonly requestId: string,
    readonly params: RequestPermissionRequest,
    readonly resolve: (value: RequestPermissionResponse) => void,
  ) {}
}

/**
 * Blocks `session/request_permission` until answered.
 *
 * With no handler attached this is a SAFE-HOLD: requests are never answered, so
 * the agent's tool calls simply never complete and the turn stays alive but
 * inert — nothing is auto-allowed and nothing is auto-rejected.
 *
 * Multiple requests may be pending at once (parallel tool calls): each keeps
 * its own {@link PermissionRequest.requestId} and is resolved independently,
 * so an overlapping request never silently steals another's decision.
 *
 * Phase 1 dev E2E sets `ORC_ACP_PERMISSION=allow_always` to auto-answer every
 * request; an interactive resolver (GUI prompt) lands in a later phase and is
 * wired through {@link PermissionGate.handler} / {@link PermissionGate.answer}.
 */
export class PermissionGate {
  private readonly pending = new Map<string, PendingPermission>();
  private seq = 0;
  private handler: PermissionHandler | undefined;

  constructor(handler?: PermissionHandler) {
    this.handler = handler;
  }

  get active(): boolean {
    return this.pending.size > 0;
  }

  /** Number of requests awaiting a decision (parallel tool calls can pile up). */
  get pendingCount(): number {
    return this.pending.size;
  }

  setHandler(handler: PermissionHandler | undefined): void {
    this.handler = handler;
  }

  /** Handle an inbound permission request. Resolves once answered (or holds). */
  handle(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return new Promise<RequestPermissionResponse>(resolve => {
      const requestId = `perm-${++this.seq}`;
      this.pending.set(requestId, new PendingPermission(requestId, params, resolve));
      try {
        this.handler?.onPermission({
          requestId,
          toolCall: params.toolCall,
          options: params.options,
        });
      } catch (err) {
        // A broken resolver must not hang the agent: settle as cancelled.
        this.pending.delete(requestId);
        resolve({ outcome: { outcome: "cancelled" } });
        log.warn(`acp: permission handler threw for ${requestId}: ${err}`);
      }
    });
  }

  /**
   * Answer the pending request identified by `requestId`, picking the best
   * matching option. Returns the response that was sent, or `null` when the
   * requestId is unknown — i.e. the request was already answered or never
   * existed (stale-answer guard).
   */
  answer(requestId: string, kind: PermissionAnswerKind): RequestPermissionResponse | null {
    const pending = this.pending.get(requestId);
    if (!pending) return null;
    this.pending.delete(requestId);
    const option = pickOption(pending.params.options, kind);
    const response: RequestPermissionResponse = option
      ? { outcome: { outcome: "selected", optionId: option.optionId } }
      : { outcome: { outcome: "cancelled" } };
    if (!option) {
      log.warn(`acp: no permission option matched '${kind}' for ${requestId} — answering cancelled`);
    }
    pending.resolve(response);
    return response;
  }

  /** Cancel every pending request (used on connection teardown). */
  cancel(): void {
    for (const pending of this.pending.values()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pending.clear();
  }
}

/** Read the operator-configured auto-permission mode. */
export function autoPermissionMode(): AutoPermissionMode {
  const value = process.env[ACP_PERMISSION_ENV];
  if (value === "allow_always") return "allow_always";
  if (value === "reject_always") return "reject_always";
  return "safe_hold";
}

/**
 * Build the gate for a turn based on `ORC_ACP_PERMISSION`.
 *
 * `safe_hold` (default) returns a gate with no handler — the turn blocks on the
 * first permission request until an interactive resolver is attached (Phase 2).
 * `allow_always`/`reject_always` auto-answer with the matching option kind.
 */
export function gateFromEnv(): PermissionGate {
  const mode = autoPermissionMode();
  if (mode === "safe_hold") {
    log.info(
      "acp: permission gate = safe_hold (set ORC_ACP_PERMISSION=allow_always for unattended runs)",
    );
    return new PermissionGate();
  }
  const kind: PermissionAnswerKind =
    mode === "reject_always" ? "reject_always" : "allow_always";
  log.info(`acp: permission gate = ${mode} via ${ACP_PERMISSION_ENV}`);
  let gate: PermissionGate;
  gate = new PermissionGate({
    onPermission: (request) => {
      void gate.answer(request.requestId, kind);
    },
  });
  return gate;
}