import { describe, it, expect, vi, afterEach } from "vitest";
import {
  PermissionGate,
  autoPermissionMode,
  gateFromEnv,
  pickOption,
  ACP_PERMISSION_ENV,
} from "../../../../application/agents/acp/permission.js";
import type { PermissionAnswerKind } from "../../../../application/agents/acp/types.js";

const origEnv = { ...process.env };

afterEach(() => {
  process.env = { ...origEnv };
});

function option(optionId: string, kind: PermissionAnswerKind) {
  return { optionId, name: optionId, kind };
}

describe("pickOption", () => {
  it("matches the exact kind", () => {
    const options = [option("allow-once", "allow_once"), option("allow-always", "allow_always")];
    expect(pickOption(options, "allow_always")?.optionId).toBe("allow-always");
  });

  it("falls back from *_always to *_once by kind", () => {
    const options = [option("allow-once", "allow_once")];
    expect(pickOption(options, "allow_always")?.optionId).toBe("allow-once");
  });

  it("never falls back across allow/reject kinds", () => {
    const options = [option("reject-once", "reject_once")];
    expect(pickOption(options, "allow_always")).toBeUndefined();
  });
});

describe("PermissionGate", () => {
  function req(
    callId: string,
    options = [option("allow-once", "allow_once"), option("reject-once", "reject_once")],
  ): any {
    return {
      sessionId: "s1",
      toolCall: { callId, callType: "function", function: { name: "bash" } },
      options,
    };
  }

  it("safe-holds: request stays pending until answered", async () => {
    const gate = new PermissionGate();
    const p = gate.handle(req("c1"));
    let resolved = false;
    void p.then(() => (resolved = true));
    await new Promise(r => setTimeout(r, 20));
    expect(resolved).toBe(false);
    expect(gate.active).toBe(true);
    expect(gate.pendingCount).toBe(1);
    gate.cancel();
    expect((await p).outcome).toEqual({ outcome: "cancelled" });
    expect(gate.active).toBe(false);
  });

  it("answers the exact request the resolver was asked about", async () => {
    const ids: string[] = [];
    const gate = new PermissionGate({ onPermission: (r) => ids.push(r.requestId) });
    const p = gate.handle(req("c1"));
    expect(ids).toHaveLength(1);
    const response = gate.answer(ids[0], "allow_once");
    expect(response).not.toBeNull();
    expect(response!.outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
    expect((await p).outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
  });

  it("rejects with cancelled when no option matches the answer kind", async () => {
    const ids: string[] = [];
    const gate = new PermissionGate({ onPermission: (r) => ids.push(r.requestId) });
    const p = gate.handle(req("c1", [option("reject-always", "reject_always")]));
    const response = gate.answer(ids[0], "allow_always");
    expect(response!.outcome).toEqual({ outcome: "cancelled" });
    expect((await p).outcome).toEqual({ outcome: "cancelled" });
  });

  it("keeps overlapping requests pending and answers each independently", async () => {
    const ids: string[] = [];
    const gate = new PermissionGate({ onPermission: (r) => ids.push(r.requestId) });
    const p1 = gate.handle(req("c1"));
    const p2 = gate.handle(req("c2"));
    expect(gate.pendingCount).toBe(2);
    // answering the second request must not disturb the first
    const r2 = gate.answer(ids[1], "reject_once");
    expect(r2!.outcome).toEqual({ outcome: "selected", optionId: "reject-once" });
    expect((await p2).outcome).toEqual({ outcome: "selected", optionId: "reject-once" });
    let p1Resolved = false;
    void p1.then(() => (p1Resolved = true));
    await new Promise(r => setTimeout(r, 20));
    expect(p1Resolved).toBe(false);
    expect(gate.active).toBe(true);
    gate.cancel();
    expect((await p1).outcome).toEqual({ outcome: "cancelled" });
  });

  it("is a no-op on stale answers and can never resolve a different request", async () => {
    const ids: string[] = [];
    const gate = new PermissionGate({ onPermission: (r) => ids.push(r.requestId) });
    const p1 = gate.handle(req("c1"));
    const p2 = gate.handle(req("c2"));
    expect(gate.answer(ids[0], "allow_once")).not.toBeNull();
    // a duplicate / late answer for the already-answered request is dropped
    expect(gate.answer(ids[0], "reject_once")).toBeNull();
    // an unknown requestId is dropped too
    expect(gate.answer("perm-9999", "reject_once")).toBeNull();
    // the other request is unaffected
    expect(gate.answer(ids[1], "reject_once")).not.toBeNull();
    expect((await p1).outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
    expect((await p2).outcome).toEqual({ outcome: "selected", optionId: "reject-once" });
  });

  it("settles a request as cancelled when the resolver handler throws", async () => {
    const gate = new PermissionGate({
      onPermission: () => {
        throw new Error("resolver crash");
      },
    });
    const p = gate.handle(req("c1"));
    expect((await p).outcome).toEqual({ outcome: "cancelled" });
    expect(gate.active).toBe(false);
  });

  it("notifies a handler with the request details and a correlation id", async () => {
    const onPermission = vi.fn();
    const gate = new PermissionGate({ onPermission });
    const p = gate.handle(req("c1"));
    expect(onPermission).toHaveBeenCalledWith({
      requestId: expect.any(String),
      toolCall: req("c1").toolCall,
      options: req("c1").options,
    });
    const seen = onPermission.mock.calls[0][0] as { requestId: string };
    gate.answer(seen.requestId, "allow_once");
    await p;
  });
});

describe("autoPermissionMode + gateFromEnv", () => {
  it("defaults to safe_hold", () => {
    delete process.env[ACP_PERMISSION_ENV];
    expect(autoPermissionMode()).toBe("safe_hold");
    expect(gateFromEnv().active).toBe(false);
  });

  it("reads allow_always", () => {
    process.env[ACP_PERMISSION_ENV] = "allow_always";
    expect(autoPermissionMode()).toBe("allow_always");
  });

  it("reads reject_always", () => {
    process.env[ACP_PERMISSION_ENV] = "reject_always";
    expect(autoPermissionMode()).toBe("reject_always");
  });

  it("auto-answers allow_always via gateFromEnv", async () => {
    process.env[ACP_PERMISSION_ENV] = "allow_always";
    const gate = gateFromEnv();
    const req: any = {
      sessionId: "s1",
      toolCall: { callId: "c1", callType: "function", function: { name: "bash" } },
      options: [option("allow-once", "allow_once")],
    };
    const p = gate.handle(req);
    expect((await p).outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
  });
});
