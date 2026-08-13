// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ActivityBox, type ActivityBoxRefs } from "../../../delivery/gui/activity-box.js";
import type { PermissionRequest } from "../../../delivery/gui/ipc.js";
import type { PermissionAnswerKind } from "../../../application/agents/acp/types.js";

const DOM = `
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
`;

function setup(): { box: ActivityBox; answers: Array<[string, PermissionAnswerKind]> } {
  document.body.innerHTML = DOM;
  const answers: Array<[string, PermissionAnswerKind]> = [];
  const refs: ActivityBoxRefs = {
    box: el("activity-box"),
    permissionSection: el("activity-permission"),
    permissionText: el("permission-text"),
    permissionHint: el("permission-hint"),
    permissionActions: el("permission-actions"),
    permissionNav: el("permission-nav"),
    permissionPrev: el("permission-prev") as HTMLButtonElement,
    permissionNext: el("permission-next") as HTMLButtonElement,
    permissionCounter: el("permission-counter"),
    toolsSection: el("activity-tools"),
    toolList: el("tool-list"),
    onAnswer: (requestId, kind) => answers.push([requestId, kind]),
  };
  return { box: new ActivityBox(refs), answers };
}

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

function request(requestId: string, title = "Run tests"): PermissionRequest {
  return {
    requestId,
    toolCall: { toolCallId: "t1", title, name: "bash" },
    options: [
      { optionId: "allow", kind: "allow_once", name: "Allow once" },
      { optionId: "reject", kind: "reject_once", name: "Reject" },
    ],
  };
}

describe("ActivityBox permissions", () => {
  it("shows the box and renders the first request; nav hidden for a single request", () => {
    const { box } = setup();
    box.addPermission(request("req-1"));
    expect(el("activity-box").hidden).toBe(false);
    expect(el("permission-text").textContent).toContain("Run tests");
    expect(el("permission-actions").querySelectorAll("button").length).toBe(2);
    expect(el("permission-nav").hidden).toBe(true);
    expect(box.hasPending()).toBe(true);
  });

  it("navigates a queue with prev/next and clamps at the ends", () => {
    const { box } = setup();
    box.addPermission(request("req-1", "First"));
    box.addPermission(request("req-2", "Second"));
    box.addPermission(request("req-3", "Third"));
    expect(el("permission-counter").textContent).toBe("1/3");
    expect(el("permission-text").textContent).toContain("First");

    el("permission-next").click();
    expect(el("permission-text").textContent).toContain("Second");
    el("permission-next").click();
    expect(el("permission-text").textContent).toContain("Third");
    // Past the end stays on the last.
    el("permission-next").click();
    expect(el("permission-counter").textContent).toBe("3/3");

    el("permission-prev").click();
    el("permission-prev").click();
    el("permission-prev").click();
    expect(el("permission-counter").textContent).toBe("1/3");
    expect(el("permission-text").textContent).toContain("First");
  });

  it("answers the displayed request by requestId and removes it from the queue", () => {
    const { box, answers } = setup();
    box.addPermission(request("req-1"));
    box.addPermission(request("req-2"));

    (el("permission-actions").querySelector("button") as HTMLButtonElement).click();
    expect(answers).toEqual([["req-1", "allow_once"]]);

    // req-2 remains displayed, navigation collapses back to a single request.
    expect(box.hasPending()).toBe(true);
    expect(el("permission-counter").textContent).toBe("1/1");
    expect(el("permission-nav").hidden).toBe(true);
    expect(el("permission-text").textContent).toContain("Run tests");
  });

  it("hides the permission section and box once the queue is drained", () => {
    const { box, answers } = setup();
    box.addPermission(request("req-1"));
    (el("permission-actions").querySelector("button") as HTMLButtonElement).click();
    expect(answers).toHaveLength(1);
    expect(el("activity-permission").hidden).toBe(true);
    expect(el("activity-box").hidden).toBe(true);
    expect(box.hasPending()).toBe(false);
  });
});

