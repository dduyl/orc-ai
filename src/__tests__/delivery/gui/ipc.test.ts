import { describe, expect, it } from "vitest";
import { IPC } from "../../../delivery/gui/ipc.js";

describe("IPC contract (gui)", () => {
  it("channel names are unique across all three groups", () => {
    const names = [
      ...Object.values(IPC.RendererToMain),
      ...Object.values(IPC.RendererToMainInvoke),
      ...Object.values(IPC.MainToRenderer),
    ];
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });

  it("exposes the full main → renderer event surface", () => {
    // The `IPC` const is `satisfies`-checked against the typed channel maps at
    // compile time; this guards the runtime strings against accidental renames.
    expect(IPC.MainToRenderer.output).toBe("output");
    expect(IPC.MainToRenderer.status).toBe("status");
    expect(IPC.MainToRenderer["chat-frame"]).toBe("chat-frame");
    expect(IPC.MainToRenderer["chat-reset"]).toBe("chat-reset");
    expect(IPC.MainToRenderer["stream-event"]).toBe("stream-event");
  });
});