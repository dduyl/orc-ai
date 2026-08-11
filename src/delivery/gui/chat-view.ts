import type { AgentUsage, AcpStopReason } from "../../application/agents/acp/types.js";

/** Structural subset of the ACP tool-call envelope the DOM panel consumes. */
export interface ToolCallView {
  toolCallId: string;
  title?: string | null;
  name?: string | null;
}

export interface ToolCallUpdateView extends ToolCallView {
  status?: string | null;
}

/**
 * DOM chat panel for the ACP main session.
 *
 * The renderer composes user prompts and structured ACP frames (from the daemon
 * bridge) into a chronological conversation:
 *
 * - user prompts render as right-aligned mono bubbles;
 * - agent text streams into an open "caret" message (a contiguous run closes on
 *   the first tool / usage / turn / error frame, so chips interleave honestly);
 * - each tool call renders as one inset chip whose title/status live-update as
 *   `tool_call_update` frames arrive;
 * - usage lines, turn dividers, and errors are scannable single-line tokens.
 */
export class ChatView {
  private openText: { msg: HTMLElement; body: HTMLElement } | null = null;
  private lastToolEl: HTMLElement | null = null;
  private turnSeq = 0;

  constructor(private readonly list: HTMLElement) {}

  clear(): void {
    this.list.innerHTML = "";
    this.openText = null;
    this.lastToolEl = null;
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

  addTool(call: ToolCallView): void {
    this.closeText();
    this.ensureEmptyRemoved();
    const name = call.title ?? "tool";
    const chip = this.makeChip(name);
    chip.dataset.toolCallId = call.toolCallId;
    this.lastToolEl = chip;
    this.append(chip);
  }

  addToolUpdate(update: ToolCallUpdateView): void {
    this.closeText();
    this.ensureEmptyRemoved();
    // Coalesce updates into the live chip for the same tool call.
    const existing =
      this.lastToolEl && this.lastToolEl.dataset.toolCallId === update.toolCallId
        ? (this.lastToolEl as HTMLElement)
        : null;
    const chip = existing ?? this.makeChip(update.title ?? update.name ?? "tool");
    if (update.title || update.name) {
      const titleEl = chip.querySelector(".tool-title");
      if (titleEl) titleEl.textContent = update.title ?? update.name ?? "tool";
    }
    if (update.status) {
      const statusEl = chip.querySelector(".tool-status") as HTMLElement | null;
      if (statusEl) {
        statusEl.textContent = statusLabel(update.status);
        statusEl.dataset.status = update.status;
      }
      if (update.status === "completed" || update.status === "failed") {
        chip.classList.add("done");
      }
    }
    chip.dataset.toolCallId = update.toolCallId;
    this.lastToolEl = chip;
    if (!existing) this.append(chip);
  }

  addUsage(usage: AgentUsage): void {
    this.closeText();
    const el = document.createElement("div");
    el.className = "msg-usage";
    el.textContent = `tokens ${usage.totalTokens} · in ${usage.inputTokens} · out ${usage.outputTokens}`;
    this.append(el);
  }

  addTurn(stopReason: AcpStopReason): void {
    this.closeText();
    this.turnSeq += 1;
    const el = document.createElement("div");
    el.className = "turn-end";
    const label = turnLabel(stopReason);
    el.innerHTML = `<span>end turn</span><b>${label}</b><span></span>`;
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
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
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

  private makeChip(name: string): HTMLElement {
    const chip = document.createElement("div");
    chip.className = "msg msg-tool";
    chip.innerHTML =
      `<span class="tool-kind">tool</span>` +
      `<span class="tool-title">${escapeHtml(name)}</span>` +
      `<span class="tool-status" data-status="pending">···</span>`;
    return chip;
  }

  private append(el: HTMLElement): void {
    this.ensureEmptyRemoved();
    this.list.appendChild(el);
    this.scrollBottom();
  }
}

/** Small safe injection guard — names/titles come from the agent. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function statusLabel(status: string | null | undefined): string {
  switch (status) {
    case "pending": return "···";
    case "in_progress": return "running…";
    case "completed": return "done";
    case "failed": return "failed";
    default: return "···";
  }
}

function turnLabel(reason: AcpStopReason): string {
  switch (reason) {
    case "end_turn": return "complete";
    case "cancelled": return "cancelled";
    case "refusal": return "refused";
    case "max_tokens": return "max tokens";
    case "max_turn_requests": return "request limit";
    default: return reason;
  }
}