describe("ActivityBox tools", () => {
  it("renders a tool entry, exposes it, and expands on click with text content", () => {
    const { box } = setup();
    box.addTool({ toolCallId: "t1", title: "grep", name: "grep" });
    box.addToolUpdate({
      toolCallId: "t1",
      title: "grep",
      kind: "search",
      status: "completed",
      locations: [{ path: "C:/work/src/a.ts", line: 12 }],
      content: [{ type: "content", content: { type: "text", text: "match found" } }],
      rawOutput: { ok: true },
    });

    const entry = el("tool-list").querySelector(".tool-entry") as HTMLElement;
    expect(entry).not.toBeNull();
    expect(entry.classList.contains("done")).toBe(true);
    expect((entry.querySelector(".tool-title") as HTMLElement).textContent).toBe("grep");
    expect((entry.querySelector(".tool-kind") as HTMLElement).textContent).toBe("search");

    (entry.querySelector(".tool-head") as HTMLElement).click();
    expect(entry.classList.contains("expanded")).toBe(true);
    const result = entry.querySelector(".tool-result") as HTMLElement;
    expect(result.textContent).toContain("at C:/work/src/a.ts:12");
    expect(result.textContent).toContain("match found");
    expect(result.textContent).toContain('"ok": true');

    // Clicking again collapses.
    (entry.querySelector(".tool-head") as HTMLElement).click();
    expect(entry.classList.contains("expanded")).toBe(false);
  });

  it("merges updates into one entry and renders diff + image blocks", () => {
    const { box } = setup();
    box.addTool({ toolCallId: "t1", title: "edit" });
    box.addToolUpdate({
      toolCallId: "t1",
      title: "edit",
      status: "in_progress",
      content: [{ type: "diff", path: "src/a.ts", oldText: "old", newText: "new body\nsecond" }],
    });
    box.addToolUpdate({
      toolCallId: "t1",
      status: "completed",
      content: [
        { type: "diff", path: "src/a.ts", oldText: "old", newText: "new body\nsecond" },
        { type: "content", content: { type: "image", data: "AA==", mimeType: "image/png" } },
      ],
    });

    const entries = el("tool-list").querySelectorAll(".tool-entry");
    expect(entries).toHaveLength(1);
    (entries[0].querySelector(".tool-head") as HTMLElement).click();
    const result = entries[0].querySelector(".tool-result") as HTMLElement;
    expect(result.textContent).toContain("diff: src/a.ts (1 → 2 lines)");
    expect(result.textContent).toContain("new body");
    expect(result.textContent).toContain("[image: image/png]");
  });

  it("truncates oversized result text", () => {
    const { box } = setup();
    const long = "x".repeat(5000);
    box.addTool({ toolCallId: "t1", title: "big" });
    box.addToolUpdate({
      toolCallId: "t1",
      content: [{ type: "content", content: { type: "text", text: long } }],
    });
    (el("tool-list").querySelector(".tool-head") as HTMLElement).click();
    const result = el("tool-list").querySelector(".tool-result") as HTMLElement;
    expect(result.textContent).toContain("… (truncated)");
    expect(result.textContent!.length).toBeLessThan(4200);
  });

  it("shows a placeholder when a completed tool has no result content", () => {
    const { box } = setup();
    box.addTool({ toolCallId: "t1", title: "noop" });
    box.addToolUpdate({ toolCallId: "t1", status: "completed" });
    (el("tool-list").querySelector(".tool-head") as HTMLElement).click();
    const result = el("tool-list").querySelector(".tool-result") as HTMLElement;
    expect(result.textContent).toContain("no result content");
  });

  it("clear() empties tools and hides the box", () => {
    const { box } = setup();
    box.addTool({ toolCallId: "t1", title: "grep" });
    box.addPermission(request("req-1"));
    box.clear();
    expect(el("tool-list").querySelectorAll(".tool-entry")).toHaveLength(0);
    expect(el("activity-permission").hidden).toBe(true);
    expect(el("activity-box").hidden).toBe(true);
  });

  it("drains the queue sequentially, always answering the displayed request", () => {
    const { box, answers } = setup();
    box.addPermission(request("req-1"));
    box.addPermission(request("req-2"));
    (el("permission-actions").querySelector("button") as HTMLButtonElement).click();
    (el("permission-actions").querySelector("button") as HTMLButtonElement).click();
    expect(answers).toEqual([
      ["req-1", "allow_once"],
      ["req-2", "allow_once"],
    ]);
    expect(el("activity-box").hidden).toBe(true);
  });
});
