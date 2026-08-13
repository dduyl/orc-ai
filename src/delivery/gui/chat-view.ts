import type { AgentUsage, AcpStopReason } from "../../application/agents/acp/types.js";

/**
 * DOM chat panel for the ACP main session.
 *
 * The renderer composes user prompts and structured ACP frames (from the daemon
 * bridge) into a chronological conversation:
 *
 * - user prompts render as right-aligned mono bubbles;
 * - agent text streams into an open "caret" message (a contiguous run closes on
 *   the first usage / turn / error frame);
 * - usage lines, turn dividers, and errors are scannable single-line tokens.
 *
 * Tool calls are NOT rendered here — they live in the floating activity box
 * (see `activity-box.ts`), which owns click-to-expand result rows.
 */
export class ChatView {
  /** Pixels above the bottom below which auto-scroll stays engaged. */
  static readonly SCROLL_THRESHOLD = 80;

  private openText: { msg: HTMLElement; body: HTMLElement } | null = null;
  private turnSeq = 0;

  constructor(private readonly list: HTMLElement) {}

  clear(): void {
    this.list.innerHTML = "";
    this.openText = null;
    this.turnSeq = 0;
    const empty = document.createElement("div");
    empty.className = "chat-empty";
    empty.innerHTML =
      '<div>Waiting for a message…</div>' +
      '<div class="kbd">Chat runs over ACP · Synced with the ORC daemon</div>';
    this.list.appendChild(empty);
  }

  addUser(text: string): void {
    this.closeText();
    const el = document.createElement("div");
    el.className = "msg msg-user";
    el.textContent = text;
    this.append(el);
  }

  addText(text: string): void {
    this.ensureEmptyRemoved();
    if (!this.openText) {
      const msg = document.createElement("div");
      msg.className = "msg msg-agent streaming";
      const caret = document.createElement("div");
      caret.className = "agent-caret streaming";
      const pip = document.createElement("span");
      pip.className = "pip";
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = `agent · turn ${this.turnSeq + 1}`;
      caret.append(pip, who);
      const body = document.createElement("div");
      body.className = "msg-body";
      msg.append(caret, body);
      this.openText = { msg, body };
      this.list.appendChild(msg);
    }
    this.openText.body.textContent += text;
    this.scrollBottom();
  }

  addUsage(usage: AgentUsage): void {
    this.closeText();
    const el = document.createElement("div");
    el.className = "msg-usage";
    el.textContent = `tokens ${usage.totalTokens} · in ${usage.inputTokens} · out ${usage.outputTokens}`;
    this.append(el);
  }

  addTurn(stopReason: AcpStopReason | "error"): void {
    this.closeText();
    this.turnSeq += 1;
    const el = document.createElement("div");
    el.className = "turn-end";
    const left = document.createElement("span");
    left.textContent = "end turn";
    const label = document.createElement("b");
    label.textContent = turnLabel(stopReason);
    const right = document.createElement("span");
    el.append(left, label, right);
    this.append(el);
  }

  addError(message: string): void {
    this.closeText();
    const el = document.createElement("div");
    el.className = "msg msg-error";
    el.textContent = `error · ${message}`;
    this.append(el);
  }

  scrollBottom(): void {
    const scroll = this.list.parentElement;
    if (!scroll) return;
    const nearBottom =
      scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < ChatView.SCROLL_THRESHOLD;
    if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private closeText(): void {
    if (!this.openText) return;
    this.openText.msg.classList.remove("streaming");
    const caret = this.openText.msg.querySelector(".agent-caret");
    caret?.classList.remove("streaming");
    this.openText = null;
  }

  private ensureEmptyRemoved(): void {
    const empty = this.list.querySelector(".chat-empty");
    if (empty) empty.remove();
  }

  private append(el: HTMLElement): void {
    this.ensureEmptyRemoved();
    this.list.appendChild(el);
    this.scrollBottom();
  }
}

function turnLabel(reason: AcpStopReason | "error"): string {
  switch (reason) {
    case "end_turn": return "complete";
    case "cancelled": return "cancelled";
    case "refusal": return "refused";
    case "max_tokens": return "max tokens";
    case "max_turn_requests": return "request limit";
    case "error": return "error";
    default: return reason;
  }
}