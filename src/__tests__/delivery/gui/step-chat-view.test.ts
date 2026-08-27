// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { StepChatView } from "../../../delivery/gui/step-chat-view.js";
import type { StepFrame } from "../../../delivery/gui/ipc.js";

/** Create a bare list element inside a scrollable parent for scrollBottom(). */
function makeList(): HTMLElement {
  const list = document.createElement("div");
  const scroll = document.createElement("div");
  scroll.style.height = "100px";
  scroll.style.overflow = "auto";
  scroll.appendChild(list);
  document.body.appendChild(scroll);
  return list;
}

function text(el: Element | null, sel: string): string | null {
  return el?.querySelector(sel)?.textContent ?? null;
}

describe("StepChatView", () => {
  it("clear() empties the list", () => {
    const list = makeList();
    const view = new StepChatView(list);
    view.addText("hello");
    expect(list.children.length).toBeGreaterThan(0);
    view.clear();
    expect(list.innerHTML).toBe("");
  });

  it("addToolCall renders tool name and input", () => {
    const list = makeList();
    const view = new StepChatView(list);
    view.addToolCall({
      toolCallId: "tc1",
      title: "bash",
      name: "bash",
      rawInput: { command: "ls -la" },
    });
    const entry = list.querySelector(".tool-entry");
    expect(entry).not.toBeNull();
    expect(text(entry, ".tool-name")).toBe("⚙ bash");
    expect(text(entry, ".tool-input")).toBe(JSON.stringify({ command: "ls -la" }));
  });

  it("addToolCall handles string rawInput", () => {
    const list = makeList();
    const view = new StepChatView(list);
    view.addToolCall({
      toolCallId: "tc1",
      title: "read",
      name: "read",
      rawInput: "file content",
    });
    expect(text(list, ".tool-input")).toBe("file content");
  });

  it("addToolCall handles missing name", () => {
    const list = makeList();
    const view = new StepChatView(list);
    view.addToolCall({
      toolCallId: "tc1",
      title: "unknown",
      rawInput: {},
    });
    expect(text(list, ".tool-name")).toBe("⚙ unknown");
  });

  it("addToolUpdate renders completed status", () => {
    const list = makeList();
    const view = new StepChatView(list);
    view.addToolUpdate({
      toolCallId: "tc1",
      status: "completed",
      rawOutput: "done",
    });
    const status = list.querySelector(".tool-status") as HTMLElement;
    expect(status.textContent).toBe("✓ completed");
    // jsdom normalizes hex to rgb
    expect(status.style.color).toMatch(/#4ade80|rgb\(74, 222, 128\)/);
  });

  it("addToolUpdate renders in_progress status", () => {
    const list = makeList();
    const view = new StepChatView(list);
    view.addToolUpdate({
      toolCallId: "tc2",
      status: "in_progress",
    });
    const status = list.querySelector(".tool-status") as HTMLElement;
    expect(status.textContent).toBe("⏳ running");
    expect(status.style.color).toMatch(/#facc15|rgb\(250, 204, 21\)/);
  });

  it("addToolUpdate renders failed status", () => {
    const list = makeList();
    const view = new StepChatView(list);
    view.addToolUpdate({
      toolCallId: "tc3",
      status: "failed",
    });
    const status = list.querySelector(".tool-status") as HTMLElement;
    expect(status.textContent).toBe("✗ failed");
    expect(status.style.color).toMatch(/#f87171|rgb\(248, 113, 113\)/);
  });

  it("addToolUpdate skips when no toolCallId", () => {
    const list = makeList();
    const view = new StepChatView(list);
    view.addToolUpdate({ toolCallId: "", status: "completed" });
    expect(list.querySelectorAll(".tool-entry")).toHaveLength(0);
  });

  it("addToolUpdate truncates long rawOutput to 200 chars", () => {
    const list = makeList();
    const view = new StepChatView(list);
    const longOutput = "x".repeat(300);
    view.addToolUpdate({
      toolCallId: "tc1",
      status: "completed",
      rawOutput: longOutput,
    });
    const output = text(list, ".tool-output");
    expect(output).not.toBeNull();
    expect(output!.length).toBeLessThanOrEqual(200);
  });

  it("addText renders text in msg-agent div", () => {
    const list = makeList();
    const view = new StepChatView(list);
    view.addText("hello world");
    const msg = list.querySelector(".msg.msg-agent");
    expect(msg).not.toBeNull();
    expect(msg!.textContent).toBe("hello world");
  });

  it("addUsage renders token summary", () => {
    const list = makeList();
    const view = new StepChatView(list);
    view.addUsage({ totalTokens: 150, inputTokens: 80, outputTokens: 70 });
    expect(text(list, ".msg-usage")).toBe("tokens 150 · in 80 · out 70");
  });

  it("addTurn renders stop reason", () => {
    const list = makeList();
    const view = new StepChatView(list);
    view.addTurn("end_turn");
    const turnEnd = list.querySelector(".turn-end");
    expect(turnEnd).not.toBeNull();
    const label = turnEnd!.querySelector("b");
    expect(label).not.toBeNull();
    expect(label!.textContent).toBe("end_turn");
  });

  it("addError renders error message", () => {
    const list = makeList();
    const view = new StepChatView(list);
    view.addError("something broke");
    const err = list.querySelector(".msg.msg-error");
    expect(err).not.toBeNull();
    expect(err!.textContent).toBe("error · something broke");
  });

  it("addErrorFrame renders quota error with reset countdown", () => {
    const list = makeList();
    const view = new StepChatView(list);
    const frame: StepFrame = {
      stepId: "s1",
      runId: "r1",
      status: "failed",
      error: "quota exceeded",
      errorKind: "quota",
      resetAtMs: Date.now() + 30000,
    };
    view.addErrorFrame(frame);
    expect(text(list, ".error-kind")).toBe("QUOTA");
    const detail = text(list, ".error-detail");
    expect(detail).not.toBeNull();
    expect(detail).toMatch(/Resets in \d+s/);
  });

  it("addErrorFrame renders rate_limit error with retry-after", () => {
    const list = makeList();
    const view = new StepChatView(list);
    const frame: StepFrame = {
      stepId: "s1",
      runId: "r1",
      status: "failed",
      error: "rate limited",
      errorKind: "rate_limit",
      retryAfterMs: 5000,
    };
    view.addErrorFrame(frame);
    expect(text(list, ".error-kind")).toBe("RATE_LIMIT");
    const detail = text(list, ".error-detail");
    expect(detail).not.toBeNull();
    expect(detail).toMatch(/Retry after \d+s/);
  });

  it("addErrorFrame renders auth error (no detail line)", () => {
    const list = makeList();
    const view = new StepChatView(list);
    const frame: StepFrame = {
      stepId: "s1",
      runId: "r1",
      status: "failed",
      error: "invalid key",
      errorKind: "auth",
    };
    view.addErrorFrame(frame);
    expect(text(list, ".error-kind")).toBe("AUTH");
    expect(list.querySelector(".error-detail")).toBeNull();
  });

  it("addErrorFrame renders providerCode when present", () => {
    const list = makeList();
    const view = new StepChatView(list);
    const frame: StepFrame = {
      stepId: "s1",
      runId: "r1",
      status: "failed",
      error: "fail",
      providerCode: "overloaded",
    };
    view.addErrorFrame(frame);
    const detail = text(list, ".error-detail");
    expect(detail).toBe("Provider code: overloaded");
  });

  it("addErrorFrame renders plain error as unknown kind", () => {
    const list = makeList();
    const view = new StepChatView(list);
    const frame: StepFrame = {
      stepId: "s1",
      runId: "r1",
      status: "failed",
      error: "oops",
    };
    view.addErrorFrame(frame);
    expect(text(list, ".error-kind")).toBe("UNKNOWN");
  });
});
