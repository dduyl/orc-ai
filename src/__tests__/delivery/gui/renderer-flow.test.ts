// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `terminal.ts` wraps xterm (needs a real canvas/DOM); renderer only needs the
 * `{ term, fit }` shape, so stub it.
 */
vi.mock("../../../delivery/gui/terminal.js", () => ({
  createTerminal: () => ({
    term: {
      write: vi.fn(),
      reset: vi.fn(),
      focus: vi.fn(),
      onData: vi.fn(),
      cols: 80,
      rows: 24,
    },
    fit: vi.fn(),
  }),
}));

/** Minimal index.html shape — every id the renderer's `getDomRefs()` requires. */
const DOM = `
<div id="app">
  <header id="titlebar">
    <div class="brand">ORC<span id="brand-adapter"></span></div>
    <button id="tab-chat">Chat</button>
    <button id="tab-terminal">Terminal</button>
    <span id="status-indicator"></span>
    <span id="status-text">Initializing.</span>
    <span id="sb-indicator"></span>
    <span id="sb-text">Initializing.</span>
  </header>
  <div id="main"><div id="content">
    <section id="chat-view">
      <div id="chat-scroll"><div id="chat-list"></div></div>
      <div id="chat-inputbar"><div id="chat-busy" hidden><span id="chat-busy-text">Agent is working.</span><button id="chat-cancel">Cancel</button></div></div>
      <div id="chat-promptrow"><input id="chat-input"><button id="chat-send">Send</button></div>
    </section>
    <section id="terminal-view">
      <div id="view-label"><span id="view-label-text">TERMINAL</span><span id="view-label-step"></span></div>
      <div id="terminal"></div>
    </section>
    <div id="splitter"></div>
    <aside id="right-panel">
      <span id="info-adapter">-</span><span id="info-status">Connecting</span>
      <span id="info-mode">-</span><span id="info-pid">-</span><span id="info-size">-</span>
      <div id="step-tree"></div><div id="pty-tree"></div><div id="event-list"></div>
    </aside>
  </div></div>
  <footer id="statusbar">
    <span id="term-size"></span><span id="exit-status"></span>
  </footer>
  <div id="permission-dialog" role="dialog" aria-modal="true" aria-labelledby="permission-text">
    <p id="permission-text">Allow tool?</p>
    <p id="permission-hint">The agent is waiting for your decision.</p>
    <div id="permission-actions"></div>
  </div>
</div>
`;

function createApiStub(): {
  api: Record<string, unknown>;
  handlers: Map<string, (data: unknown) => void>;
  calls: Record<string, unknown[][]>;
} {
  const handlers = new Map<string, (data: unknown) => void>();
  const calls: Record<string, unknown[][]> = {};
  const on =
    (key: string) =>
    (cb: (data: unknown) => void): void => {
      handlers.set(key, cb);
    };
  const api: Record<string, unknown> = {
    onData: on("data"),
    onExit: on("exit"),
    onStatus: on("status"),
    onLog: on("log"),
    onStepActivated: on("step"),
    onRunActive: on("runActive"),
    onPermissionRequested: on("permission"),
    onChatFrame: on("chatFrame"),
    onChatReset: on("chatReset"),
    write: (...a: unknown[]) => (calls.write ??= []).push(a),
    prompt: vi.fn(async () => {}),
    cancelMain: (...a: unknown[]) => (calls.cancelMain ??= []).push(a),
    answerPermission: (...a: unknown[]) => (calls.answerPermission ??= []).push(a),
    switchStep: vi.fn(async () => {}),
    listSteps: vi.fn(async () => []),
    getStepOutput: vi.fn(async () => "buffer"),
    start: vi.fn(async () => ({ runId: "r1" })),
    getRunStatus: vi.fn(async () => null),
    listRuns: vi.fn(async () => []),
  };
  return { api, handlers, calls };
}

type Stub = ReturnType<typeof createApiStub>;
type Frame = RobotFrame;

/** Structural subset matching `MainFrame | { kind: "user" }`. */
type RobotFrame =
  | { kind: "text"; text: string }
  | { kind: "tool"; call: { toolCallId: string; title?: string; name?: string } }
  | { kind: "tool_update"; update: { toolCallId: string; title?: string; name?: string; status?: string } }
  | { kind: "usage"; usage: { totalTokens: number; inputTokens: number; outputTokens: number } }
  | { kind: "turn"; stopReason: string }
  | { kind: "error"; message: string }
  | { kind: "user"; text: string };

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

