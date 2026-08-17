// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GUIDE_TEXT } from "../../../adapters/mcp/handlers/content.js";

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
      <div id="chat-suggestions"></div>
      <div id="chat-promptrow"><span id="chat-mode" class="chat-mode">normal</span><span id="chat-model" hidden></span><input id="chat-input"><button id="chat-send">Send</button><div id="chat-model-menu"></div></div>
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
  <div id="activity-box" hidden>
    <div id="activity-permission" class="activity-section" hidden>
      <div class="activity-section-head">
        <span class="activity-section-title">Permission</span>
        <span id="permission-nav" class="permission-nav" hidden>
          <button id="permission-prev">‹</button>
          <span id="permission-counter">1/1</span>
          <button id="permission-next">›</button>
        </span>
      </div>
      <p id="permission-text">Allow tool?</p>
      <p id="permission-hint">The agent is waiting for your decision.</p>
      <div id="permission-actions"></div>
    </div>
    <div id="activity-tools" class="activity-section" hidden>
      <div class="activity-section-title">Activity</div>
      <div id="tool-list"></div>
    </div>
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
    getCustomModes: vi.fn(async () => []),
    listSkills: vi.fn(async () => []),
    findFiles: vi.fn(async () => ({ entries: [] })),
    setConfigOption: vi.fn(async () => {}),
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
  | { kind: "user"; text: string }
  | {
      kind: "commands";
      commands: Array<{ name: string; description: string; input?: string }>;
    }
  | {
      kind: "config";
      options: Array<{
        id: string;
        name: string;
        category?: string;
        type: string;
        currentValue: string | boolean | null;
        options?: Array<{ value: string; name: string }>;
      }>;
    };

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
    const toolList = el("tool-list");
    expect(toolList.querySelector(".tool-entry")).not.toBeNull();
    expect(el("chat-list").querySelector(".msg-tool")).toBeNull();

    fire("chatFrame", {
      frame: { kind: "tool_update", update: { toolCallId: "t1", title: "grep", status: "completed" } },
    });
    expect(toolList.querySelector(".tool-entry")?.classList.contains("done")).toBe(true);

    const head = toolList.querySelector(".tool-head") as HTMLElement | null;
    expect(head).not.toBeNull();
    head!.click();
    const entry = toolList.querySelector(".tool-entry") as HTMLElement;
    expect(entry.classList.contains("expanded")).toBe(true);

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

    expect(stub.api.prompt).toHaveBeenCalledWith("next step", []);
    expect(el("chat-list").querySelector(".msg-user")?.textContent).toBe("next step");
    expect(el("chat-send").getAttribute("disabled")).not.toBeNull();

    fire("chatFrame", { frame: { kind: "turn", stopReason: "end_turn" } });
    expect(el("chat-send").getAttribute("disabled")).toBeNull();
  });

  it("queues permission requests in the activity box and navigates the queue", async () => {
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

    expect(el("activity-box").hidden).toBe(false);
    expect(el("permission-text").textContent).toContain("Run tests");
    expect(el("permission-actions").querySelectorAll("button").length).toBe(2);
    // Single pending request: no need for navigation.
    expect(el("permission-nav").hidden).toBe(true);

    fire("permission", request("req-2"));
    expect(el("permission-nav").hidden).toBe(false);
    expect(el("permission-counter").textContent).toBe("1/2");

    // Navigate to the second request, then back to the first.
    (el("permission-next") as HTMLButtonElement).click();
    expect(el("permission-counter").textContent).toBe("2/2");
    (el("permission-prev") as HTMLButtonElement).click();
    expect(el("permission-counter").textContent).toBe("1/2");

    const allowBtn = el("permission-actions").querySelector("button") as HTMLButtonElement;
    allowBtn.click();
    expect(stub.calls.answerPermission[0]).toEqual(["req-1", "allow_once"]);

    // The answered request left the queue; the box stays open for req-2.
    expect(el("activity-box").hidden).toBe(false);
    expect(el("permission-counter").textContent).toBe("1/1");
    expect(el("permission-nav").hidden).toBe(true);
    expect(el("permission-actions").querySelectorAll("button").length).toBe(2);
  });

  it("hides the activity box when a chat reset clears permissions and tools", async () => {
    await loadRenderer();
    fire("status", { type: "spawned", pid: 1, adapter: "opencode", mode: "acp" });

    fire("permission", {
      requestId: "req-1",
      toolCall: { toolCallId: "t1", title: "Run tests", name: "bash" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow once" }],
    });
    fire("chatFrame", { frame: { kind: "tool", call: { toolCallId: "t1", title: "grep" } } });
    expect(el("activity-box").hidden).toBe(false);

    fire("chatReset", {});
    expect(el("activity-box").hidden).toBe(true);
    expect(el("tool-list").querySelectorAll(".tool-entry")).toHaveLength(0);
  });

  it("cycles composer modes with Tab (normal -> workflow -> normal when no custom modes)", async () => {
    await loadRenderer();
    fire("status", { type: "spawned", pid: 1, adapter: "opencode", mode: "acp" });
    const input = el("chat-input") as HTMLInputElement;
    const badge = el("chat-mode");

    expect(badge.textContent).toBe("normal");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(badge.textContent).toBe("workflow · guide");
    expect(badge.classList.contains("active")).toBe(true);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(badge.textContent).toBe("normal");
    expect(badge.classList.contains("active")).toBe(false);
  });

  it("prepends the workflow guide to prompts sent in workflow mode", async () => {
    await loadRenderer();
    fire("status", { type: "spawned", pid: 1, adapter: "opencode", mode: "acp" });
    const input = el("chat-input") as HTMLInputElement;

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    input.value = "do it";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    expect(stub.api.prompt).toHaveBeenCalledWith(`${GUIDE_TEXT.trim()}\n\ndo it`, []);
    // The user bubble shows only the typed text, not the injected guide.
    expect(el("chat-list").querySelector(".msg-user")?.textContent).toBe("do it");
  });

  it("cycles through a custom ~/.orc/modes instruction and prepends it", async () => {
    await loadRenderer();
    stub.api.getCustomModes = vi.fn(async () => [
      { name: "security-review", content: "Prioritize security." },
    ]);
    fire("status", { type: "spawned", pid: 1, adapter: "opencode", mode: "acp" });
    await vi.advanceTimersByTimeAsync(1);
    const input = el("chat-input") as HTMLInputElement;
    const badge = el("chat-mode");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(badge.textContent).toBe("workflow · guide");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(badge.textContent).toBe("custom · security-review");
    expect(badge.classList.contains("active")).toBe(true);

    input.value = "review this diff";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(stub.api.prompt).toHaveBeenCalledWith("Prioritize security.\n\nreview this diff", []);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(badge.textContent).toBe("normal");
  });

  it("sends a leading-slash line as plain text on the ACP prompt path", async () => {
    await loadRenderer();
    fire("status", { type: "spawned", pid: 1, adapter: "opencode", mode: "acp" });
    const input = el("chat-input") as HTMLInputElement;

    input.value = "/compact";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(stub.api.prompt).toHaveBeenCalledWith("/compact", []);

    fire("chatFrame", { frame: { kind: "turn", stopReason: "end_turn" } });
  });

  it("expands @-directory mentions and completes @-file mentions on submit", async () => {
    await loadRenderer();
    fire("status", { type: "spawned", pid: 1, adapter: "opencode", mode: "acp" });
    const findFiles = stub.api.findFiles as ReturnType<typeof vi.fn>;
    findFiles.mockResolvedValueOnce({
      entries: [
        { name: "cli", path: "src/cli", absolute: "src/cli", type: "directory" },
        { name: "core", path: "src/core", absolute: "src/core", type: "directory" },
      ],
    });
    findFiles.mockResolvedValueOnce({
      dir: "src/core",
      entries: [
        { name: "types.ts", path: "types.ts", absolute: "src/core/types.ts", type: "file" },
        { name: "schemas.ts", path: "schemas.ts", absolute: "src/core/schemas.ts", type: "file" },
      ],
    });
    const input = el("chat-input") as HTMLInputElement;
    const sugg = el("chat-suggestions");

    input.value = "check @src/";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(1);
    expect(findFiles).toHaveBeenCalledWith("src/");
    expect(Array.from(sugg.querySelectorAll(".sugg-name")).map((s) => s.textContent)).toEqual(["cli", "core"]);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(input.value).toBe("check @src/core/");
    await vi.advanceTimersByTimeAsync(1);
    expect(findFiles).toHaveBeenCalledWith("src/core/");
    expect(Array.from(sugg.querySelectorAll(".sugg-name")).map((s) => s.textContent)).toEqual([
      "types.ts",
      "schemas.ts",
    ]);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(input.value).toBe("check @src/core/types.ts");

    (el("chat-send") as HTMLButtonElement).click();
    expect(stub.api.prompt).toHaveBeenCalledWith("check", [{ path: "src/core/types.ts" }]);
  });

  it("lists advertised agent commands under a leading slash and picks one", async () => {
    await loadRenderer();
    fire("status", { type: "spawned", pid: 1, adapter: "opencode", mode: "acp" });
    fire("chatFrame", {
      frame: {
        kind: "commands",
        commands: [
          { name: "compact", description: "Compact conversation history" },
          { name: "help", description: "List available commands" },
        ],
      },
    });
    const input = el("chat-input") as HTMLInputElement;
    const sugg = el("chat-suggestions");

    input.value = "/";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(1);
    // Both commands are builtins → a single `cmd` group → flat list (no drill).
    expect(Array.from(sugg.querySelectorAll(".sugg-name")).map((s) => s.textContent)).toEqual([
      "/compact",
      "/help",
    ]);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(input.value).toBe("/help ");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(stub.api.prompt).toHaveBeenCalledWith("/help", []);
  });

  it("groups slash commands into cmd / skill / other and drills into a group", async () => {
    await loadRenderer();
    (stub.api.listSkills as ReturnType<typeof vi.fn>).mockResolvedValue(["cavecrew", "docx"]);
    fire("status", { type: "spawned", pid: 1, adapter: "opencode", mode: "acp" });
    fire("chatFrame", {
      frame: {
        kind: "commands",
        commands: [
          { name: "compact", description: "Compact history" },
          { name: "cavecrew", description: "Decision guide for subagents" },
          { name: "docx", description: "Word documents" },
          { name: "my-macro", description: "A personal config command" },
        ],
      },
    });
    await vi.advanceTimersByTimeAsync(1);
    const input = el("chat-input") as HTMLInputElement;
    const sugg = el("chat-suggestions");

    input.value = "/";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(1);
    // A real mix → group rows first (counts in the description).
    expect(Array.from(sugg.querySelectorAll(".sugg-name")).map((s) => s.textContent)).toEqual([
      "cmd",
      "skill",
      "other",
    ]);
    expect(Array.from(sugg.querySelectorAll(".sugg-desc")).map((s) => s.textContent)).toEqual([
      "1 command",
      "2 commands",
      "1 command",
    ]);

    // Drill into `skill`: back row + the skill commands.
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(Array.from(sugg.querySelectorAll(".sugg-name")).map((s) => s.textContent)).toEqual([
      "‹ all groups",
      "/cavecrew",
      "/docx",
    ]);

    // Pick a skill command.
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(input.value).toBe("/cavecrew ");
    expect(stub.api.prompt).not.toHaveBeenCalled();

    // Re-open `/`: picking a command reset the drill level → groups again.
    input.value = "/";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(1);
    expect(Array.from(sugg.querySelectorAll(".sugg-name")).map((s) => s.textContent)).toEqual([
      "cmd",
      "skill",
      "other",
    ]);

    // Drill in again; Escape pops back to the group list (doesn't close).
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(Array.from(sugg.querySelectorAll(".sugg-name")).map((s) => s.textContent)).toEqual([
      "cmd",
      "skill",
      "other",
    ]);
    expect(sugg.classList.contains("visible")).toBe(true);

    // Escape on the group list closes the popover.
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(sugg.classList.contains("visible")).toBe(false);
  });

  it("filters commands by prefix and keeps Enter submitting on an empty list", async () => {
    await loadRenderer();
    fire("status", { type: "spawned", pid: 1, adapter: "opencode", mode: "acp" });
    fire("chatFrame", {
      frame: { kind: "commands", commands: [{ name: "compact", description: "Compact history" }] },
    });
    const input = el("chat-input") as HTMLInputElement;
    const sugg = el("chat-suggestions");

    input.value = "/mod";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(1);
    expect(sugg.textContent).toContain("No commands available");

    // Non-interactive empty state: Enter still submits the raw line.
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(stub.api.prompt).toHaveBeenCalledWith("/mod", []);
    expect(el("chat-list").querySelector(".msg-user")?.textContent).toBe("/mod");
  });

  it("never prepends the workflow guide to a leading-slash line", async () => {
    await loadRenderer();
    fire("status", { type: "spawned", pid: 1, adapter: "opencode", mode: "acp" });
    const input = el("chat-input") as HTMLInputElement;

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(el("chat-mode").textContent).toBe("workflow · guide");
    input.value = "/compact";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(stub.api.prompt).toHaveBeenCalledWith("/compact", []);
  });

  it("shows the current model from a config frame and switches via setConfigOption", async () => {
    await loadRenderer();
    fire("status", { type: "spawned", pid: 1, adapter: "opencode", mode: "acp" });
    const badge = el("chat-model");
    expect(badge.hidden).toBe(true);

    fire("chatFrame", {
      frame: {
        kind: "config",
        options: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "mini",
            options: [
              { value: "mini", name: "opencode mini" },
              { value: "full", name: "opencode" },
            ],
          },
        ],
      },
    });
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe("opencode mini");

    badge.click();
    const menu = el("chat-model-menu");
    expect(menu.classList.contains("visible")).toBe(true);
    expect(Array.from(menu.querySelectorAll(".model-opt")).map((o) => o.textContent)).toEqual([
      "opencode mini",
      "opencode",
    ]);

    (menu.querySelectorAll(".model-opt")[1] as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(1);
    expect(stub.api.setConfigOption).toHaveBeenCalledWith("model", "full");
    expect(badge.textContent).toBe("opencode");
    expect(menu.classList.contains("visible")).toBe(false);
  });

  it("reverts the model badge when the switch round-trip fails", async () => {
    await loadRenderer();
    fire("status", { type: "spawned", pid: 1, adapter: "opencode", mode: "acp" });
    (stub.api.setConfigOption as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("rejected"));
    fire("chatFrame", {
      frame: {
        kind: "config",
        options: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "mini",
            options: [{ value: "mini", name: "opencode mini" }],
          },
        ],
      },
    });
    const badge = el("chat-model");
    badge.click();
    (el("chat-model-menu").querySelector(".model-opt") as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(1);
    expect(badge.textContent).toBe("opencode mini");
    expect(el("event-list").textContent).toContain("Model switch failed");
  });

  it("hides the model badge when the agent advertises no model option", async () => {
    await loadRenderer();
    fire("status", { type: "spawned", pid: 1, adapter: "opencode", mode: "acp" });
    fire("chatFrame", {
      frame: {
        kind: "config",
        options: [{ id: "verbose", name: "Verbose", type: "boolean", currentValue: true }],
      },
    });
    expect(el("chat-model").hidden).toBe(true);
  });
});