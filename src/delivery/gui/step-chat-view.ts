import type { AgentUsage } from "../../application/agents/acp/types.js";
import type { ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { StepFrame } from "./ipc.js";

/**
 * DOM chat panel for per-step agent conversations.
 *
 * When a step is selected in the steps list, this view shows the structured
 * conversation for that step — tool calls, text output, usage, and errors.
 * Reuses CSS classes from the main `ChatView`.
 */
export class StepChatView {
  static readonly SCROLL_THRESHOLD = 80;

  private list: HTMLElement;
  private scrollEl: HTMLElement;

  constructor(list: HTMLElement, scrollEl?: HTMLElement) {
    this.list = list;
    this.scrollEl = scrollEl ?? list.parentElement as HTMLElement;
  }

  clear(): void {
    this.list.innerHTML = "";
  }

  addToolCall(call: ToolCall): void {
    const el = document.createElement("div");
    el.className = "tool-entry";
    const name = document.createElement("span");
    name.className = "tool-name";
    name.textContent = `⚙ ${call.name ?? "unknown"}`;
    const input = document.createElement("span");
    input.className = "tool-input";
    input.textContent = typeof call.rawInput === "string"
      ? call.rawInput
      : JSON.stringify(call.rawInput ?? {});
    el.append(name, input);
    this.append(el);
  }

  addToolUpdate(update: ToolCallUpdate): void {
    if (!update.toolCallId) return;
    const el = document.createElement("div");
    el.className = "tool-entry tool-update";
    el.dataset.toolCallId = update.toolCallId;
    const status = document.createElement("span");
    status.className = "tool-status";
    if (update.status === "completed") {
      status.textContent = "✓ completed";
      status.style.color = "#4ade80";
    } else if (update.status === "in_progress") {
      status.textContent = "⏳ running";
      status.style.color = "#facc15";
    } else {
      status.textContent = "✗ failed";
      status.style.color = "#f87171";
    }
    if (update.rawOutput) {
      const output = document.createElement("span");
      output.className = "tool-output";
      output.textContent = typeof update.rawOutput === "string"
        ? update.rawOutput.slice(0, 200)
        : JSON.stringify(update.rawOutput).slice(0, 200);
      el.append(status, output);
    } else {
      el.append(status);
    }
    this.append(el);
  }

  addText(text: string): void {
    const el = document.createElement("div");
    el.className = "msg msg-agent";
    el.textContent = text;
    this.append(el);
  }

  /** Append a streaming text chunk to the current agent message bubble. */
  addTextChunk(chunk: string): void {
    let last = this.list.lastElementChild as HTMLElement | null;
    if (!last || !last.classList.contains("msg-agent-streaming")) {
      last = document.createElement("div");
      last.className = "msg msg-agent msg-agent-streaming";
      this.list.appendChild(last);
    }
    last.textContent += chunk;
    this.scrollBottom();
  }

  addUsage(usage: AgentUsage): void {
    const el = document.createElement("div");
    el.className = "msg-usage";
    el.textContent = `tokens ${usage.totalTokens} · in ${usage.inputTokens} · out ${usage.outputTokens}`;
    this.append(el);
  }

  addTurn(stopReason: string): void {
    const el = document.createElement("div");
    el.className = "turn-end";
    const left = document.createElement("span");
    left.textContent = "end turn";
    const label = document.createElement("b");
    label.textContent = stopReason;
    const right = document.createElement("span");
    el.append(left, label, right);
    this.append(el);
  }

  addError(message: string): void {
    const el = document.createElement("div");
    el.className = "msg msg-error";
    el.textContent = `error · ${message}`;
    this.append(el);
  }

  /**
   * Render a structured error frame with kind-specific details.
   * Handles quota (reset countdown), rate-limit (retry-after), auth, and connection errors.
   */
  addErrorFrame(frame: StepFrame): void {
    const el = document.createElement("div");
    el.className = "msg msg-error";

    const kind = frame.errorKind ?? "unknown";
    const msg = frame.error ?? "Unknown error";

    // Header: error kind badge + message
    const header = document.createElement("div");
    header.className = "error-header";
    const badge = document.createElement("span");
    badge.className = "error-kind";
    badge.textContent = kind.toUpperCase();
    header.appendChild(badge);
    const text = document.createElement("span");
    text.textContent = msg;
    header.appendChild(text);
    el.appendChild(header);

    // Kind-specific detail lines
    if (kind === "quota" && frame.resetAtMs) {
      const resetSec = Math.max(0, Math.round((frame.resetAtMs - Date.now()) / 1000));
      const detail = document.createElement("div");
      detail.className = "error-detail";
      detail.textContent = `Resets in ${resetSec}s`;
      el.appendChild(detail);
    } else if (kind === "rate_limit" && frame.retryAfterMs) {
      const detail = document.createElement("div");
      detail.className = "error-detail";
      detail.textContent = `Retry after ${Math.round(frame.retryAfterMs / 1000)}s`;
      el.appendChild(detail);
    }

    if (frame.providerCode) {
      const detail = document.createElement("div");
      detail.className = "error-detail";
      detail.textContent = `Provider code: ${frame.providerCode}`;
      el.appendChild(detail);
    }

    this.append(el);
  }

  scrollBottom(): void {
    const scroll = this.scrollEl;
    if (!scroll) return;
    const nearBottom =
      scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < StepChatView.SCROLL_THRESHOLD;
    if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
  }

  private append(el: HTMLElement): void {
    this.list.appendChild(el);
    this.scrollBottom();
  }
}