describe("renderer flow", () => {
  let stub: Stub;

  async function loadRenderer(): Promise<void> {
    vi.resetModules();
    document.body.innerHTML = DOM;
    stub = createApiStub();
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = stub.api;
    await import("../../../delivery/gui/renderer.js");
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function fire(key: string, data: unknown): void {
    const cb = stub.handlers.get(key);
    if (!cb) throw new Error(`no handler for ${key}`);
    cb(data);
  }

  it("spawns the ACP main: composer enabled, mode surfaced, chat reset", async () => {
    await loadRenderer();
    fire("status", { type: "spawned", pid: 42, adapter: "opencode", mode: "acp" });
    expect(el("chat-send").getAttribute("disabled")).toBeNull();
    expect(el("brand-adapter").textContent).toContain("opencode");
    expect(el("info-mode").textContent).toBe("acp");

    fire("chatReset", {});
    expect(el("chat-list").querySelector(".chat-empty")).not.toBeNull();
  });

  it("routes chat frames into the panel and hugs the composer", async () => {
    await loadRenderer();
    fire("status", { type: "spawned", pid: 1, adapter: "opencode", mode: "acp" });

    fire("chatFrame", { frame: { kind: "text", text: "one " } });
    fire("chatFrame", { frame: { kind: "text", text: "two" } });
    expect(el("chat-list").querySelectorAll(".msg-agent").length).toBe(1);
    expect(el("chat-list").querySelector(".msg-agent")?.textContent).toContain("one two");

    fire("chatFrame", {
      frame: { kind: "tool", call: { toolCallId: "t1", title: "grep", name: "grep" } },
    });
    expect(el("chat-list").querySelector(".msg-tool")).not.toBeNull();

    fire("chatFrame", {
      frame: { kind: "tool_update", update: { toolCallId: "t1", title: "grep", status: "completed" } },
    });
    expect(el("chat-list").querySelector(".msg-tool")?.classList.contains("done")).toBe(true);

    fire("chatFrame", { frame: { kind: "usage", usage: { totalTokens: 9, inputTokens: 4, outputTokens: 5 } } });
    expect(el("chat-list").querySelector(".msg-usage")?.textContent).toContain("9");

    fire("chatFrame", { frame: { kind: "user", text: "hi" } });
    expect(el("chat-list").querySelector(".msg-user")?.textContent).toBe("hi");

    fire("chatFrame", { frame: { kind: "error", message: "kaput" } });
    expect(el("chat-list").querySelector(".msg-error")?.textContent).toContain("kaput");

    fire("chatFrame", { frame: { kind: "turn", stopReason: "end_turn" } });
    expect(el("chat-list").querySelector(".turn-end")).not.toBeNull();
  });

  it("submit sends the trimmed prompt and blocks input until a turn frame", async () => {
    await loadRenderer();
    fire("status", { type: "spawned", pid: 1, adapter: "opencode", mode: "acp" });

    const input = el("chat-input") as HTMLInputElement;
    input.value = "  next step  ";
    (el("chat-send") as HTMLButtonElement).click();

    expect(stub.api.prompt).toHaveBeenCalledWith("next step");
    expect(el("chat-list").querySelector(".msg-user")?.textContent).toBe("next step");
    expect(el("chat-send").getAttribute("disabled")).not.toBeNull();

    fire("chatFrame", { frame: { kind: "turn", stopReason: "end_turn" } });
    expect(el("chat-send").getAttribute("disabled")).toBeNull();
  });

  it("queues permission requests and routes answers by requestId", async () => {
    await loadRenderer();
    fire("status", { type: "spawned", pid: 1, adapter: "opencode", mode: "acp" });

    const request = (requestId: string): unknown => ({
      requestId,
      toolCall: { toolCallId: "t1", title: "Run tests", name: "bash" },
      options: [
        { optionId: "allow", kind: "allow_once", name: "Allow once" },
        { optionId: "reject", kind: "reject_once", name: "Reject" },
      ],
    });

    fire("permission", request("req-1"));
    fire("permission", request("req-2"));

    expect(el("permission-dialog").classList.contains("visible")).toBe(true);
    expect(el("permission-text").textContent).toContain("Run tests");
    expect(el("permission-actions").querySelectorAll("button").length).toBe(2);

    const allowBtn = el("permission-actions").querySelector("button") as HTMLButtonElement;
    allowBtn.click();
    expect(stub.calls.answerPermission[0]).toEqual(["req-1", "allow_once"]);

    expect(el("permission-dialog").classList.contains("visible")).toBe(true);
    expect(el("permission-actions").querySelectorAll("button").length).toBe(2);
  });
});