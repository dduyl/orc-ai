// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ChatView } from "../../../delivery/gui/chat-view.js";

/** A bare list element; `scrollBottom` early-returns when it has no parent. */
function makeList(): HTMLElement {
  return document.createElement("div");
}

function text(el: Element | null, sel: string): string | null {
  return el?.querySelector(sel)?.textContent ?? null;
}

describe("ChatView", () => {
  it("clear() resets to the empty placeholder", () => {
    const list = makeList();
    const chat = new ChatView(list);
    chat.addUser("hello");
    chat.clear();
    expect(list.querySelectorAll(".chat-empty")).toHaveLength(1);
    expect(list.querySelectorAll(".msg")).toHaveLength(0);
  });

  it("addUser renders a right-aligned user bubble and closes open text", () => {
    const list = makeList();
    const chat = new ChatView(list);
    chat.addText("agent streaming…");
    chat.addUser("my message");
    expect(list.querySelector(".msg-user")?.textContent).toBe("my message");
    expect(list.querySelectorAll(".msg-agent")).toHaveLength(1);
    expect(list.querySelector(".msg-agent")?.classList.contains("streaming")).toBe(false);
  });

  it("addText streams into one open message until a non-text frame closes it", () => {
    const list = makeList();
    const chat = new ChatView(list);
    chat.addText("one ");
    chat.addText("two ");
    chat.addText("three");
    const agents = list.querySelectorAll(".msg-agent.streaming");
    expect(agents).toHaveLength(1);
    expect(agents[0].querySelector(".msg-body")?.textContent).toBe("one two three");
    expect(text(agents[0], ".who")).toContain("turn 1");

    chat.addUsage({ totalTokens: 5, inputTokens: 2, outputTokens: 3 });
    expect(list.querySelector(".msg-agent")?.classList.contains("streaming")).toBe(false);
  });

  it("addUsage renders the token summary line", () => {
    const list = makeList();
    const chat = new ChatView(list);
    chat.addUsage({ totalTokens: 100, inputTokens: 40, outputTokens: 60 });
    expect(text(list, ".msg-usage")).toBe("tokens 100 · in 40 · out 60");
  });

  it("addTurn closes the stream and renders the stop-reason label, bumping turn count", () => {
    const list = makeList();
    const chat = new ChatView(list);
    chat.addText("done");
    chat.addTurn("end_turn");
    expect(text(list, ".turn-end b")).toBe("complete");
    expect(list.querySelector(".msg-agent")?.classList.contains("streaming")).toBe(false);

    chat.addText("next");
    const who = list.querySelectorAll(".who");
    expect(who[who.length - 1]?.textContent).toContain("turn 2");
    chat.addTurn("error");
    const ends = list.querySelectorAll(".turn-end b");
    expect(ends[ends.length - 1]?.textContent).toBe("error");
  });

  it("addError renders an error bubble", () => {
    const list = makeList();
    const chat = new ChatView(list);
    chat.addError("boom");
    expect(list.querySelector(".msg-error")?.textContent).toBe("error · boom");
  });
});
