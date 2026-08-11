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
 * One permission decision per tool call.
 *
 * A stale request (already answered) is resolved with `cancelled` so the agent
 * never hangs on an orphaned request, and a follow-up request can never
 * double-resolve a prior pending promise.
 */
class PendingPermission {
  constructor(
    readonly params: RequestPermissionRequest,
    readonly resolve: (value: RequestPermissionResponse) => void,
  ) {}
}

/**
 * Blocks `session/request_permission` until answered.
 *
 * With no handler attached this is a SAFE-HOLD: the request is never answered,
 * so the agent's tool call simply never completes and the turn stays alive but
 * inert — nothing is auto-allowed and nothing is auto-rejected.
 *
 * Phase 1 dev E2E sets `ORC_ACP_PERMISSION=allow_always` to auto-answer every
 * request; an interactive resolver (GUI prompt) lands in a later phase and is
 * wired through {@link PermissionGate.handler} / {@link PermissionGate.answer}.
 */
export class PermissionGate {
  private pending: PendingPermission | null = null;
  private handler: PermissionHandler | undefined;

  constructor(handler?: PermissionHandler) {
    this.handler = handler;
  }

  get active(): boolean {
    return this.pending !== null;
  }

  setHandler(handler: PermissionHandler | undefined): void {
    this.handler = handler;
  }

  /** Handle an inbound permission request. Resolves once answered (or holds). */
  handle(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return new Promise<RequestPermissionResponse>(resolve => {
      // A stale pending request can only be replaced after being settled.
      if (this.pending) {
        this.pending.resolve({ outcome: { outcome: "cancelled" } });
        this.pending = null;
      }
      const request = new PendingPermission(params, resolve);
      this.pending = request;
      this.handler?.onPermission({
        toolCall: params.toolCall,
        options: params.options,
      });
    });
  }

  /**
   * Answer the pending request by kind, picking the best matching option.
   * Returns the response that was sent, or `null` if no request is pending
   * or no useful option exists (the agent sees it as cancelled either way).
   */
  answer(kind: PermissionAnswerKind): RequestPermissionResponse | null {
    if (!this.pending) return null;
    const { params, resolve } = this.pending;
    this.pending = null;
    const option = pickOption(params.options, kind);
    const response: RequestPermissionResponse = option
      ? { outcome: { outcome: "selected", optionId: option.optionId } }
      : { outcome: { outcome: "cancelled" } };
    if (!option) {
      log.warn(`acp: no permission option matched '${kind}' — answering cancelled`);
    }
    resolve(response);
    return response;
  }

  /** Cancel the pending request (used on connection teardown). */
  cancel(): void {
    if (!this.pending) return;
    const { resolve } = this.pending;
    this.pending = null;
    resolve({ outcome: { outcome: "cancelled" } });
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
    onPermission: () => {
      void gate.answer(kind);
    },
  });
  return gate;
}