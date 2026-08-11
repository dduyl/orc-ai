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
  it("safe-holds: request stays pending until answered", async () => {
    const gate = new PermissionGate();
    const req: any = {
      sessionId: "s1",
      toolCall: { callId: "c1", callType: "function", function: { name: "bash" } },
      options: [option("allow-once", "allow_once")],
    };
    const p = gate.handle(req);
    let resolved = false;
    void p.then(() => (resolved = true));
    await new Promise(r => setTimeout(r, 20));
    expect(resolved).toBe(false);
    expect(gate.active).toBe(true);
    gate.cancel();
    expect((await p).outcome).toEqual({ outcome: "cancelled" });
  });

  it("answers a pending request with the selected option", async () => {
    const gate = new PermissionGate();
    const req: any = {
      sessionId: "s1",
      toolCall: { callId: "c1", callType: "function", function: { name: "bash" } },
      options: [option("allow-once", "allow_once")],
    };
    const p = gate.handle(req);
    const response = gate.answer("allow_once");
    expect(response).not.toBeNull();
    expect(response!.outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
    expect((await p).outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
  });

  it("rejects with cancelled when no option matches the answer kind", async () => {
    const gate = new PermissionGate();
    const req: any = {
      sessionId: "s1",
      toolCall: { callId: "c1", callType: "function", function: { name: "bash" } },
      options: [option("reject-always", "reject_always")],
    };
    const p = gate.handle(req);
    const response = gate.answer("allow_always");
    expect(response!.outcome).toEqual({ outcome: "cancelled" });
    expect((await p).outcome).toEqual({ outcome: "cancelled" });
  });

  it("resolves a stale pending request with cancelled before replacing it", async () => {
    const gate = new PermissionGate();
    const first: any = {
      sessionId: "s1",
      toolCall: { callId: "c1", callType: "function", function: { name: "bash" } },
      options: [option("allow-once", "allow_once")],
    };
    const second: any = { ...first, toolCall: { ...first.toolCall, callId: "c2" } };
    const p1 = gate.handle(first);
    const p2 = gate.handle(second);
    expect((await p1).outcome).toEqual({ outcome: "cancelled" });
    expect(gate.active).toBe(true);
    gate.cancel();
    expect((await p2).outcome).toEqual({ outcome: "cancelled" });
  });

  it("notifies a handler with the request details", async () => {
    const onPermission = vi.fn();
    const gate = new PermissionGate({ onPermission });
    const req: any = {
      sessionId: "s1",
      toolCall: { callId: "c1", callType: "function", function: { name: "bash" } },
      options: [option("allow-once", "allow_once")],
    };
    const p = gate.handle(req);
    expect(onPermission).toHaveBeenCalledWith({
      toolCall: req.toolCall,
      options: req.options,
    });
    gate.answer("allow_once");
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
